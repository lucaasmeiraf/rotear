"""Geocodificação atrás de uma interface trocável.

Provedores (variável GEOCODIFICADOR):
  - "nominatim" (padrão): Nominatim público ou próprio (NOMINATIM_URL). Exige NOMINATIM_EMAIL.
  - "falso": determinístico, sem rede; usado nos testes.

Política de uso do Nominatim público: https://operations.osmfoundation.org/policies/nominatim/
(no máximo 1 requisição/s, User-Agent próprio, resultados em cache, desligável sem atualizar o app).
"""
import os
from dataclasses import asdict, dataclass
from typing import Protocol


@dataclass
class Resultado:
    encontrado: bool
    lat: float | None = None
    lng: float | None = None
    precisao: str | None = None  # "alta" | "baixa"
    nivel: str | None = None  # "endereco" | "rua" | "bairro" | "cidade" | "fora_da_area"
    descricao: str | None = None

    def json(self) -> dict:
        return asdict(self)


class Geocodificador(Protocol):
    def buscar(self, endereco: str) -> Resultado: ...


class GeocodificacaoIndisponivel(Exception):
    """O provedor não está configurado ou não respondeu."""


def _bbox_regiao() -> tuple[float, float, float, float]:
    """Área coberta pelo OSRM: minlon,minlat,maxlon,maxlat."""
    valores = os.getenv("REGIAO_BBOX", "-48.6384,-17.3761,-46.8150,-14.5160").split(",")
    return tuple(float(v) for v in valores)  # type: ignore[return-value]


REGIAO_BBOX = _bbox_regiao()


def dentro_da_regiao(lat: float, lng: float) -> bool:
    minlon, minlat, maxlon, maxlat = REGIAO_BBOX
    return minlat <= lat <= maxlat and minlon <= lng <= maxlon


_instancia: Geocodificador | None = None


def obter_geocodificador() -> Geocodificador:
    global _instancia
    if _instancia is None:
        provedor = os.getenv("GEOCODIFICADOR", "nominatim")
        if provedor == "nominatim":
            from app.geocodificacao.nominatim import Nominatim
            _instancia = Nominatim.do_ambiente()
        elif provedor == "falso":
            from app.geocodificacao.falso import GeocodificadorFalso
            _instancia = GeocodificadorFalso()
        else:
            raise RuntimeError(f"GEOCODIFICADOR desconhecido: {provedor}")
    return _instancia
