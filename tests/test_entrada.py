import io
import zipfile

import pytest
from openpyxl import Workbook

from app.entrada import ArquivoInvalido, ler_planilha, sugerir_mapeamento
from tests.conftest import login


def _xlsx(linhas):
    wb = Workbook()
    for l in linhas:
        wb.active.append(l)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_sugestao_de_colunas():
    s = sugerir_mapeamento(["Nome do Cliente", "Endereço", "Nº", "Complemento", "Bairro", "Município", "UF", "CEP", "Qtd"])
    assert s["endereco"] == 1 and s["numero"] == 2 and s["complemento"] == 3 and s["bairro"] == 4
    assert s["cidade"] == 5 and s["uf"] == 6 and s["cep"] == 7 and s["volumes"] == 8
    assert s["referencia"] is None  # "Nome do Cliente" não é igual a nenhum sinônimo
    assert sugerir_mapeamento(["Cliente", "Rua"])["referencia"] == 0


def test_csv_ponto_e_virgula_e_latin1():
    conteudo = "Endereço;Número;Cidade\nSQS 308 Bloco C;12;Brasília\nQNM 34;5;Ceilândia\n".encode("cp1252")
    r = ler_planilha("entregas.csv", conteudo)
    assert r["colunas"] == ["Endereço", "Número", "Cidade"]
    assert r["linhas"][0] == ["SQS 308 Bloco C", "12", "Brasília"] and len(r["linhas"]) == 2
    assert r["sugestao"]["endereco"] == 0 and r["sugestao"]["numero"] == 1


def test_csv_virgula_utf8_bom():
    r = ler_planilha("a.csv", "﻿endereco,cep\n\"Rua A, 10\",70000-000\n".encode())
    assert r["colunas"] == ["endereco", "cep"] and r["linhas"] == [["Rua A, 10", "70000-000"]]


def test_xlsx_numeros_e_linhas_vazias():
    r = ler_planilha("a.xlsx", _xlsx([["Endereço", "CEP", None], [None, None, None], ["Rua B", 70040.0, None]]))
    assert r["colunas"] == ["Endereço", "CEP"] and r["linhas"] == [["Rua B", "70040"]]


@pytest.mark.parametrize("nome,conteudo,msg", [
    ("a.pdf", b"%PDF", ".xlsx ou .csv"),
    ("a.xlsx", b"nao sou zip", "não é uma planilha"),
    ("a.csv", b"", "vazio"),
    ("a.csv", b"so,cabecalho\n", "pelo menos uma linha"),
    ("a.csv", b"\x00\x01\x02binario", "não parece"),
    ("a.csv", b"x" * (5 * 1024 * 1024 + 1), "5 MB"),
])
def test_arquivos_invalidos(nome, conteudo, msg):
    with pytest.raises(ArquivoInvalido, match=msg):
        ler_planilha(nome, conteudo)


def test_xlsx_bomba_recusado():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/grande.xml", b"0" * (70 * 1024 * 1024))
    with pytest.raises(ArquivoInvalido, match="grande demais"):
        ler_planilha("a.xlsx", buf.getvalue())


def test_endpoint_upload(cliente, criar_usuario):
    criar_usuario()
    login(cliente, "op@teste.com")
    r = cliente.post("/api/entrada/arquivo", files={"arquivo": ("e.csv", b"endereco\nRua 1\nRua 2\n", "text/csv")})
    assert r.status_code == 200 and len(r.json()["linhas"]) == 2
    r = cliente.post("/api/entrada/arquivo", files={"arquivo": ("e.txt", b"x", "text/plain")})
    assert r.status_code == 422
    grande = b"endereco\n" + b"x" * (6 * 1024 * 1024)
    r = cliente.post("/api/entrada/arquivo", files={"arquivo": ("e.csv", grande, "text/csv")})
    assert r.status_code == 413
