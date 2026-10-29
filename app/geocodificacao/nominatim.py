import os
import threading
import time

import httpx

from app.geocodificacao import GeocodificacaoIndisponivel, Resultado, REGIAO_BBOX, dentro_da_regiao

VERSAO = "1.0"


class _Limitador:
    """Garante um intervalo mínimo entre requisições, somando todos os usuários (1 worker)."""

    def __init__(self, intervalo_s: float):
        self.intervalo = intervalo_s
        self._lock = threading.Lock()
        self._ultima = 0.0

    def aguardar(self) -> None:
        with self._lock:
            espera = self._ultima + self.intervalo - time.monotonic()
            if espera > 0:
                time.sleep(espera)
            self._ultima = time.monotonic()


def nivel_por_rank(rank: int) -> tuple[str, str]:
    """place_rank do Nominatim -> (precisao, nivel). Ver docs 'customize/Ranking'."""
    if rank >= 28:  # número de casa, edifício, ponto de interesse (28 = interpolação de numeração)
        return "alta", "endereco"
    if rank >= 26:  # rua
        return "baixa", "rua"
    if rank >= 17:  # bairro, quadra, localidade
        return "baixa", "bairro"
    return "baixa", "cidade"


def variantes(endereco: str) -> list[str]:
    """Consulta original e, para quando nada for encontrado, versões mais curtas.

    O Nominatim costuma falhar quando há um trecho intermediário (rua, setor) junto do nome do local:
    "Congresso Nacional, Praça dos Três Poderes, Brasília - DF" não acha nada; "Congresso Nacional, Brasília, DF" acha.
    """
    partes = [p.strip() for p in endereco.replace(" - ", ", ").split(",") if p.strip()]
    lista = [endereco]
    if len(partes) >= 3:
        lista.append(", ".join([partes[0], *partes[-2:]]))  # local, cidade, UF
    if len(partes) >= 2:
        lista.append(", ".join([partes[0], partes[-1]]))  # local, UF
    unicas = []
    for v in lista:
        if v not in unicas:
            unicas.append(v)
    return unicas


class Nominatim:
    def __init__(self, url: str, email: str, intervalo_s: float = 1.1, timeout_s: float = 10):
        self.url = url.rstrip("/")
        self.email = email
        self.limitador = _Limitador(intervalo_s)
        self.cliente = httpx.Client(
            timeout=timeout_s,
            headers={"User-Agent": f"Rotear/{VERSAO} (planejador de rotas de entrega; contato: {email})"},
        )

    @classmethod
    def do_ambiente(cls) -> "Nominatim":
        email = os.getenv("NOMINATIM_EMAIL", "").strip()
        if not email:
            raise GeocodificacaoIndisponivel(
                "Geocodificação não configurada: defina NOMINATIM_EMAIL no .env (veja o README)."
            )
        return cls(os.getenv("NOMINATIM_URL", "https://nominatim.openstreetmap.org"), email)

    def buscar(self, endereco: str) -> Resultado:
        """Tenta a consulta original e, só se nada for encontrado, as variantes mais curtas (cada uma respeita o limitador)."""
        for consulta in variantes(endereco):
            resultado = self._consultar(consulta)
            if resultado.encontrado:
                return resultado
        return Resultado(encontrado=False)

    def _consultar(self, endereco: str) -> Resultado:
        minlon, minlat, maxlon, maxlat = REGIAO_BBOX
        params = {
            "q": endereco,
            "format": "jsonv2",
            "countrycodes": "br",
            "limit": 1,
            "viewbox": f"{minlon},{maxlat},{maxlon},{minlat}",  # prioriza a região, sem excluir o resto
            "bounded": 0,
            "accept-language": "pt-BR",
            "email": self.email,
        }
        self.limitador.aguardar()
        try:
            resp = self.cliente.get(f"{self.url}/search", params=params)
        except httpx.HTTPError as exc:
            raise GeocodificacaoIndisponivel("O serviço de geocodificação não respondeu. Tente novamente.") from exc
        if resp.status_code in (403, 429):
            raise GeocodificacaoIndisponivel("O serviço de geocodificação recusou a consulta (limite de uso). Aguarde e tente de novo.")
        if resp.status_code != 200:
            raise GeocodificacaoIndisponivel(f"O serviço de geocodificação respondeu com erro {resp.status_code}.")
        dados = resp.json()
        if not dados:
            return Resultado(encontrado=False)
        r = dados[0]
        lat, lng = float(r["lat"]), float(r["lon"])
        precisao, nivel = nivel_por_rank(int(r.get("place_rank", 0)))
        if not dentro_da_regiao(lat, lng):
            precisao, nivel = "baixa", "fora_da_area"
        return Resultado(True, lat, lng, precisao, nivel, r.get("display_name"))
