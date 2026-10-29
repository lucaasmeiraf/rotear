from app.roteamento import Ponto
from app.roteamento.matriz import Haversine
from app.roteamento.solver import MOTIVO_LIMITE, MOTIVO_SEM_ROTA, resolver

PARTIDA = Ponto(-15.80, -47.90)
# Dois grupos: A perto da partida (leste), B longe (oeste). Paradas embaralhadas na entrada.
GRUPO_A = [Ponto(-15.80 + d, -47.85 + d) for d in (0.000, 0.004, 0.008, 0.012)]
GRUPO_B = [Ponto(-15.80 + d, -48.10 + d) for d in (0.000, 0.004, 0.008, 0.012)]
PARADAS = [GRUPO_A[0], GRUPO_B[2], GRUPO_A[3], GRUPO_B[0], GRUPO_A[1], GRUPO_B[3], GRUPO_A[2], GRUPO_B[1]]
DO_GRUPO_A = {i for i, p in enumerate(PARADAS) if p in GRUPO_A}


def _matriz(pontos):
    return Haversine().matriz(pontos)[0]


def _custo(dur, rota, retorno=False):
    seq = [0] + [i + 1 for i in rota] + ([0] if retorno else [])
    return sum(dur[a][b] for a, b in zip(seq, seq[1:]))


def test_um_motorista_agrupa_enderecos_proximos():
    dur = _matriz([PARTIDA, *PARADAS])
    s = resolver(dur, 1, None, False, 1)
    rota = s.rotas[0]
    assert sorted(rota) == list(range(8)) and not s.nao_alocadas
    grupos = ["A" if i in DO_GRUPO_A else "B" for i in rota]
    assert grupos == ["A"] * 4 + ["B"] * 4  # visita o grupo próximo inteiro, depois o distante
    assert _custo(dur, rota) < _custo(dur, list(range(8))) * 0.6  # bem melhor que a ordem de entrada


def test_volta_a_partida_considera_retorno():
    dur = _matriz([PARTIDA, *PARADAS])
    aberta = resolver(dur, 1, None, False, 1).rotas[0]
    fechada = resolver(dur, 1, None, True, 1).rotas[0]
    assert _custo(dur, fechada, True) <= _custo(dur, aberta, True) + 1


def test_dois_motoristas_equilibrados_e_separados_por_grupo():
    dur = _matriz([PARTIDA, *PARADAS])
    s = resolver(dur, 2, None, False, 1)
    assert sorted(len(r) for r in s.rotas) == [4, 4]
    for r in s.rotas:
        assert {i in DO_GRUPO_A for i in r} in ({True}, {False})  # cada motorista fica num grupo


def test_limite_por_motorista_gera_nao_alocadas():
    dur = _matriz([PARTIDA, *PARADAS])
    s = resolver(dur, 1, 5, False, 1)
    assert len(s.rotas[0]) == 5 and len(s.nao_alocadas) == 3
    assert set(s.nao_alocadas.values()) == {MOTIVO_LIMITE}


def test_parada_sem_rota_fica_de_fora():
    dur = _matriz([PARTIDA, *PARADAS])
    dur[0][3] = None  # parada índice 2 sem rota a partir da partida
    s = resolver(dur, 1, None, False, 1)
    assert s.nao_alocadas == {2: MOTIVO_SEM_ROTA} and 2 not in s.rotas[0] and len(s.rotas[0]) == 7


def test_uma_parada():
    s = resolver(_matriz([PARTIDA, PARADAS[0]]), 3, None, False, 1)
    assert sum(len(r) for r in s.rotas) == 1


def test_dois_motoristas_grupos_desiguais_ficam_equilibrados():
    # 3 paradas num grupo e 8 no outro: o equilíbrio deve aproximar 6/5 em vez de 3/8
    a = [Ponto(-15.80 + d / 1000, -47.85) for d in range(3)]
    b = [Ponto(-15.80 + d / 1000, -48.10) for d in range(8)]
    dur = _matriz([PARTIDA, *a, *b])
    s = resolver(dur, 2, None, False, 2)
    assert sorted(len(r) for r in s.rotas) == [5, 6]
