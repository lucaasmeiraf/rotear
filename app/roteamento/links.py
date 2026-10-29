"""Links do Google Maps (Maps URLs, sem chave): https://developers.google.com/maps/documentation/urls/get-started

Limites: no máximo 9 waypoints por link e 2.048 caracteres por URL. O trajeto completo é dividido em
trechos sequenciais: o trecho 1 vai da partida até a 10ª entrega; cada trecho seguinte começa na última
entrega do anterior.
"""
from urllib.parse import quote

from app.roteamento import Ponto

BASE = "https://www.google.com/maps/dir/?api=1"
MAX_WAYPOINTS = 9
MAX_URL = 2048
POR_TRECHO = MAX_WAYPOINTS + 1  # entregas novas por trecho


def _coord(p: Ponto) -> str:
    return f"{p.lat:.6f},{p.lng:.6f}"


def _montar(origem: str, destino: str, waypoints: list[str]) -> str:
    enc = lambda s: quote(s, safe="")  # noqa: E731  (vírgula -> %2C, barra vertical -> %7C)
    url = f"{BASE}&origin={enc(origem)}&destination={enc(destino)}"
    if waypoints:
        url += "&waypoints=" + enc("|".join(waypoints))
    return url + "&travelmode=driving"


def montar_link(pontos: list[Ponto]) -> tuple[str, bool]:
    """pontos = [origem, *waypoints, destino]. Usa texto se couber em 2.048 caracteres; senão, coordenadas.
    Retorna (url, usou_texto)."""
    if len(pontos) - 2 > MAX_WAYPOINTS:
        raise ValueError("Trecho com mais de 9 waypoints.")
    textos = [p.texto or _coord(p) for p in pontos]
    url = _montar(textos[0], textos[-1], textos[1:-1])
    if len(url) <= MAX_URL and any(p.texto for p in pontos):
        return url, True
    return _montar(_coord(pontos[0]), _coord(pontos[-1]), [_coord(p) for p in pontos[1:-1]]), False


def trechos(partida: Ponto, paradas: list[Ponto], retorno: bool = False) -> list[dict]:
    """Divide o trajeto completo de um motorista em links sequenciais."""
    seq = [partida, *paradas] + ([partida] if retorno else [])
    if len(seq) < 2:
        return []
    resultado = []
    inicio = 0
    while inicio < len(seq) - 1:
        fim = min(inicio + POR_TRECHO, len(seq) - 1)
        url, usou_texto = montar_link(seq[inicio:fim + 1])
        resultado.append({
            "url": url,
            "de": inicio,  # posição na sequência (0 = partida; k = k-ésima entrega)
            "ate": fim,
            "usa_texto": usou_texto,
            "volta_a_partida": retorno and fim == len(seq) - 1,
        })
        inicio = fim
    return resultado
