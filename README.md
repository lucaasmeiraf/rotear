# Rotear

Planejador automático de rotas de entrega. A pessoa informa os endereços do dia e o sistema faz o resto:
- divide as paradas entre os motoristas;
- ordena a rota de cada um, agrupando endereços próximos para reduzir km e tempo;
- gera os links do Google Maps com o trajeto completo, em trechos.

Custo zero: sem APIs pagas nem chaves.

| Item | Valor |
|---|---|
| App (dev) | http://localhost:8001, pelo túnel SSH |
| Postgres (só em dev) | 127.0.0.1:8002 |
| OSRM (só em dev) | 127.0.0.1:8003 |
| Health check | `GET /health`: testa o banco e o OSRM |

**Stack:**
- **Backend:** FastAPI, com migrações Alembic e Postgres 16.
- **Frontend:** Jinja2 + JavaScript simples, servido pelo próprio FastAPI e pensado primeiro para celular.
- **Mapa:** Leaflet 1.9.4, servido localmente, com tiles do OpenStreetMap.
- **Geocodificação:** Nominatim.
- **Ruas, distâncias e tempos:** OSRM self-hosted (DF e entorno).
- **Otimização:** Google OR-Tools 9.15.

## Subir do zero

```bash
cp .env.example .env                  # o novo-projeto.sh já faz isso, com uma senha aleatória
# preencha SECRET_KEY (openssl rand -hex 32) e, se for usar o Nominatim, NOMINATIM_EMAIL
scripts/preparar-osrm.sh              # uma vez: mapa de ruas do DF e entorno (veja "OSRM")
docker compose up -d --build
curl http://127.0.0.1:8001/health
```

Para parar, use `docker compose down`. O volume do banco é mantido; `down -v` apaga os dados.

## Primeiro acesso (criar o admin)

Não há cadastro público. Crie o primeiro administrador pela linha de comando; a senha será pedida no terminal e precisa ter pelo menos 10 caracteres:

```bash
docker compose exec api python -m app.cli criar-admin --email voce@empresa.com --nome "Seu Nome"
```

Depois, acesse `http://localhost:8001` pelo túnel SSH. O cookie de sessão é `Secure`, e o navegador só o aceita em HTTPS ou em `localhost`; pelo IP da VPS o login não funciona.

## Como usar

O planejamento tem 2 telas e funciona igual no celular e no computador:

1. **Endereços:** a partida é automática (endereço fixo definido pelo admin, ou a localização do aparelho, pedida só na primeira vez). Os endereços entram por **Colar** (padrão: um por linha), **Planilha** (`.xlsx`/`.csv`, com mapeamento de colunas e sugestão automática; linhas com o mesmo endereço viram uma parada só) ou **Digitar**. O botão **Baixar modelo** entrega a planilha padrão (`app/static/modelos/modelo-entregas.xlsx`: Cliente, Telefone, E-mail, Endereço completo, Pedido, Volumes e Observações), reconhecida sem ajustar colunas; para gerá-la de novo, rode `exemplos/gerar_modelo.py`. Na mesma tela: quantos motoristas e, recolhido em "Mais opções", o máximo de paradas por motorista e se a rota volta à partida. Um botão: **Calcular rotas**.
2. **Rotas:** mapa com uma cor por motorista e paradas numeradas; km e tempo pelo OSRM; trechos do Google Maps com botão de copiar; WhatsApp para o motorista, com a lista de paradas, cliente, telefone e observações; na ordem das paradas, botões **Ligar** e **WhatsApp** do cliente (o WhatsApp usa o celular da célula); exportação `.xlsx`.

**Nenhum endereço trava o cálculo nem fica de fora.** A localização roda em segundo plano assim que os endereços entram (1 consulta por segundo; o que está em cache é instantâneo). Se o endereço exato não é encontrado, a busca tenta versões mais simples (sem CEP, lote, casa, apto; depois cada trecho sozinho, só dentro da região) e usa a quadra ou região só para decidir a ordem: o pino fica **vazado** ("posição aproximada"). Se nada é encontrado, a parada vai para o fim da rota mais curta, fica de fora do mapa e do km, e entra no link do Google Maps pelo texto. Os links sempre levam o endereço escrito, então o Google Maps encontra a porta.

