from datetime import datetime, timedelta, timezone

from app.db import SessionLocal
from app.models import MetricaUso
from tests.conftest import SENHA, login


def _admin(cliente, criar_usuario):
    uid = criar_usuario(email="adm@teste.com", papel="admin")
    login(cliente, "adm@teste.com")
    return uid


def test_operador_nao_acessa_nada_de_admin(cliente, criar_usuario):
    criar_usuario(email="op@teste.com")
    login(cliente, "op@teste.com")
    for metodo, url, corpo in [
        ("GET", "/api/admin/usuarios", None),
        ("POST", "/api/admin/usuarios", {"nome": "X", "email": "x@t.com", "papel": "admin", "senha": SENHA}),
        ("PATCH", "/api/admin/usuarios/1", {"ativo": False}),
        ("POST", "/api/admin/usuarios/1/senha", {"senha": SENHA}),
        ("GET", "/api/admin/configuracoes", None),
        ("PUT", "/api/admin/configuracoes", {}),
        ("GET", "/api/admin/metricas", None),
    ]:
        r = cliente.request(metodo, url, json=corpo)
        assert r.status_code == 403, (metodo, url, r.status_code)
    for pagina in ("/admin/usuarios", "/admin/configuracoes", "/admin/metricas"):
        assert cliente.get(pagina).status_code == 403


def test_sem_login_api_admin_da_401(cliente):
    assert cliente.get("/api/admin/usuarios").status_code == 401


def test_criar_usuario_e_logar(cliente, criar_usuario):
    _admin(cliente, criar_usuario)
    r = cliente.post("/api/admin/usuarios", json={"nome": " Maria ", "email": "Maria@Teste.com", "papel": "operador", "senha": SENHA})
    assert r.status_code == 201 and r.json()["email"] == "maria@teste.com" and r.json()["nome"] == "Maria"
    dup = cliente.post("/api/admin/usuarios", json={"nome": "M", "email": "maria@teste.com", "papel": "operador", "senha": SENHA})
    assert dup.status_code == 409
    curta = cliente.post("/api/admin/usuarios", json={"nome": "M", "email": "m2@teste.com", "papel": "operador", "senha": "123"})
    assert curta.status_code == 422 and "10 caracteres" in curta.json()["detail"]
    ruim = cliente.post("/api/admin/usuarios", json={"nome": "M", "email": "sem-arroba", "papel": "operador", "senha": SENHA})
    assert ruim.status_code == 422 and ruim.json()["detail"] == "E-mail inválido."
    cliente.post("/logout")
    assert login(cliente, "maria@teste.com").status_code == 303


def test_desativar_derruba_sessao_e_reativar(cliente, criar_usuario):
    from fastapi.testclient import TestClient

    from app.main import app
    _admin(cliente, criar_usuario)
    uid = criar_usuario(email="op@teste.com")
    with TestClient(app, base_url="https://testserver") as outro:
        login(outro, "op@teste.com")
        assert outro.get("/planejar", follow_redirects=False).status_code == 200
        r = cliente.patch(f"/api/admin/usuarios/{uid}", json={"ativo": False})
        assert r.status_code == 200 and r.json()["ativo"] is False
        assert outro.get("/planejar", follow_redirects=False).status_code == 303
        assert login(outro, "op@teste.com").status_code == 401
        cliente.patch(f"/api/admin/usuarios/{uid}", json={"ativo": True})
        assert login(outro, "op@teste.com").status_code == 303


def test_nao_desativa_a_si_mesmo_nem_ultimo_admin(cliente, criar_usuario):
    eu = _admin(cliente, criar_usuario)
    assert cliente.patch(f"/api/admin/usuarios/{eu}", json={"ativo": False}).status_code == 409
    outro_admin = criar_usuario(email="adm2@teste.com", papel="admin")
    assert cliente.patch(f"/api/admin/usuarios/{outro_admin}", json={"ativo": False}).status_code == 200


def test_redefinir_senha(cliente, criar_usuario):
    eu = _admin(cliente, criar_usuario)
    uid = criar_usuario(email="op@teste.com")
    nova = "nova-senha-segura-1"
    assert cliente.post(f"/api/admin/usuarios/{uid}/senha", json={"senha": nova}).status_code == 200
    # redefinir a própria senha mantém o admin logado
    assert cliente.post(f"/api/admin/usuarios/{eu}/senha", json={"senha": nova}).status_code == 200
    assert cliente.get("/admin/usuarios", follow_redirects=False).status_code == 200
    cliente.post("/logout")
    assert login(cliente, "op@teste.com", SENHA).status_code == 401
    assert login(cliente, "op@teste.com", nova).status_code == 303


