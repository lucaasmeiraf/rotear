import os
import subprocess

from sqlalchemy import select

from app import config
from app.db import SessionLocal
from app.models import Usuario
from tests.conftest import SENHA, login


def test_login_ok_define_cookie_seguro(cliente, criar_usuario):
    criar_usuario()
    r = login(cliente, "OP@teste.com ")  # e-mail sem distinção de maiúsculas e espaços
    assert r.status_code == 303 and r.headers["location"] == "/planejar"
    cookie = r.headers["set-cookie"]
    assert config.COOKIE_NOME in cookie
    for atributo in ("HttpOnly", "Secure", "SameSite=lax"):
        assert atributo.lower() in cookie.lower()
    assert cliente.get("/planejar").status_code == 200


def test_login_invalido_mensagem_generica(cliente, criar_usuario):
    criar_usuario()
    r1 = login(cliente, "op@teste.com", "errada-errada")
    r2 = login(cliente, "naoexiste@teste.com", "errada-errada")
    assert r1.status_code == r2.status_code == 401
    assert "E-mail ou senha inválidos" in r1.text and "E-mail ou senha inválidos" in r2.text


def test_paginas_exigem_login(cliente):
    r = cliente.get("/planejar", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login"
    assert cliente.get("/privacidade").status_code == 200


def test_admin_protegido_no_backend(cliente, criar_usuario):
    criar_usuario(email="op@teste.com", papel="operador")
    criar_usuario(email="adm@teste.com", papel="admin")
    login(cliente, "op@teste.com")
    r = cliente.get("/admin")
    assert r.status_code == 403
    assert 'href="/admin"' not in cliente.get("/planejar").text  # menu escondido para operador
    cliente.post("/logout")
    login(cliente, "adm@teste.com")
    assert cliente.get("/admin").status_code == 200


def test_bloqueio_por_conta_apos_5_falhas(cliente, criar_usuario):
    criar_usuario()
    for _ in range(config.LOGIN_MAX_FALHAS_CONTA):
        assert login(cliente, "op@teste.com", "errada-errada").status_code == 401
    r = login(cliente, "op@teste.com")  # senha certa, mas conta bloqueada
    assert r.status_code == 429


def test_bloqueio_por_ip(cliente):
    for i in range(config.LOGIN_MAX_FALHAS_IP):
        login(cliente, f"x{i}@teste.com", "errada-errada")
    assert login(cliente, "qualquer@teste.com", "errada-errada").status_code == 429


def test_usuario_inativo_nao_entra(cliente, criar_usuario):
    criar_usuario(ativo=False)
    assert login(cliente, "op@teste.com").status_code == 401


def test_sessao_invalidada_ao_mudar_versao(cliente, criar_usuario):
    uid = criar_usuario()
    login(cliente, "op@teste.com")
    assert cliente.get("/planejar", follow_redirects=False).status_code == 200
    with SessionLocal() as db:
        db.get(Usuario, uid).sessao_versao += 1  # o que acontece ao desativar ou redefinir senha
        db.commit()
    assert cliente.get("/planejar", follow_redirects=False).status_code == 303


def test_cookie_adulterado_e_ignorado(cliente, criar_usuario):
    criar_usuario()
    login(cliente, "op@teste.com")
    token = cliente.cookies.get(config.COOKIE_NOME)
    cliente.cookies.clear()
    cliente.cookies.set(config.COOKIE_NOME, token[:-2] + "xx")
    assert cliente.get("/planejar", follow_redirects=False).status_code == 303


def test_post_de_outra_origem_bloqueado(cliente, criar_usuario):
    criar_usuario()
    r = cliente.post("/login", data={"email": "op@teste.com", "senha": SENHA},
                     headers={"Origin": "https://site-malicioso.com"}, follow_redirects=False)
    assert r.status_code == 403


def test_cli_criar_admin():
    r = subprocess.run(
        ["python", "-m", "app.cli", "criar-admin", "--email", "Chefe@Teste.com", "--nome", "Chefe"],
        env={**os.environ, "ROTEAR_SENHA": SENHA}, capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    with SessionLocal() as db:
        u = db.scalar(select(Usuario).where(Usuario.email == "chefe@teste.com"))
        assert u and u.papel == "admin" and u.senha_hash.startswith("$argon2")
    curta = subprocess.run(
        ["python", "-m", "app.cli", "criar-admin", "--email", "b@teste.com", "--nome", "B"],
        env={**os.environ, "ROTEAR_SENHA": "curta"}, capture_output=True, text=True,
    )
    assert curta.returncode == 1


def test_url_do_banco_aceita_formato_do_easypanel():
    from app.db import url_sqlalchemy
    assert url_sqlalchemy("postgres://u:s@h:5432/b") == "postgresql+psycopg://u:s@h:5432/b"
    assert url_sqlalchemy("postgresql://u:s@h:5432/b") == "postgresql+psycopg://u:s@h:5432/b"
    assert url_sqlalchemy("postgresql+psycopg://u:s@h/b") == "postgresql+psycopg://u:s@h/b"