Nada do planejamento é salvo: os endereços vivem só na página aberta, e o navegador avisa antes de sair. Fica gravada só uma linha de métrica, sem endereços.

Para teste manual, use as planilhas de exemplo em `exemplos/entregas-exemplo.xlsx` e `.csv`: 30 locais públicos do DF e entorno, sem nomes de pessoas. Para gerá-las de novo, rode `exemplos/gerar_planilha.py`.

### Cálculo
- Matriz de tempo e distância pelo OSRM (`/table`), com uma parada por endereço mais a partida. Os testes usam `PROVEDOR_MATRIZ=haversine`.
- **OR-Tools:** solução inicial `PATH_CHEAPEST_ARC` mais `GUIDED_LOCAL_SEARCH`, sempre. Essa metaheurística usa o tempo dado inteiro, então o tempo depende do tamanho: até 15 paradas, 1 s; até 40, 5 s; acima, o limite do admin (padrão 30 s). Em testes de 2026-10-30, 1 s e 30 s deram a mesma rota até 15 paradas e menos de 1% de diferença com 30 paradas e 1 motorista (faixas em `FAIXAS_TEMPO_S`, `app/roteamento/solver.py`).
- **Objetivo:** minimizar o tempo total de direção. Com mais de um motorista, cada parada acima da média por motorista custa o equivalente a 1 h, o que equilibra a divisão.
- **Paradas sem posição confiável** (não localizadas, fora da área ou sem rota pelas ruas) não entram na otimização: vão para o fim da rota com menos paradas e para o link pelo texto (`sem_posicao` na resposta). Só fica como **não alocada** o que passar do limite de paradas por motorista.
- **Medição de 2026-10-29:** 200 paradas e 3 motoristas levaram 0,4 s de matriz e 30 s de solver, com pico de 240 MB na API.

