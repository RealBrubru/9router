# Profiling do Attempt Registry

A 7.1.2c3c+ mede o código aprovado da 7.1.2c3c. Os números abaixo vêm de transporte simulado e SQLite temporário. Os percentis ponta a ponta da rodada anterior continuam no [benchmark de referência](ATTEMPT-REGISTRY-BENCHMARK.md).

## Reprodução

A partir de `tests/`, com a versão de Node do repositório:

```bash
env -u RUN_REAL -u RUN_E2E RUN_ATTEMPT_PROFILE=1 \
  node node_modules/vitest/vitest.mjs run --maxWorkers=1 \
  unit/openai-attempt-registry-benchmark.test.js unit/attempt-registry-sqlite-profile.test.js
```

O teste da rota mede JSON e SSE com 1 e 100 simultâneas, flag desligada e ligada, três rodadas e bancos distintos. São 360 ou 600 amostras por combinação e 3.840 requisições medidas no total. O ensaio usou Linux ARM64, Node 22.23.4, better-sqlite3 12.11.1 e SQLite 3.53.2, com WAL e `synchronous=NORMAL`. As sondas medem chamadas ao repositório, statements, callback da transação, tempo fora do callback e atraso de um `setImmediate` por rajada. As sondas introduzem custo próprio. A análise usa essa execução para distribuir custos, sem substituir a referência ponta a ponta anterior. O teste separado usa 600 tentativas aquecidas, metade com vínculo, e controles de commit, índices e contenção. Os dois testes emitem JSON agregado sem parâmetros SQL, credenciais ou payloads.

## Composição e distribuição

No caso de sucesso com modelo devolvido e uso medido, o JSON grava seis transações no Registry e uma no Analytics. O SSE acrescenta uma transação ao observar o início do stream. Abertura, encerramento e lacuna da época são operações excepcionais, fora dessa contagem por requisição. [Piloto](../../src/lib/quota/openAiDirectAttemptPilot.js) · [Repositório](../../src/lib/db/repos/attemptRegistryRepo.js)

| Transação, na ordem do caminho do Registry | Responsabilidade | JSON p50/p95 (ms) | SSE p50/p95 (ms) |
| --- | --- | ---: | ---: |
| `prepare` | Identidade, época, causalidade e criação da tentativa | 0,280/0,376 | 0,290/0,371 |
| `markDispatchPossible` | Gravação local da barreira antes da chamada ao transporte | 0,263/0,353 | 0,270/0,363 |
| `acknowledge` | Resposta HTTP observada | 0,258/0,331 | 0,288/0,390 |
| `markInProgress` | Início observado de SSE | — | 0,268/0,334 |
| `observeReturnedModel` | Identidade do modelo devolvido | 0,235/0,303 | 0,276/0,351 |
| `recordUsage` | Uso e proveniência | 0,233/0,308 | 0,237/0,306 |
| `finish` | Desfecho observado ou incerto | 0,219/0,279 | 0,224/0,290 |
| Analytics, em fluxo próprio | Histórico, agregado diário e contador vitalício | 0,250/0,313 | 0,221/0,289 |

Os percentis são de 600 observações por operação na configuração a 100 simultâneas, com Registry ligado. Para uma requisição, as médias amortizadas somaram **3,212 ms em transações do Registry no JSON** e **3,810 ms no SSE**, distribuídas assim:

| Parcela síncrona por requisição a 100 simultâneas | JSON (ms) | SSE (ms) |
| --- | ---: | ---: |
| Fora do callback, incluindo wrapper, início e commit | 2,046 (64%) | 2,328 (61%) |
| Statements dentro do callback | 0,742 | 1,000 |
| Restante do callback, incluindo validação, transições, JSON e sondas | 0,424 | 0,482 |
| Antes ou depois da transação, dentro dos métodos medidos | 0,141 | 0,143 |

