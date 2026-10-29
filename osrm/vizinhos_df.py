"""Calcula a bounding box do DF + municípios de Goiás que fazem divisa com o DF.

Entrada: GeoJSON Sequence exportado pelo `osmium export` com os limites administrativos.
Saída (stdout): "minlon,minlat,maxlon,maxlat". Os municípios encontrados vão para stderr.
"""
import json
import sys

from shapely.geometry import shape
from shapely.ops import unary_union

MARGEM_GRAUS = 0.02  # ~2 km de folga em volta da área


def carregar(caminho):
    with open(caminho, encoding="utf-8") as f:
        for linha in f:
            linha = linha.strip().lstrip("\x1e")
            if linha:
                yield json.loads(linha)


feicoes = [f for f in carregar(sys.argv[1]) if f["geometry"]["type"] in ("Polygon", "MultiPolygon")]


def unica(nivel, nome):
    achadas = [f for f in feicoes if f["properties"].get("admin_level") == nivel and f["properties"].get("name") == nome]
    if len(achadas) != 1:
        sys.exit(f"esperava 1 limite '{nome}' (admin_level={nivel}), achei {len(achadas)}")
    return shape(achadas[0]["geometry"])


df = unica("4", "Distrito Federal")
go = unica("4", "Goiás")
divisa = df.buffer(0.001)

vizinhos = []
for f in feicoes:
    if f["properties"].get("admin_level") != "8":
        continue
    geom = shape(f["geometry"])
    if geom.intersects(divisa) and go.contains(geom.representative_point()):
        vizinhos.append((f["properties"].get("name", "?"), geom))

if not vizinhos:
    sys.exit("nenhum município de Goiás vizinho ao DF encontrado")

for nome, _ in sorted(vizinhos):
    print(f"  - {nome} (GO)", file=sys.stderr)

minx, miny, maxx, maxy = unary_union([df] + [g for _, g in vizinhos]).bounds
print(f"{minx - MARGEM_GRAUS:.4f},{miny - MARGEM_GRAUS:.4f},{maxx + MARGEM_GRAUS:.4f},{maxy + MARGEM_GRAUS:.4f}")
