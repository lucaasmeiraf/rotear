import json
import time
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.db import SessionLocal
from app.geocodificacao import GeocodificacaoIndisponivel
from app.geocodificacao.falso import GeocodificadorFalso
from app.geocodificacao.nominatim import Nominatim, nivel_por_rank
from app.geocodificacao.servico import limpar_cache, normalizar
from app.models import CacheGeocodificacao, Configuracao
from tests.conftest import login


@pytest.fixture
def logado(cliente, criar_usuario):
    criar_usuario()
    login(cliente, "op@teste.com")
    return cliente


def _linhas(resp):
    return [json.loads(l) for l in resp.text.splitlines() if l.strip()]


def test_normalizar():
    assert normalizar("  SQS 308  Bloco C ,  Asa Sul. ") == "sqs 308 bloco c, asa sul"
    assert normalizar("Rua Á") == normalizar("rua á")


def test_um_endereco_usa_cache(logado):
    GeocodificadorFalso.chamadas = 0
    r1 = logado.post("/api/geocodificar/um", json={"endereco": "SQS 308 Bloco C"}).json()
    r2 = logado.post("/api/geocodificar/um", json={"endereco": "  sqs 308   bloco c "}).json()
    assert r1["encontrado"] and r1["precisao"] == "alta" and r1["de_cache"] is False
    assert r2["de_cache"] is True and (r2["lat"], r2["lng"]) == (r1["lat"], r1["lng"])
    assert GeocodificadorFalso.chamadas == 1


def test_resultado_negativo_tambem_vai_para_cache(logado):
    GeocodificadorFalso.chamadas = 0
    for _ in range(2):
        r = logado.post("/api/geocodificar/um", json={"endereco": "Rua Inexistente 999"}).json()
        assert r["encontrado"] is False
    assert GeocodificadorFalso.chamadas == 1


def test_lote_em_streaming(logado):
    logado.post("/api/geocodificar/um", json={"endereco": "Endereço já em cache"})
    resp = logado.post("/api/geocodificar", json={"enderecos": ["Rua A 1", "Endereço já em cache", "Bairro Centro", "Inexistente"]})
    assert resp.status_code == 200 and resp.headers["content-type"].startswith("application/x-ndjson")
    linhas = _linhas(resp)
    assert linhas[0] == {"tipo": "inicio", "total": 4, "pendentes": 3}
    assert linhas[-1] == {"tipo": "fim"}
    resultados = {l["indice"]: l for l in linhas if l["tipo"] == "resultado"}
    assert set(resultados) == {0, 1, 2, 3}
    assert resultados[1]["de_cache"] is True and linhas[1]["indice"] == 1  # cache sai primeiro
    assert resultados[2]["precisao"] == "baixa" and resultados[2]["nivel"] == "bairro"
    assert resultados[3]["encontrado"] is False


def test_lote_respeita_max_paradas(logado):
    with SessionLocal() as db:
        db.get(Configuracao, 1).max_paradas = 2
        db.commit()
    r = logado.post("/api/geocodificar", json={"enderecos": ["a", "b", "c"]})
    assert r.status_code == 422 and "No máximo 2" in r.json()["detail"]


def test_desativada_bloqueia_provedor_mas_serve_cache(logado):
    logado.post("/api/geocodificar/um", json={"endereco": "Em cache"})
    with SessionLocal() as db:
        db.get(Configuracao, 1).geocodificacao_ativa = False
        db.commit()
    assert logado.post("/api/geocodificar/um", json={"endereco": "Em cache"}).status_code == 200
    r = logado.post("/api/geocodificar/um", json={"endereco": "Novo endereço"})
    assert r.status_code == 503 and "desativada" in r.json()["detail"]
    assert logado.post("/api/geocodificar", json={"enderecos": ["Em cache", "Outro novo"]}).status_code == 503


def test_exige_login(cliente):
    assert cliente.post("/api/geocodificar/um", json={"endereco": "x"}).status_code == 401


def test_validacao_texto(logado):
    assert logado.post("/api/geocodificar/um", json={"endereco": "   "}).status_code == 422
    assert logado.post("/api/geocodificar/um", json={"endereco": "x" * 301}).status_code == 422


def test_limpeza_do_cache():
    with SessionLocal() as db:
        db.add_all([
            CacheGeocodificacao(endereco_normalizado="velho", encontrado=False, criado_em=datetime.now(timezone.utc) - timedelta(days=31)),
            CacheGeocodificacao(endereco_normalizado="novo", encontrado=False),
        ])
        db.commit()
        assert limpar_cache(db) == 1
        assert db.get(CacheGeocodificacao, "novo") and not db.get(CacheGeocodificacao, "velho")


