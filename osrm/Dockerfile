# Imagem auxiliar, usada só no pré-processamento (scripts/preparar-osrm.sh).
FROM ghcr.io/project-osrm/osrm-backend:v26.10.0-debian

RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool python3 python3-shapely curl ca-certificates time \
 && rm -rf /var/lib/apt/lists/*

COPY vizinhos_df.py /usr/local/bin/vizinhos_df.py
