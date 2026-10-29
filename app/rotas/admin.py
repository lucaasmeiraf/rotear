"""Administração: usuários, configurações e métricas. Tudo exige papel admin no backend."""
import re
from datetime import datetime, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import config
from app.db import get_db
from app.deps import exigir_admin
from app.models import Configuracao, MetricaUso, Usuario
from app.seguranca import criar_token_sessao, gerar_hash, validar_senha_nova
from app.templating import templates

router = APIRouter()

FUSO = ZoneInfo("America/Sao_Paulo")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MAX_PARADAS_LIMITE = 499  # o OSRM roda com --max-table-size 500 (paradas + ponto de partida)


# --- Páginas ------------------------------------------------------------------


@router.get("/admin")
def admin_inicio(_: Usuario = Depends(exigir_admin)):
    return RedirectResponse("/admin/usuarios", status_code=303)


@router.get("/admin/usuarios")
def pagina_usuarios(request: Request, usuario: Usuario = Depends(exigir_admin), db: Session = Depends(get_db)):
    return templates.TemplateResponse(request, "admin/usuarios.html", {
        "usuario": usuario, "secao": "admin", "aba": "usuarios",
        "dados": {"usuarios": [_usuario_json(u) for u in _listar_usuarios(db)], "eu": usuario.id},
    })


@router.get("/admin/configuracoes")
def pagina_configuracoes(request: Request, usuario: Usuario = Depends(exigir_admin), db: Session = Depends(get_db)):
    return templates.TemplateResponse(request, "admin/configuracoes.html", {
        "usuario": usuario, "secao": "admin", "aba": "configuracoes",
        "dados": {"config": _config_json(obter_configuracao(db)), "limite_paradas": MAX_PARADAS_LIMITE},
    })


@router.get("/admin/metricas")
def pagina_metricas(request: Request, usuario: Usuario = Depends(exigir_admin), db: Session = Depends(get_db)):
    return templates.TemplateResponse(request, "admin/metricas.html", {
        "usuario": usuario, "secao": "admin", "aba": "metricas", "dados": calcular_metricas(db, 30),
    })


# --- Usuários -----------------------------------------------------------------


