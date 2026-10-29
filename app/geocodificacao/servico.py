"""Cache de geocodificação (30 dias) na frente do provedor."""
import re
import unicodedata
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.geocodificacao import GeocodificacaoIndisponivel, Resultado, obter_geocodificador
from app.models import CacheGeocodificacao

VALIDADE_CACHE = timedelta(days=30)


def normalizar(endereco: str) -> str:
    """Chave do cache: Unicode NFKC, minúsculas, espaços e pontuação de borda uniformizados."""
    texto = unicodedata.normalize("NFKC", endereco).casefold()
    texto = re.sub(r"\s+", " ", texto)
    texto = re.sub(r"\s*,\s*", ", ", texto)
    return texto.strip(" ,;.-")


def do_cache(db: Session, chave: str) -> Resultado | None:
    item = db.get(CacheGeocodificacao, chave)
    if not item or item.criado_em < datetime.now(timezone.utc) - VALIDADE_CACHE:
        return None
    return Resultado(item.encontrado, item.lat, item.lng, item.precisao, item.tipo, item.descricao)


def geocodificar(db: Session, endereco: str, externo_permitido: bool) -> tuple[Resultado, bool]:
    """Retorna (resultado, veio_do_cache). Resultados negativos também vão para o cache."""
    chave = normalizar(endereco)
    if (r := do_cache(db, chave)) is not None:
        return r, True
    if not externo_permitido:
        raise GeocodificacaoIndisponivel("A geocodificação está desativada pelo administrador.")
    r = obter_geocodificador().buscar(endereco)
    item = db.get(CacheGeocodificacao, chave) or CacheGeocodificacao(endereco_normalizado=chave)
    item.encontrado, item.lat, item.lng = r.encontrado, r.lat, r.lng
    item.precisao, item.tipo, item.descricao = r.precisao, r.nivel, r.descricao
    item.criado_em = datetime.now(timezone.utc)
    db.add(item)
    db.commit()
    return r, False


def limpar_cache(db: Session) -> int:
    limite = datetime.now(timezone.utc) - VALIDADE_CACHE
    apagados = db.execute(delete(CacheGeocodificacao).where(CacheGeocodificacao.criado_em < limite)).rowcount
    db.commit()
    return apagados