def test_redefinir_senha_desbloqueia_conta(cliente, criar_usuario):
    from app import config
    uid = criar_usuario(email="op@teste.com")
    for _ in range(config.LOGIN_MAX_FALHAS_CONTA):
        login(cliente, "op@teste.com", "errada-errada")
    assert login(cliente, "op@teste.com").status_code == 429
    _admin(cliente, criar_usuario)
    lista = cliente.get("/api/admin/usuarios").json()
    assert next(u for u in lista if u["id"] == uid)["bloqueado"] is True
    cliente.post(f"/api/admin/usuarios/{uid}/senha", json={"senha": SENHA})
    cliente.post("/logout")
    assert login(cliente, "op@teste.com").status_code == 303


def test_configuracoes_validacao(cliente, criar_usuario):
    _admin(cliente, criar_usuario)
    base = {**cliente.get("/api/admin/configuracoes").json(), "solver_tempo_limite_s": 30}
    assert base["modo_partida"] == "localizacao_atual" and base["max_paradas"] == 200

    fixo_sem_ponto = {**base, "modo_partida": "endereco_fixo", "partida_endereco": "SIA", "partida_lat": None}
    r = cliente.put("/api/admin/configuracoes", json=fixo_sem_ponto)
    assert r.status_code == 422 and "endereço fixo" in r.json()["detail"]

    r = cliente.put("/api/admin/configuracoes", json={**base, "max_paradas": 900})
    assert r.status_code == 422 and "Máximo de paradas" in r.json()["detail"]

    ok = {**base, "modo_partida": "endereco_fixo", "partida_endereco": "SIA Trecho 3", "partida_lat": -15.80,
          "partida_lng": -47.95, "solver_tempo_limite_s": 45, "max_paradas": 150, "geocodificacao_ativa": False}
    r = cliente.put("/api/admin/configuracoes", json=ok)
    assert r.status_code == 200 and r.json() == {k: ok[k] for k in r.json()}


def test_metricas_agregadas(cliente, criar_usuario):
    uid = _admin(cliente, criar_usuario)
    agora = datetime.now(timezone.utc)
    with SessionLocal() as db:
        db.query(MetricaUso).delete()
        db.add_all([
            MetricaUso(usuario_id=uid, qtd_paradas=10, qtd_motoristas=1, km_total=42.5, tempo_total_s=3600, tempo_calculo_ms=30000),
            MetricaUso(usuario_id=uid, qtd_paradas=20, qtd_motoristas=2, km_total=57.5, tempo_total_s=1800, tempo_calculo_ms=30200),
            MetricaUso(usuario_id=uid, qtd_paradas=99, qtd_motoristas=1, km_total=1, tempo_total_s=1, tempo_calculo_ms=1,
                       criado_em=agora - timedelta(days=60)),
        ])
        db.commit()
    m = cliente.get("/api/admin/metricas?dias=30").json()
    assert m["totais"]["planejamentos"] == 2 and m["totais"]["paradas"] == 30 and m["totais"]["km"] == 100.0
    assert m["totais"]["media_motoristas"] == 1.5 and len(m["recentes"]) == 2
    assert m["por_usuario"][0]["planejamentos"] == 2
    assert cliente.get("/api/admin/metricas?dias=90").json()["totais"]["planejamentos"] == 3
    assert "endereco" not in str(m).lower()


def test_grafico_soma_o_total_do_periodo(cliente, criar_usuario):
    uid = _admin(cliente, criar_usuario)
    agora = datetime.now(timezone.utc)
    with SessionLocal() as db:
        db.query(MetricaUso).delete()
        for horas in (1, 20, 30, 24 * 6 + 23, 24 * 7 + 1, 24 * 29):
            db.add(MetricaUso(usuario_id=uid, qtd_paradas=5, qtd_motoristas=1, km_total=1, tempo_total_s=1,
                              tempo_calculo_ms=1, criado_em=agora - timedelta(hours=horas)))
        db.commit()
    for dias in (7, 30):
        m = cliente.get(f"/api/admin/metricas?dias={dias}").json()
        assert len(m["por_dia"]) == dias
        assert sum(d["planejamentos"] for d in m["por_dia"]) == m["totais"]["planejamentos"]
