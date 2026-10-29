from urllib.parse import parse_qs, urlsplit

from app.roteamento import Ponto
from app.roteamento.links import MAX_URL, trechos

PARTIDA = Ponto(-15.79, -47.88, None)


def _paradas(n, texto=True):
    return [Ponto(-15.70 - i / 1000, -47.90 - i / 1000, f"Endereço {i + 1}, Brasília - DF" if texto else None) for i in range(n)]


def _qs(url):
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}


def test_um_trecho_ate_10_entregas():
    t = trechos(PARTIDA, _paradas(10))
    assert len(t) == 1 and (t[0]["de"], t[0]["ate"]) == (0, 10)
    q = _qs(t[0]["url"])
    assert q["api"] == "1" and q["travelmode"] == "driving"
    assert q["origin"] == "-15.790000,-47.880000"  # partida sem texto -> coordenadas
    assert q["destination"] == "Endereço 10, Brasília - DF"
    assert len(q["waypoints"].split("|")) == 9


def test_divisao_em_trechos_encadeados():
    paradas = _paradas(25)
    t = trechos(PARTIDA, paradas)
    assert [(x["de"], x["ate"]) for x in t] == [(0, 10), (10, 20), (20, 25)]
    q1, q2, q3 = (_qs(x["url"]) for x in t)
    assert q2["origin"] == q1["destination"] == "Endereço 10, Brasília - DF"  # começa na última entrega do anterior
    assert q3["origin"] == q2["destination"] == "Endereço 20, Brasília - DF"
    assert q3["destination"] == "Endereço 25, Brasília - DF" and len(q3["waypoints"].split("|")) == 4
    for x in t:
        assert len(_qs(x["url"]).get("waypoints", "").split("|")) <= 9


def test_onze_entregas_segundo_trecho_sem_waypoints():
    t = trechos(PARTIDA, _paradas(11))
    assert len(t) == 2 and "waypoints" not in _qs(t[1]["url"])


def test_volta_a_partida():
    t = trechos(PARTIDA, _paradas(10), retorno=True)
    assert [(x["de"], x["ate"]) for x in t] == [(0, 10), (10, 11)]
    assert _qs(t[-1]["url"])["destination"] == "-15.790000,-47.880000" and t[-1]["volta_a_partida"]


def test_codificacao_pipe_e_virgula():
    url = trechos(PARTIDA, _paradas(3))[0]["url"]
    assert "%7C" in url and "%2C" in url and "|" not in url and " " not in url


def test_texto_longo_cai_para_coordenadas():
    longas = [Ponto(-15.7 - i / 100, -47.9, "Endereço muito comprido " * 12 + str(i)) for i in range(10)]
    t = trechos(PARTIDA, longas)
    assert len(t[0]["url"]) <= MAX_URL and t[0]["usa_texto"] is False
    assert _qs(t[0]["url"])["destination"] == "-15.790000,-47.900000"
    for x in trechos(PARTIDA, _paradas(40)):
        assert len(x["url"]) <= MAX_URL


def test_sem_paradas():
    assert trechos(PARTIDA, []) == []
