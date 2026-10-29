from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app import config
from app.db import get_db
from app.models import Usuario
from app.seguranca import ler_token_sessao


class NaoAutenticado(Exception):
    pass


class SemPermissao(Exception):
    pass


def usuario_opcional(request: Request, db: Session = Depends(get_db)) -> Usuario | None:
    token = request.cookies.get(config.COOKIE_NOME)
    dados = ler_token_sessao(token) if token else None
    if not dados:
        return None
    usuario = db.get(Usuario, dados[0])
    if not usuario or not usuario.ativo or usuario.sessao_versao != dados[1]:
        return None
    return usuario


def exigir_login(usuario: Usuario | None = Depends(usuario_opcional)) -> Usuario:
    if usuario is None:
        raise NaoAutenticado()
    return usuario


def exigir_admin(usuario: Usuario = Depends(exigir_login)) -> Usuario:
    if usuario.papel != "admin":
        raise SemPermissao()
    return usuario
