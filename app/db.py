from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app import config


def url_sqlalchemy(url: str) -> str:
    """postgresql://... ou postgres://... (formato do Easypanel) -> postgresql+psycopg://... (driver psycopg 3)."""
    for prefixo in ("postgresql://", "postgres://"):
        if url.startswith(prefixo):
            return "postgresql+psycopg://" + url[len(prefixo):]
    return url


engine = create_engine(url_sqlalchemy(config.DATABASE_URL), pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    with SessionLocal() as db:
        yield db
