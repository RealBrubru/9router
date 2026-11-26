# Benchmark offline do Attempt Registry

Comparação da 7.1.2c3c com o Registry desligado e ligado, em Linux ARM64 com quatro CPUs Neoverse-N1, Node 22.23.4, better-sqlite3 12.11.1 e SQLite 3.53.2. O gateway roda em um processo, com SQLite em WAL e `synchronous=NORMAL`. A rota real de Chat Completions roda em memória e o Undici retorna JSON ou SSE sintético. O SSE entrega conteúdo e terminal em turnos distintos do event loop. O benchmark usa a mesma resposta e os mesmos contadores nos dois modos. Observability fica desligada.

## Método

- Cada combinação de protocolo, flag e concorrência começa com um banco temporário próprio. O aquecimento usa pelo menos duas rajadas e pelo menos 20 requisições. Depois, as tabelas dos cenários são esvaziadas e o SQLite executa `VACUUM` e checkpoint para estabelecer a base de armazenamento.
- São três rodadas por combinação. Por rodada, os níveis 1, 10, 50 e 100 usam respectivamente 120, 12, 3 e 2 rajadas. Isso produz 360, 360, 450 e 600 amostras por modo e protocolo. A ordem ligado/desligado alterna entre níveis.
- A fila do gerador é medida da liberação da rajada até o início de cada chamada à rota. A latência pré-despacho vai do início da chamada à primeira invocação do transporte simulado. O TTFT mede a chegada do primeiro delta de conteúdo ao leitor SSE. O tempo total termina após a leitura e verificação da resposta. O processamento e a espera no próprio processo fazem parte das latências da rota. A fila anterior ao início da chamada é apresentada separadamente.
- Throughput divide o total de respostas pela soma das durações das rajadas. A preparação do banco, o aquecimento e a espera adicional pelo Analytics ao fim da rodada ficam fora do denominador. Cada rodada valida as linhas no histórico e o agregado diário.
- As transações SQLite medidas incluem aquisição, trabalho síncrono do callback e commit. As operações individuais do Registry são medidas separadamente. RSS é amostrado no início e após cada rajada. Os deltas de armazenamento medem o arquivo principal após checkpoint e o arquivo WAL antes do checkpoint final, ambos comparados à base.

A partir de `tests/`, com a versão de Node do repositório, execute:

```bash
env -u RUN_REAL -u RUN_E2E RUN_ATTEMPT_BENCH=1 \
  node node_modules/vitest/vitest.mjs run unit/openai-attempt-registry-benchmark.test.js
```

O teste define `DATA_DIR` temporário e substitui o transporte. Cada linha `ATTEMPT_BENCH` registra uma combinação. [Harness](../../tests/unit/openai-attempt-registry-benchmark.test.js)

## Resultados

Cada célula compara desligado → ligado. As tríades de latência representam p50/p95/p99 em milissegundos.

| Protocolo | Simultâneas | Pré-despacho | TTFT | Tempo total | Req/s |
| --- | ---: | --- | --- | --- | ---: |
| JSON | 1 | 1,5/1,9/4,2 → 2,1/4,9/26,7 | — | 2,6/3,3/5,9 → 4,2/27,6/30,4 | 333,1 → 163,0 |
| JSON | 10 | 10,6/18,9/34,8 → 22,3/56,0/59,9 | — | 17,9/23,2/41,7 → 41,9/63,9/68,2 | 437,3 → 178,8 |
| JSON | 50 | 57,1/113,0/126,2 → 130,0/245,3/272,8 | — | 67,1/122,3/130,3 → 150,6/271,1/281,0 | 426,9 → 187,6 |
| JSON | 100 | 110,4/214,4/232,2 → 269,8/521,2/546,2 | — | 120,1/220,9/236,5 → 297,9/536,4/557,0 | 437,7 → 182,7 |
| SSE | 1 | 1,2/1,4/1,5 → 2,0/2,3/25,3 | 2,3/3,0/5,5 → 3,6/24,4/28,2 | 3,8/5,1/9,3 → 5,7/28,7/30,6 | 239,2 → 126,1 |
| SSE | 10 | 8,9/15,3/16,8 → 15,6/47,3/51,9 | 17,7/23,8/25,5 → 34,3/60,3/63,1 | 28,3/40,0/57,5 → 65,0/83,0/87,1 | 272,0 → 131,7 |
| SSE | 50 | 46,8/102,8/155,6 → 86,5/168,5/175,9 | 92,3/175,9/179,5 → 191,2/207,1/211,3 | 151,5/238,5/267,9 → 288,0/365,5/374,9 | 251,9 → 136,7 |
| SSE | 100 | 86,6/159,8/167,7 → 180,6/343,0/375,7 | 183,8/194,1/195,9 → 399,0/455,6/467,3 | 280,7/358,8/369,5 → 602,4/754,5/779,3 | 272,6 → 131,1 |

