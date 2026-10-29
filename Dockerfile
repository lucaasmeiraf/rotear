FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

RUN groupadd --system --gid 1000 app \
 && useradd --system --uid 1000 --gid app --no-create-home app

COPY requirements.txt requirements-dev.txt ./
# DEV=1 (compose.dev.yml) instala também as dependências de teste
ARG DEV=0
RUN pip install -r requirements.txt \
 && if [ "$DEV" = "1" ]; then pip install -r requirements-dev.txt; fi

COPY alembic.ini start.sh ./
COPY alembic ./alembic
COPY app ./app

USER app
EXPOSE 8000

CMD ["./start.sh"]
