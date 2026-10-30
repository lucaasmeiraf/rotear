import os
import re
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


MAX_TENTATIVAS = 6  # cada tentativa custa 1 s (limite do Nominatim); só endereços difíceis usam todas

# Trechos que o OpenStreetMap quase nunca tem e que fazem a busca inteira falhar
_CEP = re.compile(r"\b(?:cep:?\s*)?\d{5}-?\d{3}\b", re.I)
_DETALHE = re.compile(r"\b(?:lote|lt|casa|cs|apto|apt|ap|apartamento|sala|loja|kitnet|kit|fundos|frente)\b\.?\s*(?:\d+[a-z]?\b|[a-z]\b)?",
                      re.I)
_NUMERO = re.compile(r"\b(?:n[º°o]|num|número)\b\.?\s*", re.I)
_ZEROS = re.compile(r"\b0+(\d)")


def _partes(texto: str) -> list[str]:
    return [" ".join(p.split()) for p in texto.replace(" - ", ", ").split(",") if p.strip(" .")]


def limpar(endereco: str) -> str:
    """Remove CEP, lote/casa/apto e zeros à esquerda: "Riacho Fundo I, AC 02 Lote 1" -> "Riacho Fundo I, AC 2"."""
    texto = _ZEROS.sub(r"\1", _NUMERO.sub(", ", _DETALHE.sub("", _CEP.sub("", endereco))))
    return ", ".join(p for p in _partes(texto) if p.strip(" .-"))


def variantes(endereco: str) -> list[tuple[str, bool]]:
    """Consultas em ordem, como (texto, só_dentro_da_região), até achar algo.

    1. O texto original.
    2. O mesmo sem CEP, lote, casa, apto etc., e versões mais curtas: o Nominatim exige que todas as palavras
       existam, então um trecho intermediário faz falhar ("Congresso Nacional, Praça dos Três Poderes, Brasília - DF"
       não acha nada; "Congresso Nacional, Brasília, DF" acha).
    3. Último recurso: cada trecho sozinho, só dentro da região, para achar ao menos o bairro ou a cidade. Nomes sem
       número vêm primeiro ("Lago Sul", "Riacho Fundo I"), porque códigos como "AC 2" se repetem em várias cidades.
    """
    lista: list[tuple[str, bool]] = []
    vistas: set[str] = set()

    def incluir(consulta: str, restrita: bool = False) -> None:
        chave = ", ".join(_partes(consulta)).casefold()
        if chave and chave not in vistas:
            vistas.add(chave)
            lista.append((consulta, restrita))

    incluir(endereco)
    limpo = limpar(endereco)
    partes = _partes(limpo)
    incluir(limpo)
    if len(partes) >= 3:
        incluir(", ".join([partes[0], *partes[-2:]]))  # local, cidade, UF
    if len(partes) >= 2:
        incluir(", ".join([partes[0], partes[-1]]))  # local, UF
    trechos = [p for p in partes if len(p) > 2]  # "DF" sozinho não ajuda
    for parte in sorted(trechos, key=lambda p: any(c.isdigit() for c in p)):
        incluir(parte, restrita=True)
    return lista[:MAX_TENTATIVAS]


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
        for consulta, restrita in variantes(endereco):
            resultado = self._consultar(consulta, restrita)
            if resultado.encontrado:
                return resultado
        return Resultado(encontrado=False)

    def _consultar(self, endereco: str, restrita: bool = False) -> Resultado:
        minlon, minlat, maxlon, maxlat = REGIAO_BBOX
        params = {
            "q": endereco,
            "format": "jsonv2",
            "countrycodes": "br",
            "limit": 1,
            "viewbox": f"{minlon},{maxlat},{maxlon},{minlat}",  # prioriza a região, sem excluir o resto
            "bounded": 1 if restrita else 0,
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
        if restrita:  # achou só um pedaço do endereço
            precisao = "baixa"
        if not dentro_da_regiao(lat, lng):
            precisao, nivel = "baixa", "fora_da_area"
        return Resultado(True, lat, lng, precisao, nivel, r.get("display_name"))