### SQLite, fila e armazenamento

Os percentis da fila são apresentados em ms e os deltas de armazenamento em MiB. O pico de RSS é um valor amostrado do processo compartilhado por todas as combinações, com valores absolutos em MiB.

| Protocolo | Simultâneas | Fila do gerador | Transações SQLite (ms) | Crescimento do banco | Crescimento do WAL | Pico RSS |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| JSON | 1 | 0,09/0,13/0,20 → 0,09/0,13/0,18 | 0,21/0,28/2,33 → 0,21/0,30/5,12 | 0,12 → 1,18 | 3,95 → 3,98 | 207,73 → 213,20 |
| JSON | 10 | 0,22/0,37/0,55 → 0,27/0,42/0,50 | 0,17/0,25/1,96 → 0,20/0,28/3,02 | 0,12 → 1,17 | 3,95 → 4,00 | 220,23 → 217,13 |
| JSON | 50 | 0,61/4,06/4,36 → 0,61/1,07/3,68 | 0,19/0,26/1,93 → 0,20/0,27/3,96 | 0,15 → 1,46 | 3,96 → 3,97 | 222,18 → 225,96 |
| JSON | 100 | 0,76/1,58/1,80 → 0,89/2,01/2,24 | 0,18/0,24/2,22 → 0,20/0,29/4,35 | 0,21 → 1,96 | 3,95 → 3,98 | 252,26 → 246,00 |
| SSE | 1 | 0,06/0,08/0,12 → 0,06/0,09/0,12 | 0,20/0,26/2,67 → 0,22/0,29/2,32 | 0,12 → 1,28 | 3,95 → 3,98 | 257,48 → 261,43 |
| SSE | 10 | 0,17/0,23/0,27 → 0,18/0,26/0,30 | 0,18/0,25/1,90 → 0,22/0,30/4,20 | 0,12 → 1,28 | 3,95 → 3,97 | 269,17 → 268,32 |
| SSE | 50 | 0,48/0,78/0,81 → 0,53/0,87/0,92 | 0,18/0,25/2,86 → 0,22/0,29/5,04 | 0,15 → 1,61 | 3,96 → 4,00 | 279,79 → 286,77 |
| SSE | 100 | 0,78/8,41/8,82 → 0,86/1,59/1,83 | 0,17/0,24/1,94 → 0,22/0,30/3,67 | 0,21 → 2,12 | 3,95 → 3,99 | 328,23 → 327,46 |

- **Integridade.** Foram medidas 7.080 requisições. As 3.540 tentativas esperadas no modo ligado foram persistidas. Cada requisição gerou uma única linha de Analytics. Houve zero falhas, `SQLITE_BUSY` ou avisos do Registry na carga medida.
- **Volume de operações.** O benchmark observou uma transação por requisição com o Registry desligado, sete para JSON com o Registry ligado e oito para SSE. As operações SQL individuais do Registry ficaram em 46 por JSON e 54 por SSE. A latência individual do p50 ficou em torno de 0,01 ms em ambas as modalidades. O crescimento do WAL no fim da carga foi semelhante nos dois modos, com reaproveitamento do arquivo durante checkpoints automáticos. O valor do arquivo não representa o volume acumulado de escrita.
- **Contenção.** Um teste separado segurou um bloqueio de escrita em outra conexão com `busy_timeout=0`. O piloto seguiu em Observation, manteve cobertura indeterminada durante a falha e gravou a lacuna após liberar o bloqueio. O benchmark de um processo não isola o tempo de espera por locks, tarefas agendadas ou I/O do SQLite.
- **Limites.** A fila do gerador é separada do tempo da rota. Espera dentro da rota, instrumentação do benchmark, GC e outros processos do host ainda podem influenciar as caudas. RSS amostrado pode perder picos entre coletas e carrega memória remanescente de combinações anteriores. Os resultados caracterizam rajadas com respostas curtas e transporte simulado. Capacidade sustentada, regressões de longa duração, perdas físicas de energia e I/O de produção exigem medições próprias.

Com cem requisições simultâneas, o p95 do tempo total passou de 220,9 para 536,4 ms no JSON e de 358,8 para 754,5 ms no SSE. O número de transações síncronas faz do caminho de gravação um candidato para profiling antes de ampliar o piloto. A medição não atribui a ele toda a diferença observada.
