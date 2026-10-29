#!/usr/bin/env bash
# Pré-processa os dados do OSRM (roda uma única vez, ou para atualizar o mapa).
#   1. baixa o recorte Centro-Oeste do Geofabrik (e confere o MD5)
#   2. calcula a bounding box do DF + municípios de GO que fazem divisa com o DF
#   3. recorta essa área com osmium extract (estratégia "simple": ~2 GB de RAM; a padrão passa de 3 GB)
#   4. osrm-extract (perfil carro) -> osrm-partition -> osrm-customize (algoritmo MLD)
# Cada etapa roda com limite de 3 GB de RAM; se passar disso, o container é morto e o script para.
# Uso (na pasta do projeto): scripts/preparar-osrm.sh [--baixar]
set -euo pipefail

cd "$(dirname "$0")/.."
URL="https://download.geofabrik.de/south-america/brazil/centro-oeste-latest.osm.pbf"

prep() { docker compose --profile prep run --rm -T osrm-prep "$@"; }

# Executa um comando medindo o pico de memória (RSS) e o tempo
medir() {
  local etapa="$1"; shift
  echo "==> $etapa"
  if ! prep bash -c 'set -o pipefail; /usr/bin/time -f "    pico RSS: %M KB | tempo: %e s" "$@" 2>&1 | grep -vE "^\[info\]|^\[warn\]" | tail -5 && echo "    pico do container (cgroup, inclui cache): $(( $(cat /sys/fs/cgroup/memory.peak) / 1048576 )) MB"' _ "$@"; then
    echo "ERRO na etapa '$etapa' (código $?). Se foi morto por memória, a etapa precisa de mais de 3 GB." >&2
    exit 1
  fi
}

docker compose --profile prep build osrm-prep

# Baixa só se ainda não existir (use --baixar para forçar a atualização do mapa)
if [[ "${1:-}" == "--baixar" ]] || ! prep test -f /data/centro-oeste.osm.pbf; then
  echo "==> Baixando $(basename "$URL") (o Geofabrik pode ser lento: ~15 min)"
  prep sh -c "cd /data && curl -fsSL -o centro-oeste.osm.pbf '$URL' && curl -fsSL '$URL.md5' | sed 's/centro-oeste-latest/centro-oeste/' | md5sum -c -"
else
  echo "==> Usando centro-oeste.osm.pbf já baixado"
fi

echo "==> Calculando a área (DF + municípios de GO vizinhos)"
BBOX=$(prep sh -c '
  cd /data &&
  osmium tags-filter -O -o /tmp/limites.osm.pbf centro-oeste.osm.pbf r/boundary=administrative >/dev/null &&
  osmium export -O -f geojsonseq -o /tmp/limites.geojsonseq /tmp/limites.osm.pbf 2>/dev/null &&
  python3 /usr/local/bin/vizinhos_df.py /tmp/limites.geojsonseq' | tail -1)
echo "    bbox: $BBOX"

medir "osmium extract (recorte)" osmium extract -O -s simple -b "$BBOX" -o /data/df-entorno.osm.pbf /data/centro-oeste.osm.pbf
medir "osrm-extract" osrm-extract -p /opt/car.lua /data/df-entorno.osm.pbf
medir "osrm-partition" osrm-partition /data/df-entorno.osrm
medir "osrm-customize" osrm-customize /data/df-entorno.osrm

prep sh -c 'echo "$1" > /data/bbox.txt && chmod -R a+rX /data && echo "==> Disco:" && du -sh /data/centro-oeste.osm.pbf /data/df-entorno.osm.pbf && du -ch /data/df-entorno.osrm* | tail -1' _ "$BBOX"
echo "Pronto. Suba o serviço com: docker compose up -d osrm"