def test_nivel_por_rank():
    assert nivel_por_rank(30) == ("alta", "endereco")
    assert nivel_por_rank(28) == ("alta", "endereco")
    assert nivel_por_rank(26) == ("baixa", "rua")
    assert nivel_por_rank(20) == ("baixa", "bairro")
    assert nivel_por_rank(16) == ("baixa", "cidade")


def _nominatim_simulado(handler, intervalo=0.25):
    n = Nominatim("https://nominatim.exemplo", "contato@empresa.com", intervalo_s=intervalo)
    n.cliente = httpx.Client(transport=httpx.MockTransport(handler), headers=n.cliente.headers)
    return n


def test_nominatim_parametros_e_user_agent():
    vistos = []

    def handler(req):
        vistos.append(req)
        return httpx.Response(200, json=[{"lat": "-15.79", "lon": "-47.88", "place_rank": 30, "display_name": "Rodoviária"}])

    r = _nominatim_simulado(handler).buscar("Rodoviária do Plano Piloto")
    req = vistos[0]
    p = req.url.params
    assert req.url.path == "/search"
    assert p["q"] == "Rodoviária do Plano Piloto" and p["format"] == "jsonv2" and p["countrycodes"] == "br"
    assert p["limit"] == "1" and p["bounded"] == "0" and p["email"] == "contato@empresa.com"
    minlon, maxlat, maxlon, minlat = map(float, p["viewbox"].split(","))  # x1,y1,x2,y2 = lon,lat
    assert minlon < maxlon and minlat < maxlat
    assert req.headers["user-agent"].startswith("Rotear/") and "contato@empresa.com" in req.headers["user-agent"]
    assert (r.encontrado, r.precisao, r.nivel) == (True, "alta", "endereco")


def test_nominatim_fora_da_area_e_vazio():
    respostas = iter([
        [{"lat": "-23.55", "lon": "-46.63", "place_rank": 30, "display_name": "São Paulo"}],
        [],
    ])
    n = _nominatim_simulado(lambda req: httpx.Response(200, json=next(respostas)), intervalo=0)
    assert n.buscar("Av. Paulista 1000").nivel == "fora_da_area"
    assert n.buscar("nada").encontrado is False


def test_nominatim_limite_de_1_por_intervalo():
    n = _nominatim_simulado(lambda req: httpx.Response(200, json=[]), intervalo=0.25)
    inicio = time.monotonic()
    for _ in range(3):
        n.buscar("x")
    assert time.monotonic() - inicio >= 0.5  # 3 chamadas = pelo menos 2 intervalos


def test_nominatim_erros_viram_indisponivel():
    n = _nominatim_simulado(lambda req: httpx.Response(429), intervalo=0)
    with pytest.raises(GeocodificacaoIndisponivel):
        n.buscar("x")


def test_nominatim_exige_email(monkeypatch):
    monkeypatch.delenv("NOMINATIM_EMAIL", raising=False)
    with pytest.raises(GeocodificacaoIndisponivel, match="NOMINATIM_EMAIL"):
        Nominatim.do_ambiente()


def test_variantes_da_consulta():
    from app.geocodificacao.nominatim import variantes
    assert variantes("Congresso Nacional, Praça dos Três Poderes, Brasília - DF") == [
        "Congresso Nacional, Praça dos Três Poderes, Brasília - DF",
        "Congresso Nacional, Brasília, DF",
        "Congresso Nacional, DF",
    ]
    assert variantes("Rua A") == ["Rua A"]
    assert variantes("Parque X, Guará - DF") == ["Parque X, Guará - DF", "Parque X, Guará, DF", "Parque X, DF"]


def test_nominatim_tenta_variante_so_quando_nao_encontra():
    consultas = []

    def handler(req):
        consultas.append(req.url.params["q"])
        if req.url.params["q"] == "Congresso Nacional, Brasília, DF":
            return httpx.Response(200, json=[{"lat": "-15.80", "lon": "-47.86", "place_rank": 30, "display_name": "Congresso"}])
        return httpx.Response(200, json=[])

    n = _nominatim_simulado(handler, intervalo=0)
    assert n.buscar("Congresso Nacional, Praça dos Três Poderes, Brasília - DF").encontrado
    assert consultas == ["Congresso Nacional, Praça dos Três Poderes, Brasília - DF", "Congresso Nacional, Brasília, DF"]
    consultas.clear()
    assert n.buscar("Inexistente, Lugar, Nenhum - XX").encontrado is False
    assert len(consultas) == 3  # no máximo 2 tentativas extras
