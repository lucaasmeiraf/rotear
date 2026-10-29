# OSRM do Rotear (perfil carro, DF + municípios de GO vizinhos).
#
#   - alvo "ferramentas": osmium + python, usado pelo scripts/preparar-osrm.sh (compose, serviço osrm-prep)
#   - alvo final (padrão): servidor pronto, com os dados gerados no próprio build. É o que o Easypanel
#     constrói com Build Path = /osrm. Nenhum volume precisa ser copiado entre servidores.
ARG OSRM_IMAGE=ghcr.io/project-osrm/osrm-backend:v26.10.0-debian

FROM ${OSRM_IMAGE} AS ferramentas
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool python3 python3-shapely curl ca-certificates time \
 && rm -rf /var/lib/apt/lists/*
COPY vizinhos_df.py /usr/local/bin/vizinhos_df.py

FROM ferramentas AS dados
ARG PBF_URL=https://download.geofabrik.de/south-america/brazil/centro-oeste-latest.osm.pbf
WORKDIR /data
# Baixa o recorte Centro-Oeste (confere o MD5), recorta DF + entorno e prepara para o algoritmo MLD
RUN curl -fsSL -o centro-oeste.osm.pbf "$PBF_URL" \
 && curl -fsSL "$PBF_URL.md5" | sed 's/centro-oeste-latest/centro-oeste/' | md5sum -c - \
 && osmium tags-filter -o /tmp/limites.osm.pbf centro-oeste.osm.pbf r/boundary=administrative \
 && osmium export -f geojsonseq -o /tmp/limites.geojsonseq /tmp/limites.osm.pbf 2>/dev/null \
 && python3 /usr/local/bin/vizinhos_df.py /tmp/limites.geojsonseq > bbox.txt \
 && osmium extract -s simple -b "$(cat bbox.txt)" -o df-entorno.osm.pbf centro-oeste.osm.pbf \
 && rm -f centro-oeste.osm.pbf /tmp/limites.* \
 && osrm-extract -p /opt/car.lua df-entorno.osm.pbf \
 && osrm-partition df-entorno.osrm \
 && osrm-customize df-entorno.osrm \
 && rm -f df-entorno.osm.pbf \
 && chmod -R a+rX /data

FROM ${OSRM_IMAGE}
COPY --from=dados /data /data
USER 65534:65534
EXPOSE 5000
CMD ["osrm-routed", "--algorithm", "mld", "--max-table-size", "500", "/data/df-entorno.osrm"]
