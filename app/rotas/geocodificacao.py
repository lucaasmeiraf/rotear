import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.db import SessionLocal, get_db
from app.deps import exigir_login
from app.geocodificacao import GeocodificacaoIndisponivel
from app.geocodificacao.servico import chave_cache, do_cache, geocodificar
from app.models import Usuario
from app.rotas.admin import obter_configuracao

router = APIRouter()

MAX_CARACTERES = 300


def _texto(v: str) -> str:
    v = " ".join(v.split())
    if not v:
        raise ValueError("Endereço vazio.")
    if len(v) > MAX_CARACTERES:
        raise ValueError(f"Endereço com mais de {MAX_CARACTERES} caracteres.")
    return v


class UmEndereco(BaseModel):
    endereco: str

    @field_validator("endereco")
    @classmethod
    def _endereco(cls, v: str) -> str:
        return _texto(v)


class VariosEnderecos(BaseModel):
    enderecos: list[str] = Field(min_length=1)

    @field_validator("enderecos")
    @classmethod
    def _lista(cls, v: list[str]) -> list[str]:
        return [_texto(e) for e in v]


@router.post("/api/geocodificar/um")
def geocodificar_um(dados: UmEndereco, _: Usuario = Depends(exigir_login), db: Session = Depends(get_db)):
    ativa = obter_configuracao(db).geocodificacao_ativa
    try:
        resultado, de_cache = geocodificar(db, dados.endereco, ativa)
    except GeocodificacaoIndisponivel as exc:
        raise HTTPException(503, str(exc)) from None
    return {**resultado.json(), "de_cache": de_cache}


@router.post("/api/geocodificar")
def geocodificar_lote(dados: VariosEnderecos, _: Usuario = Depends(exigir_login), db: Session = Depends(get_db)):
    """Streaming NDJSON: primeiro tudo o que está em cache, depois o provedor (1 por segundo)."""
    cfg = obter_configuracao(db)
    if len(dados.enderecos) > cfg.max_paradas:
        raise HTTPException(422, f"No máximo {cfg.max_paradas} endereços por planejamento.")
    ativa = cfg.geocodificacao_ativa

    pendentes = []
    acertos = []
    for i, endereco in enumerate(dados.enderecos):
        r = do_cache(db, chave_cache(endereco))
        if r is None:
            pendentes.append((i, endereco))
        else:
            acertos.append((i, r))
    if pendentes and not ativa:
        raise HTTPException(503, "A geocodificação está desativada pelo administrador.")

    def linhas():
        yield json.dumps({"tipo": "inicio", "total": len(dados.enderecos), "pendentes": len(pendentes)}) + "\n"
        for i, r in acertos:
            yield json.dumps({"tipo": "resultado", "indice": i, "de_cache": True, **r.json()}) + "\n"
        with SessionLocal() as sessao:  # sessão própria: o streaming continua após o fim da requisição
            for i, endereco in pendentes:
                try:
                    r, de_cache = geocodificar(sessao, endereco, ativa)
                except GeocodificacaoIndisponivel as exc:
                    yield json.dumps({"tipo": "erro", "indice": i, "mensagem": str(exc)}) + "\n"
                    return
                yield json.dumps({"tipo": "resultado", "indice": i, "de_cache": de_cache, **r.json()}) + "\n"
        yield json.dumps({"tipo": "fim"}) + "\n"

    return StreamingResponse(linhas(), media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})
