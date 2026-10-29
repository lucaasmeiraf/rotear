from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import config
from app.db import get_db
from app.deps import usuario_opcional
from app.models import Usuario
from app.seguranca import (
    criar_token_sessao,
    gerar_hash,
    ip_bloqueado,
    precisa_rehash,
    registrar_falha_ip,
    verificar_senha,
)
from app.templating import templates

router = APIRouter()

MSG_INVALIDO = "E-mail ou senha inválidos."
MSG_BLOQUEADO = "Muitas tentativas de login. Aguarde alguns minutos e tente novamente."


def _form_login(request: Request, erro: str | None = None, email: str = "", status: int = 200):
    return templates.TemplateResponse(request, "login.html", {"erro": erro, "email": email}, status_code=status)


@router.get("/login")
def login_form(request: Request, usuario: Usuario | None = Depends(usuario_opcional)):
    if usuario:
        return RedirectResponse("/planejar", status_code=303)
    return _form_login(request)


@router.post("/login")
def login(request: Request, email: str = Form(...), senha: str = Form(...), db: Session = Depends(get_db)):
    ip = request.client.host if request.client else "?"
    email = email.strip().lower()
    if ip_bloqueado(ip):
        return _form_login(request, MSG_BLOQUEADO, email, 429)

    agora = datetime.now(timezone.utc)
    usuario = db.scalar(select(Usuario).where(Usuario.email == email))
    if usuario and usuario.bloqueado_ate and usuario.bloqueado_ate > agora:
        registrar_falha_ip(ip)
        return _form_login(request, MSG_BLOQUEADO, email, 429)

    senha_ok = verificar_senha(usuario.senha_hash if usuario else None, senha)
    if not senha_ok or not usuario.ativo:
        registrar_falha_ip(ip)
        if usuario and not senha_ok:
            usuario.falhas_login += 1
            if usuario.falhas_login >= config.LOGIN_MAX_FALHAS_CONTA:
                usuario.bloqueado_ate = agora + timedelta(seconds=config.LOGIN_BLOQUEIO_S)
                usuario.falhas_login = 0
            db.commit()
        return _form_login(request, MSG_INVALIDO, email, 401)

    usuario.falhas_login = 0
    usuario.bloqueado_ate = None
    if precisa_rehash(usuario.senha_hash):
        usuario.senha_hash = gerar_hash(senha)
    db.commit()

    resposta = RedirectResponse("/planejar", status_code=303)
    resposta.set_cookie(
        config.COOKIE_NOME,
        criar_token_sessao(usuario.id, usuario.sessao_versao),
        max_age=config.SESSAO_DURACAO_S,
        httponly=True,
        secure=config.COOKIE_SECURE,
        samesite="lax",
    )
    return resposta


@router.post("/logout")
def logout():
    resposta = RedirectResponse("/login", status_code=303)
    resposta.delete_cookie(config.COOKIE_NOME, httponly=True, secure=config.COOKIE_SECURE, samesite="lax")
    return resposta
