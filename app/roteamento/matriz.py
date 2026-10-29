"""Provedores de matriz trocáveis pela variável PROVEDOR_MATRIZ: "osrm" (padrão) ou "haversine" (testes)."""
import math
import os
from typing import Protocol

import httpx

from app.roteamento import Ponto

# Matriz: valores None = sem rota entre os dois pontos
Matriz = list[list[float | None]]


class MatrizIndisponivel(Exception):
    pass


class ProvedorMatriz(Protocol):
    def matriz(self, pontos: list[Ponto]) -> tuple[Matriz, Matriz]:
        """Retorna (duracoes_s, distancias_m)."""

    def rota(self, pontos: list[Ponto]) -> tuple[float, float, list[list[float]]]:
        """Retorna (distancia_m, duracao_s, linha [[lat, lng], ...]) passando pelos pontos em ordem."""


def _coords(pontos: list[Ponto]) -> str:
    return ";".join(f"{p.lng:.6f},{p.lat:.6f}" for p in pontos)


class OSRM:
    def __init__(self, url: str, timeout_s: float = 60):
        self.url = url.rstrip("/")
        self.cliente = httpx.Client(timeout=timeout_s)

    def _get(self, caminho: str, params: dict) -> dict:
        try:
            resp = self.cliente.get(f"{self.url}{caminho}", params=params)
        except httpx.HTTPError as exc:
            raise MatrizIndisponivel("O serviço de rotas (OSRM) não respondeu.") from exc
        dados = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
        if resp.status_code != 200 or dados.get("code") != "Ok":
            raise MatrizIndisponivel(f"O serviço de rotas recusou a consulta ({dados.get('code', resp.status_code)}).")
        return dados

    def matriz(self, pontos):
        d = self._get(f"/table/v1/driving/{_coords(pontos)}", {"annotations": "duration,distance"})
        return d["durations"], d["distances"]

    def rota(self, pontos):
        d = self._get(f"/route/v1/driving/{_coords(pontos)}", {"overview": "full", "geometries": "geojson", "steps": "false"})
        r = d["routes"][0]
        return r["distance"], r["duration"], [[lat, lng] for lng, lat in r["geometry"]["coordinates"]]


class Haversine:
    """Linha reta x fator de desvio, a velocidade constante. Só para testes automatizados."""

    FATOR_DESVIO = 1.3
    VELOCIDADE_MS = 30 / 3.6

    @staticmethod
    def distancia(a: Ponto, b: Ponto) -> float:
        r = 6_371_000
        f1, f2 = math.radians(a.lat), math.radians(b.lat)
        df, dl = f2 - f1, math.radians(b.lng - a.lng)
        h = math.sin(df / 2) ** 2 + math.cos(f1) * math.cos(f2) * math.sin(dl / 2) ** 2
        return 2 * r * math.asin(math.sqrt(h)) * Haversine.FATOR_DESVIO

    def matriz(self, pontos):
        dist = [[self.distancia(a, b) for b in pontos] for a in pontos]
        return [[d / self.VELOCIDADE_MS for d in linha] for linha in dist], dist

    def rota(self, pontos):
        dist = sum(self.distancia(a, b) for a, b in zip(pontos, pontos[1:]))
        return dist, dist / self.VELOCIDADE_MS, [[p.lat, p.lng] for p in pontos]


def obter_provedor() -> ProvedorMatriz:
    nome = os.getenv("PROVEDOR_MATRIZ", "osrm")
    if nome == "osrm":
        return OSRM(os.getenv("OSRM_URL", "http://osrm:5000"))
    if nome == "haversine":
        return Haversine()
    raise RuntimeError(f"PROVEDOR_MATRIZ desconhecido: {nome}")