class NovoUsuario(BaseModel):
    nome: str = Field(min_length=1, max_length=120)
    email: str = Field(max_length=254)
    papel: Literal["admin", "operador"]
    senha: str

    @field_validator("nome")
    @classmethod
    def _nome(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Informe o nome.")
        return v

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if not EMAIL_RE.match(v):
            raise ValueError("E-mail inválido.")
        return v


class AlterarStatus(BaseModel):
    ativo: bool


class NovaSenha(BaseModel):
    senha: str


def _listar_usuarios(db: Session) -> list[Usuario]:
    return list(db.scalars(select(Usuario).order_by(Usuario.ativo.desc(), Usuario.nome)))


def _usuario_json(u: Usuario) -> dict:
    agora = datetime.now(timezone.utc)
    return {
        "id": u.id, "nome": u.nome, "email": u.email, "papel": u.papel, "ativo": u.ativo,
        "bloqueado": bool(u.bloqueado_ate and u.bloqueado_ate > agora),
        "criado_em": u.criado_em.isoformat() if u.criado_em else None,
    }


def _buscar(db: Session, usuario_id: int) -> Usuario:
    u = db.get(Usuario, usuario_id)
    if not u:
        raise HTTPException(404, "Usuário não encontrado.")
    return u


def _checar_senha(senha: str) -> None:
    if erro := validar_senha_nova(senha):
        raise HTTPException(422, erro)


@router.get("/api/admin/usuarios")
def listar_usuarios(_: Usuario = Depends(exigir_admin), db: Session = Depends(get_db)):
    return [_usuario_json(u) for u in _listar_usuarios(db)]


@router.post("/api/admin/usuarios", status_code=201)
def criar_usuario(dados: NovoUsuario, _: Usuario = Depends(exigir_admin), db: Session = Depends(get_db)):
    _checar_senha(dados.senha)
    if db.scalar(select(Usuario).where(Usuario.email == dados.email)):
        raise HTTPException(409, "Já existe um usuário com este e-mail.")
    u = Usuario(nome=dados.nome, email=dados.email, papel=dados.papel, senha_hash=gerar_hash(dados.senha))
    db.add(u)
    db.commit()
    return _usuario_json(u)


@router.patch("/api/admin/usuarios/{usuario_id}")
def alterar_status(usuario_id: int, dados: AlterarStatus, eu: Usuario = Depends(exigir_admin), db: Session = Depends(get_db)):
    u = _buscar(db, usuario_id)
    if not dados.ativo:
        if u.id == eu.id:
            raise HTTPException(409, "Você não pode desativar a sua própria conta.")
        if u.papel == "admin" and u.ativo:
            admins_ativos = db.scalar(select(func.count()).where(Usuario.papel == "admin", Usuario.ativo.is_(True)))
            if admins_ativos <= 1:
                raise HTTPException(409, "É preciso manter pelo menos um administrador ativo.")
        if u.ativo:
            u.sessao_versao += 1  # derruba as sessões abertas
        u.ativo = False
    else:
        u.ativo = True
        u.falhas_login = 0
        u.bloqueado_ate = None
    db.commit()
    return _usuario_json(u)


@router.post("/api/admin/usuarios/{usuario_id}/senha")
def redefinir_senha(usuario_id: int, dados: NovaSenha, response: Response,
                    eu: Usuario = Depends(exigir_admin), db: Session = Depends(get_db)):
    _checar_senha(dados.senha)
    u = _buscar(db, usuario_id)
    u.senha_hash = gerar_hash(dados.senha)
    u.sessao_versao += 1
    u.falhas_login = 0
    u.bloqueado_ate = None
    db.commit()
    if u.id == eu.id:  # mantém o próprio admin logado com a nova versão de sessão
        response.set_cookie(config.COOKIE_NOME, criar_token_sessao(u.id, u.sessao_versao), max_age=config.SESSAO_DURACAO_S,
                            httponly=True, secure=config.COOKIE_SECURE, samesite="lax")
    return _usuario_json(u)


# --- Configurações ------------------------------------------------------------


def obter_configuracao(db: Session) -> Configuracao:
    cfg = db.get(Configuracao, 1)
    if cfg is None:  # a migração cria a linha; isto só protege contra banco limpo à mão
        cfg = Configuracao(id=1)
        db.add(cfg)
        db.commit()
    return cfg


def _config_json(c: Configuracao) -> dict:
    return {
        "modo_partida": c.modo_partida, "partida_endereco": c.partida_endereco,
        "partida_lat": c.partida_lat, "partida_lng": c.partida_lng,
        "solver_tempo_limite_s": c.solver_tempo_limite_s, "max_paradas": c.max_paradas,
        "geocodificacao_ativa": c.geocodificacao_ativa,
    }


class ConfiguracaoIn(BaseModel):
    modo_partida: Literal["localizacao_atual", "endereco_fixo"]
    partida_endereco: str | None = Field(default=None, max_length=300)
    partida_lat: float | None = Field(default=None, ge=-34, le=6)  # Brasil
    partida_lng: float | None = Field(default=None, ge=-74, le=-34)
    solver_tempo_limite_s: int = Field(ge=5, le=300)
    max_paradas: int = Field(ge=1, le=MAX_PARADAS_LIMITE)
    geocodificacao_ativa: bool

    @model_validator(mode="after")
    def _endereco_fixo_completo(self):
        if self.partida_endereco:
            self.partida_endereco = self.partida_endereco.strip() or None
        if self.modo_partida == "endereco_fixo" and (
            not self.partida_endereco or self.partida_lat is None or self.partida_lng is None
        ):
            raise ValueError("Para usar endereço fixo, informe o endereço e confirme o ponto no mapa.")
        return self


@router.get("/api/admin/configuracoes")
def ler_configuracoes(_: Usuario = Depends(exigir_admin), db: Session = Depends(get_db)):
    return _config_json(obter_configuracao(db))


@router.put("/api/admin/configuracoes")
def salvar_configuracoes(dados: ConfiguracaoIn, _: Usuario = Depends(exigir_admin), db: Session = Depends(get_db)):
    cfg = obter_configuracao(db)
    for campo, valor in dados.model_dump().items():
        setattr(cfg, campo, valor)
    db.commit()
    return _config_json(cfg)


# --- Métricas -----------------------------------------------------------------


def calcular_metricas(db: Session, dias: int) -> dict:
    # Período em dias de calendário (fuso de Brasília), incluindo hoje: igual ao eixo do gráfico
    hoje = datetime.now(FUSO).replace(hour=0, minute=0, second=0, microsecond=0)
    desde = hoje - timedelta(days=dias - 1)
    filtro = MetricaUso.criado_em >= desde

    tot = db.execute(select(
        func.count(), func.coalesce(func.sum(MetricaUso.qtd_paradas), 0), func.coalesce(func.sum(MetricaUso.km_total), 0),
        func.coalesce(func.sum(MetricaUso.tempo_total_s), 0), func.coalesce(func.avg(MetricaUso.tempo_calculo_ms), 0),
        func.coalesce(func.avg(MetricaUso.qtd_motoristas), 0),
    ).where(filtro)).one()

    dia = func.date_trunc("day", func.timezone("America/Sao_Paulo", MetricaUso.criado_em))
    por_dia = db.execute(
        select(dia.label("dia"), func.count(), func.sum(MetricaUso.qtd_paradas)).where(filtro).group_by(dia).order_by(dia)
    ).all()

    contagem = {d.date().isoformat(): (n, int(p or 0)) for d, n, p in por_dia}

    por_usuario = db.execute(
        select(func.coalesce(Usuario.nome, "(removido)"), func.count(), func.sum(MetricaUso.qtd_paradas))
        .select_from(MetricaUso).outerjoin(Usuario, Usuario.id == MetricaUso.usuario_id)
        .where(filtro).group_by(Usuario.nome).order_by(func.count().desc())
    ).all()

    recentes = db.execute(
        select(MetricaUso, Usuario.nome).outerjoin(Usuario, Usuario.id == MetricaUso.usuario_id)
        .where(filtro).order_by(MetricaUso.criado_em.desc()).limit(20)
    ).all()

    return {
        "dias": dias,
        "totais": {
            "planejamentos": tot[0], "paradas": int(tot[1]), "km": round(float(tot[2]), 1),
            "tempo_total_s": int(tot[3]), "media_calculo_ms": round(float(tot[4])), "media_motoristas": round(float(tot[5]), 1),
        },
        # Todos os dias do período (fuso de Brasília), com zero onde não houve uso
        "por_dia": [
            {"dia": (dia_iso := (desde + timedelta(days=i)).date().isoformat()),
             "planejamentos": contagem.get(dia_iso, (0, 0))[0], "paradas": contagem.get(dia_iso, (0, 0))[1]}
            for i in range(dias)
        ],
        "por_usuario": [{"nome": nome, "planejamentos": n, "paradas": int(p or 0)} for nome, n, p in por_usuario],
        "recentes": [{
            "criado_em": m.criado_em.isoformat(), "usuario": nome or "(removido)", "qtd_paradas": m.qtd_paradas,
            "qtd_motoristas": m.qtd_motoristas, "km_total": m.km_total, "tempo_total_s": m.tempo_total_s,
            "tempo_calculo_ms": m.tempo_calculo_ms,
        } for m, nome in recentes],
    }


@router.get("/api/admin/metricas")
def metricas(dias: int = Query(30, ge=1, le=365), _: Usuario = Depends(exigir_admin), db: Session = Depends(get_db)):
    return calcular_metricas(db, dias)
