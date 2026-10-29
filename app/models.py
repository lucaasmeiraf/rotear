from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

PAPEIS = ("admin", "operador")
MODOS_PARTIDA = ("localizacao_atual", "endereco_fixo")


class Usuario(Base):
    __tablename__ = "usuarios"
    __table_args__ = (CheckConstraint(f"papel IN {PAPEIS}", name="ck_usuarios_papel"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True)  # sempre minúsculo
    nome: Mapped[str] = mapped_column(String(120))
    senha_hash: Mapped[str] = mapped_column(Text)
    papel: Mapped[str] = mapped_column(String(20))
    ativo: Mapped[bool] = mapped_column(default=True)
    falhas_login: Mapped[int] = mapped_column(default=0)
    bloqueado_ate: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Incrementada ao desativar ou redefinir a senha: invalida as sessões abertas
    sessao_versao: Mapped[int] = mapped_column(default=1)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Configuracao(Base):
    """Linha única (id = 1)."""

    __tablename__ = "configuracoes"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_configuracoes_linha_unica"),
        CheckConstraint(f"modo_partida IN {MODOS_PARTIDA}", name="ck_configuracoes_modo_partida"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    modo_partida: Mapped[str] = mapped_column(String(20), default="localizacao_atual")
    partida_endereco: Mapped[str | None] = mapped_column(Text)
    partida_lat: Mapped[float | None] = mapped_column(Float)
    partida_lng: Mapped[float | None] = mapped_column(Float)
    solver_tempo_limite_s: Mapped[int] = mapped_column(default=30)
    max_paradas: Mapped[int] = mapped_column(default=200)
    geocodificacao_ativa: Mapped[bool] = mapped_column(default=True)
    atualizado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class MetricaUso(Base):
    """Sem endereços: apenas números agregados de cada cálculo."""

    __tablename__ = "metricas_uso"

    id: Mapped[int] = mapped_column(primary_key=True)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    usuario_id: Mapped[int | None] = mapped_column(ForeignKey("usuarios.id", ondelete="SET NULL"))
    qtd_paradas: Mapped[int] = mapped_column(Integer)
    qtd_motoristas: Mapped[int] = mapped_column(Integer)
    km_total: Mapped[float] = mapped_column(Float)
    tempo_total_s: Mapped[int] = mapped_column(Integer)
    tempo_calculo_ms: Mapped[int] = mapped_column(Integer)


class CacheGeocodificacao(Base):
    """Endereço normalizado -> coordenadas. Sem nome de destinatário; limpo após 30 dias."""

    __tablename__ = "cache_geocodificacao"

    endereco_normalizado: Mapped[str] = mapped_column(Text, primary_key=True)
    encontrado: Mapped[bool] = mapped_column()
    lat: Mapped[float | None] = mapped_column(Float)
    lng: Mapped[float | None] = mapped_column(Float)
    tipo: Mapped[str | None] = mapped_column(String(60))  # classe/tipo do resultado (ex.: house, road, suburb)
    precisao: Mapped[str | None] = mapped_column(String(20))  # alta | media | baixa
    descricao: Mapped[str | None] = mapped_column(Text)  # display_name do provedor
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
