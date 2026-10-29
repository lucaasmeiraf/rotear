"""Matriz de tempos/distâncias, otimização (OR-Tools) e links do Google Maps."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Ponto:
    lat: float
    lng: float
    texto: str | None = None  # endereço em texto (opcional): usado nos links quando couber
