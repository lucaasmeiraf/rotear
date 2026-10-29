import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app import config
from app.db import SessionLocal, engine
from app.geocodificacao.servico import limpar_cache
from app.deps import NaoAutenticado, SemPermissao
from app.rotas import admin, auth, geocodificacao, paginas, planejamento
from app.templating import templates

# Nunca registrar URLs de consultas externas (contêm endereços)
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("rotear")


def _limpar_cache_geo() -> None:
    with SessionLocal() as db:
        apagados = limpar_cache(db)
    if apagados:
        log.warning("cache de geocodificação: %d entradas com mais de 30 dias removidas", apagados)


async def _limpeza_diaria():
    while True:
        try:
            await asyncio.to_thread(_limpar_cache_geo)
        except Exception:
            log.exception("falha na limpeza do cache de geocodificação")
        await asyncio.sleep(24 * 3600)


@asynccontextmanager
async def ciclo_de_vida(_app):
    tarefa = asyncio.create_task(_limpeza_diaria())
    yield
    tarefa.cancel()


app = FastAPI(title="Rotear", docs_url=None, redoc_url=None, openapi_url=None, lifespan=ciclo_de_vida)
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")
app.include_router(auth.router)
app.include_router(paginas.router)
app.include_router(admin.router)
app.include_router(geocodificacao.router)
app.include_router(planejamento.router)

METODOS_INSEGUROS = {"POST", "PUT", "PATCH", "DELETE"}
LIMITE_UPLOAD = 5 * 1024 * 1024 + 64 * 1024  # 5 MB + folga do multipart
# Tiles do mapa vêm do OpenStreetMap; todo o resto é servido pelo próprio app.
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
)


@app.middleware("http")
async def protecoes(request: Request, call_next):
    # Bloqueia requisições de escrita vindas de outro site (complementa o SameSite=Lax)
    if request.method in METODOS_INSEGUROS:
        origem = request.headers.get("origin") or request.headers.get("referer")
        if origem and urlsplit(origem).netloc != request.headers.get("host"):
            return JSONResponse({"detail": "Origem não permitida."}, status_code=403)

    # Uploads: recusa pelo tamanho declarado antes de ler o corpo (planilhas têm no máximo 5 MB)
    if request.url.path == "/api/entrada/arquivo":
        tamanho = request.headers.get("content-length")
        if tamanho is None:
            return JSONResponse({"detail": "Envio sem tamanho declarado."}, status_code=411)
        if int(tamanho) > LIMITE_UPLOAD:
            return JSONResponse({"detail": "O arquivo passa de 5 MB."}, status_code=413)

    resposta = await call_next(request)
    resposta.headers.setdefault("X-Content-Type-Options", "nosniff")
    resposta.headers.setdefault("X-Frame-Options", "DENY")
    # A política de tiles do OSM exige Referer: envia só a origem (domínio) para fora, nunca o caminho
    resposta.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resposta.headers.setdefault("Content-Security-Policy", CSP)
    return resposta


def _quer_json(request: Request) -> bool:
    return request.url.path.startswith("/api/")


ROTULOS = {
    "nome": "Nome", "email": "E-mail", "senha": "Senha", "papel": "Papel",
    "solver_tempo_limite_s": "Tempo limite do cálculo", "max_paradas": "Máximo de paradas",
    "partida_lat": "Latitude do ponto de partida", "partida_lng": "Longitude do ponto de partida",
    "partida_endereco": "Endereço de partida",
}


@app.exception_handler(RequestValidationError)
def validacao(_request: Request, exc: RequestValidationError):
    """Devolve uma mensagem única e legível (em vez da lista técnica do Pydantic)."""
    erro = exc.errors()[0] if exc.errors() else {}
    msg = str(erro.get("msg", "Dados inválidos."))
    if msg.startswith("Value error, "):
        mensagem = msg.removeprefix("Value error, ")
    else:
        campo = next((str(p) for p in reversed(erro.get("loc", ())) if isinstance(p, str)), "")
        rotulo = ROTULOS.get(campo, campo or "Valor")
        ctx = erro.get("ctx") or {}
        if "ge" in ctx and "le" in ctx:
            mensagem = f"{rotulo}: use um valor entre {ctx['ge']} e {ctx['le']}."
        elif "ge" in ctx:
            mensagem = f"{rotulo}: use um valor a partir de {ctx['ge']}."
        elif "le" in ctx:
            mensagem = f"{rotulo}: use um valor até {ctx['le']}."
        elif erro.get("type") == "missing":
            mensagem = f"{rotulo}: campo obrigatório."
        else:
            mensagem = f"{rotulo}: valor inválido."
    return JSONResponse({"detail": mensagem}, status_code=422)


@app.exception_handler(NaoAutenticado)
def nao_autenticado(request: Request, _exc: NaoAutenticado):
    if _quer_json(request):
        return JSONResponse({"detail": "Faça login."}, status_code=401)
    return RedirectResponse("/login", status_code=303)


@app.exception_handler(SemPermissao)
def sem_permissao(request: Request, _exc: SemPermissao):
    if _quer_json(request):
        return JSONResponse({"detail": "Acesso restrito ao administrador."}, status_code=403)
    return templates.TemplateResponse(
        request, "erro.html", {"titulo": "Acesso negado", "mensagem": "Esta área é restrita ao administrador."}, status_code=403
    )


@app.get("/health")
def health():
    status = {"db": "ok", "osrm": "ok"}
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        status["db"] = "erro"
    try:
        r = httpx.get(f"{config.OSRM_URL}/nearest/v1/driving/-47.8828,-15.7942", timeout=3)
        if r.status_code != 200 or r.json().get("code") != "Ok":
            status["osrm"] = "erro"
    except Exception:
        status["osrm"] = "erro"
    ok = all(v == "ok" for v in status.values())
    return JSONResponse({"status": "ok" if ok else "erro", **status}, status_code=200 if ok else 503)
