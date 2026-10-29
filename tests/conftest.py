"""Os testes usam um banco separado (<POSTGRES_DB>_test) no mesmo Postgres, recriado pelas migrações."""
import os

import psycopg
import pytest

URL_PRINCIPAL = os.environ["DATABASE_URL"]
BASE, NOME = URL_PRINCIPAL.rsplit("/", 1)
NOME_TESTE = f"{NOME}_test"
os.environ["DATABASE_URL"] = f"{BASE}/{NOME_TESTE}"
os.environ["GEOCODIFICADOR"] = "falso"
os.environ["PROVEDOR_MATRIZ"] = "haversine"

with psycopg.connect(URL_PRINCIPAL, autocommit=True) as conn:
    conn.execute(f'DROP DATABASE IF EXISTS "{NOME_TESTE}" WITH (FORCE)')
    conn.execute(f'CREATE DATABASE "{NOME_TESTE}"')

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402

command.upgrade(Config("/srv/alembic.ini"), "head")

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app import seguranca  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Usuario  # noqa: E402

SENHA = "senha-de-teste-123"


@pytest.fixture(autouse=True)
def limpar():
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE usuarios, cache_geocodificacao RESTART IDENTITY CASCADE"))
        conn.execute(text("UPDATE configuracoes SET geocodificacao_ativa = true, max_paradas = 200, "
                          "modo_partida = 'localizacao_atual', partida_endereco = NULL, partida_lat = NULL, partida_lng = NULL, "
                          "solver_tempo_limite_s = 1"))
        conn.execute(text("TRUNCATE metricas_uso"))
    seguranca._falhas_ip.clear()
    yield


@pytest.fixture
def cliente():
    # https: o cookie de sessão é Secure
    with TestClient(app, base_url="https://testserver") as c:
        yield c


@pytest.fixture
def criar_usuario():
    def _criar(email="op@teste.com", papel="operador", ativo=True, senha=SENHA):
        with SessionLocal() as db:
            u = Usuario(email=email, nome="Teste", senha_hash=seguranca.gerar_hash(senha), papel=papel, ativo=ativo)
            db.add(u)
            db.commit()
            return u.id

    return _criar


def login(cliente, email, senha=SENHA):
    return cliente.post("/login", data={"email": email, "senha": senha}, follow_redirects=False)
