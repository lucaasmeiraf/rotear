"""Divisão e ordenação das paradas com OR-Tools (sempre no modo de maior qualidade).

Nó 0 = ponto de partida; nós 1..n = paradas. Rota aberta (termina na última entrega) usa um nó final
fictício com custo zero vindo de qualquer parada.
"""
import math
from dataclasses import dataclass, field

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from app.roteamento.matriz import Matriz

INALCANCAVEL = 10**7  # custo (s) para pares sem rota: o solver os evita
PENALIDADE_DESCARTE = 10**9  # só descarta uma parada se for impossível atendê-la
PESO_EQUILIBRIO_S = 3600  # cada parada acima da média por motorista "custa" 1 h de direção (equilíbrio forte)

MOTIVO_SEM_ROTA = "Sem rota pelas ruas a partir do ponto de partida."
MOTIVO_LIMITE = "Excede o limite de paradas por motorista."


@dataclass
class Solucao:
    rotas: list[list[int]]  # por motorista: índices das paradas (0-based) em ordem
    nao_alocadas: dict[int, str] = field(default_factory=dict)  # índice -> motivo


def resolver(duracoes: Matriz, n_motoristas: int, max_por_motorista: int | None, retorno: bool, tempo_limite_s: int) -> Solucao:
    n = len(duracoes) - 1  # paradas
    nao_alocadas: dict[int, str] = {}

    # Paradas que não se ligam ao ponto de partida (ida e volta) ficam de fora antes do solver
    candidatas = [i for i in range(1, n + 1) if duracoes[0][i] is not None and duracoes[i][0] is not None]
    for i in range(1, n + 1):
        if i not in candidatas:
            nao_alocadas[i - 1] = MOTIVO_SEM_ROTA
    if not candidatas:
        return Solucao([[] for _ in range(n_motoristas)], nao_alocadas)

    nos = [0] + candidatas  # nó do solver -> nó da matriz
    m = len(nos)
    fim = m if not retorno else 0  # nó final fictício na rota aberta
    total_nos = m + (0 if retorno else 1)

    def custo(a: int, b: int) -> int:
        if not retorno and (a == fim or b == fim):
            return 0 if b == fim else INALCANCAVEL
        v = duracoes[nos[a]][nos[b]]
        return INALCANCAVEL if v is None else int(round(v))

    gerente = pywrapcp.RoutingIndexManager(total_nos, n_motoristas, [0] * n_motoristas, [fim] * n_motoristas)
    modelo = pywrapcp.RoutingModel(gerente)

    def transito(i, j):
        return custo(gerente.IndexToNode(i), gerente.IndexToNode(j))

    idx_custo = modelo.RegisterTransitCallback(transito)
    modelo.SetArcCostEvaluatorOfAllVehicles(idx_custo)

    # Contagem de paradas: limite rígido por motorista + limite suave para equilibrar
    def demanda(i):
        no = gerente.IndexToNode(i)
        return 0 if no in (0, fim) else 1

    idx_demanda = modelo.RegisterUnaryTransitCallback(demanda)
    capacidade = max_por_motorista if max_por_motorista else m
    modelo.AddDimensionWithVehicleCapacity(idx_demanda, 0, [capacidade] * n_motoristas, True, "paradas")
    if n_motoristas > 1:
        contagem = modelo.GetDimensionOrDie("paradas")
        media = math.ceil((m - 1) / n_motoristas)
        for v in range(n_motoristas):
            contagem.SetCumulVarSoftUpperBound(modelo.End(v), media, PESO_EQUILIBRIO_S)

    for no in range(1, m):
        modelo.AddDisjunction([gerente.NodeToIndex(no)], PENALIDADE_DESCARTE)

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.seconds = int(tempo_limite_s)

    solucao = modelo.SolveWithParameters(params)
    if solucao is None:
        raise RuntimeError("O otimizador não encontrou solução.")

    rotas: list[list[int]] = []
    atendidos = set()
    for v in range(n_motoristas):
        rota = []
        i = solucao.Value(modelo.NextVar(modelo.Start(v)))
        while not modelo.IsEnd(i):
            no = gerente.IndexToNode(i)
            rota.append(nos[no] - 1)
            atendidos.add(no)
            i = solucao.Value(modelo.NextVar(i))
        rotas.append(rota)
    for no in range(1, m):
        if no not in atendidos:
            nao_alocadas[nos[no] - 1] = MOTIVO_LIMITE
    return Solucao(rotas, nao_alocadas)