Esse tempo é acumulado por requisição. Na concorrência, cada segmento síncrono também adia o progresso das demais. A parcela fora do callback não identifica quanto foi `COMMIT`, I/O, checkpoint automático ou wrapper do driver. O controle aquecido, com uma única linha e 299 amostras, mediu p50 de 0,0014 ms para `BEGIN` com escrita, 0,0049 ms para o `UPDATE` e 0,0098 ms para `COMMIT`. A transação completa pelo adaptador mediu 0,0116 ms sem escrita e 0,0231 ms com escrita. Esse controle separa etapas em condições simples e não reproduz os índices, as páginas ou as caudas da rota.

### Statements, materialização e armazenamento

- O adaptador já mantém um cache por texto SQL e conexão. Foram observadas 10 preparações no aquecimento com Registry desligado e 24 com ele ligado, contando o caminho da rota e do Analytics. Na carga aquecida, a sonda interceptou **zero** novas preparações via interface pública. O controle transacional do better-sqlite3 tem cache interno próprio. [Adaptador](../../src/lib/db/adapters/betterSqliteAdapter.js)
- Por requisição de sucesso, o Registry chamou **46 statements em JSON e 54 em SSE** dentro das transações. Os maiores itens por tempo a 100 simultâneas foram o `UPDATE inferenceAttempts` (0,209/0,299 ms amortizados), o `INSERT inferenceAttemptEvents` (0,151/0,190 ms) e as 11/13 buscas por evento (0,125/0,179 ms). Dessas buscas, 5/6 verificam idempotência antes da mutação e 6/7 leem de volta o evento recém-inserido. Consultas à época ocorreram 6/7 vezes. Uma consulta externa à transação procura o vínculo candidato. O teste separado mediu p50 de 0,013 ms nessa busca e 0,009 ms na validação adicional em despacho com vínculo configurado.
- O plano usou `(attemptId, eventId)` para identidade e `(attemptId, version)` para o último uso. A leitura histórica usou `idx_iae_known` e ordenação temporária por versão. A consulta de vínculo usou o índice por conexão e início de vigência. Após 602 tentativas JSON, a tabela de eventos ocupava 808 KiB e seus três índices somavam 752 KiB. As garantias de idempotência e a leitura por corte temporal dependem dessas estruturas. O `UPDATE` materializa estado, versão, organização e despacho. Uma futura atualização seletiva pode evitar escrever colunas estáveis e merece prova de redução de páginas/indexação antes de qualquer alteração em índices. [Schema](../../src/lib/db/schema.js)
- Na rota a 100 simultâneas, o crescimento dos bancos por 600 requisições foi de 0,21 → 1,95 MiB em JSON e 0,21 → 2,13 MiB em SSE. O arquivo WAL antes do checkpoint final ficou entre 3,95 e 4,00 MiB nessas combinações. Esse tamanho mede a alocação final, não o volume cumulativo escrito. Os checkpoints finais explícitos dessas quatro combinações levaram 7,3 a 21,8 ms. O perfil não atribui picos individuais a checkpoints automáticos.
- Em teste separado, abrir a época teve p50 de 0,092 ms (60 operações), fechar 0,072 ms e marcar lacuna 0,080 ms (30 operações cada). A rota mediu uma abertura durante aquecimento e um encerramento ao fim do caso ligado. O custo direto da cobertura ocorre nessas transições. As leituras repetidas da época aparecem no caminho quente.

### Event loop, contenção e memória

Na carga a 100 simultâneas houve seis rajadas por combinação. O maior atraso observado no `setImmediate` por rajada subiu de **254 para 651 ms em JSON** e de **195 para 442 ms em SSE** com o Registry ligado. Essas máximas medem quanto o agendamento demorou a voltar ao loop naquelas rajadas. Em JSON, a cadeia de microtarefas pode englobar grande parte da rajada. Os seis pontos não sustentam um p99. O p95 da fila do gerador ficou entre 1,6 e 7,2 ms nessas combinações, enquanto o pré-despacho foi de 224 → 595 ms em JSON e de 162 → 381 ms em SSE. O benchmark em um processo não reportou `SQLITE_BUSY` ou falha de escrita.

