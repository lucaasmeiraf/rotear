"""Senhas (argon2), cookie de sessão assinado e limite de tentativas de login."""
import time
from collections import defaultdict, deque

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from itsdangerous import BadSignature, URLSafeTimedSerializer

from app import config

SENHA_MIN = 10

_hasher = PasswordHasher()
# Usado quando o e-mail não existe, para o tempo de resposta não revelar se a conta existe
_HASH_FALSO = _hasher.hash("senha-que-nunca-sera-usada")


def gerar_hash(senha: str) -> str:
    return _hasher.hash(senha)


def verificar_senha(senha_hash: str | None, senha: str) -> bool:
    try:
        return _hasher.verify(senha_hash or _HASH_FALSO, senha) and senha_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def precisa_rehash(senha_hash: str) -> bool:
    return _hasher.check_needs_rehash(senha_hash)


def validar_senha_nova(senha: str) -> str | None:
    """Retorna a mensagem de erro, ou None se a senha for aceitável."""
    if len(senha) < SENHA_MIN:
        return f"A senha precisa ter pelo menos {SENHA_MIN} caracteres."
    return None


# --- Sessão -----------------------------------------------------------------

_serializer = URLSafeTimedSerializer(config.SECRET_KEY, salt="rotear-sessao")


def criar_token_sessao(usuario_id: int, sessao_versao: int) -> str:
    return _serializer.dumps({"u": usuario_id, "v": sessao_versao})


def ler_token_sessao(token: str) -> tuple[int, int] | None:
    try:
        dados = _serializer.loads(token, max_age=config.SESSAO_DURACAO_S)
        return int(dados["u"]), int(dados["v"])
    except (BadSignature, KeyError, TypeError, ValueError):
        return None


# --- Limite por IP (em memória: a API roda com 1 worker) ----------------------
# O limite por conta fica no banco (usuarios.falhas_login / bloqueado_ate).

_falhas_ip: dict[str, deque] = defaultdict(deque)


def _limpar(ip: str, agora: float) -> deque:
    fila = _falhas_ip[ip]
    while fila and agora - fila[0] > config.LOGIN_BLOQUEIO_S:
        fila.popleft()
    return fila


def ip_bloqueado(ip: str) -> bool:
    return len(_limpar(ip, time.monotonic())) >= config.LOGIN_MAX_FALHAS_IP


def registrar_falha_ip(ip: str) -> None:
    agora = time.monotonic()
    _limpar(ip, agora).append(agora)
