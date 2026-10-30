"""Matriz de tempos/distâncias, otimização (OR-Tools) e links do Google Maps."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Ponto:
    lat: float | None  # None = sem posição no mapa: só entra nos links, pelo texto
    lng: float | None
    texto: str | None = None  # endereço em texto (opcional): usado nos links quando couber