Um controle com outra conexão segurando a trava de escrita e `busy_timeout=25` no banco temporário produziu `SQLITE_BUSY` nas três tentativas. A chamada síncrona levou 25,6–25,7 ms e um timer de atraso zero executou após 26,0–27,3 ms. Isso demonstra bloqueio sob contenção real e a distingue da espera das rajadas sem escritor concorrente. O limite de espera do aplicativo permaneceu intocado.

Os picos de RSS a 100 simultâneas oscilaram entre 232 e 331 MiB. As combinações compartilharam processo e alocador e as sondas guardaram amostras. O custo incremental de memória segue indeterminado. Para medi-lo, usar processos novos por modo, carga residente equivalente e repetir as medições de RSS, heap e memória nativa.

## Alternativas priorizadas

| Ordem e alternativa | Impacto esperado | Riscos, complexidade e garantias |
| --- | --- | --- |
| **1. Remover leituras redundantes, com prova de equivalência** | Evitar a leitura posterior a cada inserção se `INSERT … RETURNING` puder devolver a mesma sequência e os mesmos dados. Fazer lookup da época apenas quando a transição realmente usa suas propriedades. As famílias medidas custam décimos de ms por requisição. | Baixa a média complexidade. Validar suporte por driver e retorno de `sequence`. Preservar consulta idempotente de evento existente, corte de conhecimento, monotonicidade de tempos, CAS de versão, regras da barreira e proteção de recuperação. O impacto na cauda precisa ser reavaliado. |
| **2. Protótipo de agrupamento de eventos compatíveis** | Reduzir commits por requisição na fase de finalização. Há até três transações síncronas consecutivas do modelo, uso e desfecho no sucesso. | Média complexidade. Preservar eventos e ordenação. Um commit conjunto muda o resultado do crash entre a gravação de uso e a gravação do desfecho. Preservar qualquer checkpoint de uso já demonstravelmente durável, ou manter essa fronteira separada. Repetir a matriz de crash e evidência tardia. Agrupamento somente dentro de uma mesma fronteira, sem esperar rede. |
| **3. Preparação e barreira atômicas** | Uma transação a menos no caminho pré-despacho se ambas puderem ocorrer imediatamente antes da chamada ao transporte. | Média complexidade. A preparação hoje pode anteceder erros locais que geram `not_sent`. Precisa preservar essa evidência e a distinção entre falhas pré-despacho e envio possível. Revalidar vínculo, identidade, falha de persistência e crash antes ou depois do commit. |
| **4. Cache de statements e escrita seletiva** | O cache aquecido já funciona. Reduzir colunas atualizadas em eventos que só avançam versão pode diminuir trabalho de materialização. | Cache extra tem baixa prioridade. Escrita seletiva tem complexidade média e exige profiling de páginas, WAL e perfis de leitura. Índices de idempotência, recuperação e leitura histórica permanecem até prova de equivalência. |
| **5. Worker dedicado à escrita** | Pode tirar SQLite síncrono do event loop e explicitar filas e backpressure. O volume de commits continuará relevante. | Alta complexidade. IPC, ordenação, crash do worker, contenção com Analytics e confirmação da barreira viram parte do contrato. A tentativa só pode seguir pelo caminho normal de despacho depois de resposta sobre a gravação, respeitando a política Observation em falhas. Evitar trabalhos reordenados ou órfãos e medir fila e perda de cobertura. |

O próximo incremento recomendado começa pela remoção de leituras redundantes com testes de equivalência e mede de novo a rota antes de agrupar transações. O agrupamento segue como o candidato de maior impacto potencial, condicionado à preservação das evidências nos testes de crash. O profiling não alterou o fluxo de produção nem as garantias de durabilidade. Recuperação automática em servidor, durabilidade física, memória incremental e cobertura dos transportes opacos seguem abertas.
