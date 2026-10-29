"""Configuração da aplicação: somente variáveis de ambiente."""
import os


def _bool(nome: str, padrao: bool) -> bool:
    valor = os.getenv(nome)
    return padrao if valor is None else valor.strip().lower() in ("1", "true", "sim", "yes")


DATABASE_URL = os.environ["DATABASE_URL"]
SECRET_KEY = os.environ["SECRET_KEY"]
OSRM_URL = os.getenv("OSRM_URL", "http://osrm:5000")

# Cookie de sessão
COOKIE_NOME = "rotear_sessao"
COOKIE_SECURE = _bool("COOKIE_SECURE", True)
SESSAO_DURACAO_S = int(os.getenv("SESSAO_DURACAO_S", str(12 * 3600)))

# Limite de tentativas de login
LOGIN_MAX_FALHAS_CONTA = 5  # bloqueia a conta por LOGIN_BLOQUEIO_S
LOGIN_MAX_FALHAS_IP = 20  # por IP, dentro de LOGIN_BLOQUEIO_S
LOGIN_BLOQUEIO_S = 15 * 60