### Links do Google Maps
Os links usam o formato [Maps URLs](https://developers.google.com/maps/documentation/urls/get-started), que não precisa de chave: `https://www.google.com/maps/dir/?api=1&origin=…&destination=…&waypoints=…&travelmode=driving`.
- **Limites:** cada link tem no máximo 9 waypoints (nos navegadores de celular, só 3) e 2.048 caracteres.
- **Trechos:** o trecho 1 vai da partida até a 10ª entrega; cada trecho seguinte começa na última entrega do anterior.
- **Texto ou coordenadas:** o link usa o endereço em texto quando cabe no limite; senão, usa as coordenadas.
- **Orientação exibida:** "Abra no aplicativo Google Maps para manter a ordem das paradas".
- **WhatsApp:** o botão abre `https://wa.me/?text=…` com os links prontos (sem API do WhatsApp); a pessoa escolhe o contato.

## Variáveis de ambiente

| Variável | Padrão | Para quê |
|---|---|---|
| `DATABASE_URL` | — | Conexão com o Postgres |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | — | Inicialização do container `db` |
| `SECRET_KEY` | — | Assina o cookie de sessão (`openssl rand -hex 32`) |
| `COOKIE_SECURE` | `true` | Mantenha `true` |
| `OSRM_URL` | `http://osrm:5000` | Serviço de rotas |
| `PROVEDOR_MATRIZ` | `osrm` | `osrm` ou `haversine` (só para testes) |
| `GEOCODIFICADOR` | `nominatim` | `nominatim` ou `falso` (só para testes) |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org` | Troque para um Nominatim próprio |
| `NOMINATIM_EMAIL` | vazio | Contato exigido pela política do Nominatim. Sem ele, a geocodificação fica desligada |
| `REGIAO_BBOX` | `-48.6384,-17.3761,-46.8150,-14.5160` | Área do OSRM: prioriza resultados e marca os que ficam fora |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | Em produção: IP ou faixa do Traefik, para ler o IP real do cliente |
| `SESSAO_DURACAO_S` | `43200` | Duração da sessão (12 h) |

## Banco de dados e migrações (Alembic)

As tabelas são criadas e alteradas por migrações em `alembic/versions/`. O `start.sh` aplica as pendentes (`alembic upgrade head`) toda vez que a API sobe.

```bash
docker compose exec api alembic current                                         # versão atual do banco
docker compose exec -u "$(id -u)" api alembic revision --autogenerate -m "descricao"   # nova migração (revise o arquivo!)
```

## Testes

```bash
docker compose exec api python -m pytest -q tests
```

Os testes usam um banco separado, `rotear_test`, recriado a cada execução no mesmo Postgres. O banco de desenvolvimento não é tocado.

## Segurança do login

- As senhas são guardadas com argon2. A sessão fica num cookie assinado com `SECRET_KEY`, com os atributos HttpOnly, Secure e SameSite=Lax, e dura 12 h.
- Desativar um usuário ou redefinir a senha dele derruba as sessões abertas, porque incrementa `usuarios.sessao_versao`.
- Limite de tentativas:
    - Por conta: 5 erros bloqueiam a conta por 15 minutos.
    - Por IP: 20 erros em 15 minutos bloqueiam o IP. Esse contador fica em memória, então a API deve rodar com 1 worker.
- **IP real do cliente:**
    - Em dev, toda conexão chega com o IP do gateway do Docker, então o limite por IP vale para todos ao mesmo tempo.
    - Em produção, atrás do Traefik do Easypanel, defina `FORWARDED_ALLOW_IPS` com o IP ou a faixa da rede do Traefik, para o uvicorn ler o `X-Forwarded-For`.
- Requisições de escrita (POST, PUT, PATCH, DELETE) vindas de outra origem são recusadas (verificação de `Origin` e `Referer`).

## Geocodificação (Nominatim)

> **Leia a política de uso antes de ativar:** https://operations.osmfoundation.org/policies/nominatim/
>
> Resumo das restrições do Nominatim **público**:
> - No máximo **1 requisição por segundo**, somando todos os usuários do app.
> - **User-Agent** identificando o app, sem usar o padrão da biblioteca.
> - **Resultados em cache** obrigatórios.
> - O app deve poder **desligar** o serviço sem atualização de software.
> - Não usar **autocomplete**.
> - Geocodificação **regular em volume** é desencorajada.
> - **Não enviar dados pessoais.**
> - A política exige que o uso seja uma escolha **deliberada e informada** do responsável pelo sistema, que responde pelo cumprimento. Para uso contínuo em produção, o caminho recomendado é um Nominatim próprio ou outro provedor, configurado em `NOMINATIM_URL` ou com uma nova implementação da interface `Geocodificador`.

Como o Rotear cumpre esses pontos:

| Exigência | Implementação |
|---|---|
| 1 req/s | Limitador global com intervalo de 1,1 s (`app/geocodificacao/nominatim.py`); a API roda com 1 worker |
| Identificação | `User-Agent: Rotear/1.0 (...; contato: NOMINATIM_EMAIL)` e o parâmetro `email` |
| Cache | `cache_geocodificacao` por 30 dias, inclusive para "não encontrado"; limpeza automática diária |
| Desligar | Interruptor em **Admin → Configurações**: vale na hora, sem deploy |
| Sem autocomplete | Só há consulta quando a pessoa confirma uma lista ou clica em **Buscar** |
| Dados pessoais | Vai apenas o texto do endereço, nunca o nome do destinatário; nada vai para os logs |

Para ativar, defina `NOMINATIM_EMAIL` no `.env` e reinicie a API (`docker compose up -d api`). Sem esse e-mail, a busca de endereços responde "Geocodificação não configurada".

A busca é restrita ao Brasil (`countrycodes=br`) e prioriza a área do OSRM (`viewbox` com `REGIAO_BBOX`). Cada resultado recebe uma precisão, conforme o `place_rank` do Nominatim:

| Precisão | place_rank | Significado |
|---|---|---|
| Alta | 28 ou mais | Número da casa, edifício ou ponto de interesse |
| Baixa | 26–27 | Só a rua foi encontrada |
| Baixa | 17–25 | Só o bairro, a quadra ou a localidade |
| Baixa | 16 ou menos | Só a cidade |
| Fora da área | qualquer | Fora da região de rotas; o OSRM não calcula |

Resultados de precisão baixa aparecem para conferência: a pessoa corrige o texto ou arrasta o pino.

**Busca de reserva:** quando a consulta não acha nada, o Rotear tenta versões mais curtas, no máximo 2. Exemplo: "Congresso Nacional, Praça dos Três Poderes, Brasília - DF" passa a "Congresso Nacional, Brasília, DF" e depois "Congresso Nacional, DF". Todas respeitam o limite de 1 por segundo, e o resultado final vai para o cache.
- Teste real em 2026-10-29 com `exemplos/entregas-exemplo.xlsx`:
    - **Sem a reserva:** 18 de 30 com precisão alta e 9 não encontrados.
    - **Com a reserva:** 23 de 30 com precisão alta, 4 aproximados para conferir e 3 não encontrados (corrigidos na tela).

## OSRM (rotas pelas ruas)

O serviço `osrm` calcula distâncias e tempos reais de carro com o
[OSRM](https://github.com/Project-OSRM/osrm-backend), imagem `ghcr.io/project-osrm/osrm-backend:v26.10.0-debian`
e algoritmo MLD. Ele precisa de dados pré-processados no volume `rotear_osrm_data`. Gere esses dados **uma vez** antes de subir o projeto:

```bash
scripts/preparar-osrm.sh            # usa o .pbf já baixado, se existir
scripts/preparar-osrm.sh --baixar   # força baixar o mapa de novo (atualização)
docker compose restart osrm         # depois de reprocessar com o serviço já rodando
```

O script executa estas etapas, todas no container auxiliar `osrm-prep`, com limite de 3 GB de RAM:
1. Baixa `centro-oeste-latest.osm.pbf` do [Geofabrik](https://download.geofabrik.de/south-america/brazil.html) e confere o MD5. O download leva uns 15 minutos.
2. Calcula a bounding box do DF mais os municípios de Goiás que fazem divisa com ele, pelos limites administrativos do próprio OSM, e grava em `/data/bbox.txt`.
3. Recorta essa área com `osmium extract -s simple`. A estratégia padrão, `complete_ways`, passou de 3 GB.
4. Roda `osrm-extract` (perfil `car.lua`), `osrm-partition` e `osrm-customize`.

Medições de 2026-10-29:

| Etapa | Pico de RAM | Tempo |
|---|---|---|
| osmium extract (simple) | 2,0 GB | 10 s |
| osrm-extract | 0,64 GB | 42 s |
| osrm-partition | 0,15 GB | 4 s |
| osrm-customize | 0,18 GB | 2 s |
| `osrm-routed` em execução | ~150 MB | — |

Disco: 198 MB do .pbf Centro-Oeste, 65 MB do recorte e 215 MB dos arquivos `.osrm*`.

- Área usada: longitude −48,64 a −46,82 e latitude −17,38 a −14,52.
- Municípios detectados como vizinhos: Águas Lindas, Cidade Ocidental, Cristalina, Formosa, Novo Gama, Padre Bernardo, Planaltina, Santo Antônio do Descoberto e Valparaíso. Luziânia e Cabeceiras não fazem divisa no OSM, mas ficam dentro da área.
- `osrm-routed` roda com `--max-table-size 500`; o padrão é 100. Uma matriz de 201×201 responde em cerca de 0,3 s.
- Em dev, o OSRM fica acessível em `127.0.0.1:8003`.
- **Produção:** o `osrm/Dockerfile` tem as mesmas etapas, executadas dentro do build da imagem final. Assim o servidor não depende de volumes copiados à mão (veja "Publicar no Easypanel"). O script local usa a etapa `ferramentas` desse mesmo Dockerfile.

## Desenvolvimento (hot reload)

```bash
docker compose -f compose.yml -f compose.dev.yml up -d --build
docker compose logs -f api
```

- O diretório `./app` é montado dentro do container, e o uvicorn roda com `--reload`.
- Se mudar o `requirements.txt`, rode o comando de novo com `--build`.
- O banco fica acessível em `127.0.0.1:8002`. Do seu PC, crie um túnel:
  `ssh -L 8002:127.0.0.1:8002 lucas@SEU_SERVIDOR`
- Para abrir o psql: `docker compose exec db psql -U rotear rotear`
- Para usar o app no navegador do seu PC: `ssh -L 8001:127.0.0.1:8001 lucas@SEU_SERVIDOR` e abra http://localhost:8001. A localização do navegador e o cookie `Secure` exigem HTTPS ou `localhost`.

## Backup e restauração do banco

O backup automático de todos os projetos é feito por `~/projetos/scripts/backup-postgres.sh` e salvo em `~/backups/rotear/`.

Backup manual:

```bash
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  | gzip > ~/backups/rotear/manual_$(date +%F_%H%M).sql.gz
```

Restauração (sobrescreve as tabelas existentes):

```bash
gunzip -c ~/backups/rotear/AAAA-MM-DD_HHMM.sql.gz \
  | docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
```

## Publicar no Easypanel (homologação e produção)

O cadeado (HTTPS) só existe com um domínio servido pelo Traefik do Easypanel, que emite o certificado. Pelo túnel SSH (`http://localhost`), o navegador mostra o ícone de informação, e não o cadeado: isso é normal em desenvolvimento. **No celular, o Rotear só funciona com HTTPS**, porque o navegador exige conexão segura para liberar a localização.

Repositório: `github.com/lucaasmeiraf/rotear` (branch `main`). Crie um projeto `rotear` no Easypanel com 3 serviços.

### 1. Banco: serviço **Postgres**
- Versão 16.
- Depois de criado, copie a **URL de conexão interna**. O Rotear aceita tanto `postgres://` quanto `postgresql://`.

### 2. Rotas: serviço **App** chamado `osrm`
| Campo | Valor |
|---|---|
| Source | GitHub · `lucaasmeiraf/rotear` · branch `main` |
| Build | **Dockerfile** |
| Build Path | `/osrm` |
| Domains | **nenhum** (só a API acessa) |
| Porta interna | 5000 |

- O build baixa o mapa do Geofabrik, recorta o DF e o entorno e prepara o OSRM. Leva uns 15 minutos na primeira vez e usa até 2 GB de RAM. Nenhum volume é necessário.
- Para atualizar o mapa, faça um novo deploy sem cache.

### 3. Aplicação: serviço **App** chamado `app`
| Campo | Valor |
|---|---|
| Source | GitHub · `lucaasmeiraf/rotear` · branch `main` |
| Build | **Dockerfile** |
| Build Path | `/` |
| Domains | o seu domínio (ou o domínio automático do Easypanel) → **porta 8000**, com **HTTPS ligado** |

Environment:

```
DATABASE_URL=<URL interna do Postgres>
SECRET_KEY=<gere com: openssl rand -hex 32>
OSRM_URL=http://<nome interno do serviço osrm>:5000
NOMINATIM_EMAIL=<e-mail de contato>
FORWARDED_ALLOW_IPS=*
```

- **Nome interno do OSRM:** o Easypanel mostra o host interno de cada serviço na página dele. Costuma ser `<projeto>_<serviço>`, por exemplo `rotear_osrm`.
- **`FORWARDED_ALLOW_IPS=*`:** é seguro aqui porque o container só recebe tráfego pelo Traefik. Ele permite ler o IP real do cliente, usado no limite de tentativas de login.
- As migrações do banco rodam sozinhas a cada deploy (`start.sh`).
- O Easypanel usa só os `Dockerfile`; os arquivos `compose*.yml` servem apenas para o desenvolvimento local.

### 4. Primeiro acesso
No console do serviço `app`, rode `python -m app.cli criar-admin --email ... --nome "..."`.

### Roteiro de homologação
- [ ] `https://SEU_DOMINIO/health` responde `{"status":"ok","db":"ok","osrm":"ok"}`.
- [ ] O navegador mostra o **cadeado**, e o certificado é válido (clique no cadeado → "Conexão segura").
- [ ] **No celular**, ao abrir Planejar, o navegador **pergunta** se pode usar a localização, e o mapa mostra o ponto com a precisão em metros.
- [ ] Ao negar a localização, aparecem as instruções de como liberar.
- [ ] O admin cria um operador, e o operador **não** vê nem acessa Administração (tentar `/admin` dá "Acesso negado").
- [ ] Rodar o planejamento com `exemplos/entregas-exemplo.xlsx` até os links do Google Maps, e abrir um trecho no **aplicativo** Google Maps.
- [ ] "Enviar no WhatsApp" abre o WhatsApp com o texto e os links prontos.
- [ ] "Exportar .xlsx" baixa a planilha com as abas Rotas, Resumo e Links.

## Regras do app

- Configuração **somente** por variável de ambiente.
- Nenhum arquivo persistente dentro do container: uploads e dados vão para o banco ou para um volume declarado.
