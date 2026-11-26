# Attempt Registry

A etapa **7.1.2c2** implementou a persistência e a máquina de estados em SQLite. A **7.1.2c3a** instrumentou o primeiro envio elegível do Chat Completions direto da OpenAI. A **7.1.2c3b** amplia o piloto para os reenvios observáveis e a causalidade dentro desse caminho. O Registry independe da Observability e opera com metadados tipados. [Repositório](../../src/lib/db/repos/attemptRegistryRepo.js) · [Roadmap](ROADMAP.md#incrementos-do-quota-manager)

A **7.1.2c3c** valida recuperação com processos descartáveis, delimita épocas de observação e mede o custo do piloto sob concorrência simulada. [Benchmark](ATTEMPT-REGISTRY-BENCHMARK.md)

## Schema e identidade

A migration versionada **003** cria tabelas e índices. `SCHEMA_VERSION = 4` aciona o backup pré-migration existente. O upgrade preserva as estruturas anteriores, sem importar tentativas históricas. [Migration](../../src/lib/db/migrations/003-inference-attempt-registry.js) · [Schema](../../src/lib/db/schema.js)

| Tabela | Identidade e invariantes |
| --- | --- |
| `inferenceRequests` | Um UUID do servidor por requisição. Guarda rota lógica, modelo solicitado e ingresso. Índice de ingresso para retenção. |
| `inferenceAttempts` | UUID distinto por submissão. FK para a requisição, época e predecessor causal opcional. Um predecessor informado deve pertencer à mesma requisição. O piloto admite retry ou fallback sem predecessor quando registra a causa tipada e a lacuna correspondente no evento de preparação. Guarda provedor, conexão opaca, papel, estado atual, desfecho, instante de despacho possível e versão. Índices por requisição, organização e despacho, e por época para estados abertos. |
| `inferenceAttemptEvents` | Sequência autoincremental, UUID do evento, versão da tentativa, ocorrência, conhecimento e horário local da gravação. `(attemptId, eventId)` e `(attemptId, version)` são únicos. Índice para reconstrução por conhecimento e sequência. |
| `inferenceCoverageEpochs` | UUID da época, UUID da instância de execução, versão da instrumentação, rota, operação e transporte. Há no máximo uma época aberta para cada tupla de escopo. Guarda fechamento, primeira lacuna conhecida e evidência opaca de saída da instância. |
| `inferenceUsageLinks` | Associação opcional um a um com `usageHistory` para uma tentativa encerrada com uso registrado. Exige evidência explícita e compatibilidade de provedor e conexão. Excluir o histórico remove somente a associação. |

Uma repetição idempotente da gravação reutiliza o mesmo `eventId` com os mesmos dados semânticos. Um novo envio recebe outro `attemptId`, mesmo quando o cliente, modelo ou payload coincidirem. Reutilizar a identidade com dados diferentes resulta em conflito. A integração deve gerar o UUID antes de tentar persistir e preservá-lo ao repetir a gravação.

No despacho, o vínculo pode ser `unknown`, `configured` ou `confirmed`. O repositório valida a referência do vínculo administrativo da conexão na vigência declarada. `confirmed` também exige UUID da versão efetiva da credencial e referência opaca à evidência, fornecidos por uma fronteira confiável. O Registry guarda organização e início de vigência. A referência em conjunto com a conexão aponta para o projeto e a chave administrativa no vínculo existente. O Registry não copia esses identificadores nem lê a credencial. O chamador continua responsável por comprovar a correspondência com o material utilizado no transporte.

O modelo enviado pertence ao evento de despacho. O modelo devolvido pode chegar no aceite ou em evento separado, inclusive depois dos headers SSE. O contrato aceita somente campos explícitos e identificadores limitados. Prompts, payloads, respostas, cabeçalhos, segredos, URLs completas e mensagens brutas de erro ficam fora do schema.

## Estados, eventos e concorrência

| Estado | Entrada ou avanço permitido |
| --- | --- |
| `prepared` | Criado por `prepare`, junto da requisição quando ela ainda não existe. |
| `not_sent` | A partir de `prepared`, por evidência em execução de que o transporte ainda não foi invocado, por encerramento anterior à barreira certificada ou por recuperação de proprietário inativo em caminho certificado. |
| `dispatch_possible` | A partir de `prepared`, por `markDispatchPossible`. O piloto tenta gravar imediatamente antes da primeira invocação do transporte. |
| `response_observed` | A partir de `dispatch_possible`, por `acknowledge`. Origem da resposta, status HTTP e aceite confirmado são campos independentes. A confirmação exige evidência do provedor. |
| `in_progress` | A partir de `response_observed`, por `markInProgress` para stream ou job. |
| `closed` | A partir de `response_observed` ou `in_progress`, por `finish` com um terminal observado. |
| `uncertain` | Após envio possível, por `finish` sem terminal demonstrável ou por recuperação. A recuperação também usa esse estado antes da barreira quando o caminho carece de certificação. |

Cada mutação recebe `expectedVersion`. O update compara essa versão no SQLite e a transação inclui o evento correspondente. Dois callbacks com a mesma versão só podem efetivar uma atualização. A repetição do evento já gravado retorna o original. Um erro de contenção pode ser repetido pelo chamador com a mesma identidade. As transações locais permanecem curtas e sem I/O externo.

`recordUsage` guarda snapshots tipados com fonte, qualidade e completude. Contadores são strings decimais inteiras. Uso medido incompleto preserva os campos ausentes como nulos. Zero explícito exige medição completa de entrada e saída iguais a zero. `not_sent` produz uso `not_applicable`. Uma tentativa pode permanecer com consumo desconhecido mesmo diante de HTTP 200, 429, erro ou cancelamento. Uma revisão de mesma qualidade substitui a projeção anterior sem somar valores. Medição completa tem precedência sobre medição parcial, estimativa e ausência. Cada snapshot continua auditável no histórico. Evidência tardia pode atualizar o uso depois do desfecho, preservando o desfecho e a cronologia original.

`captureReadCutoff()` captura a sequência já visível e o relógio local. Deve ser chamado fora de uma transação de escrita do chamador. `readAsKnownAt(attemptId, { throughSequence, knownAt })` usa os dois cortes. Isso exclui um registro posterior mesmo quando seus timestamps coincidirem com o corte anterior. `recordedAt` indica o momento local da gravação, sem precisão de commit físico. O índice por sequência é a evidência de disponibilidade para o leitor que capturou o corte. Os eventos de ciclo de vida preservam sua ordem de ocorrência. Evidência aprendida depois pode referir-se a ocorrência anterior.

## Recuperação, cobertura e durabilidade

`recoverOpen` exige evidência de saída vinculada ao UUID da execução proprietária. O teste usa um supervisor que recebe esse UUID pelo canal IPC privado do filho e observa o evento `exit` do mesmo processo. Só então aceita o recibo de saída emitido para aquele UUID. Um PID pode ser reutilizado. Idade, timeout, perda de IPC ou desaparecimento de heartbeat também são insuficientes. Uma implementação em servidor precisa de uma autoridade confiável capaz de preservar a prova após reinício do supervisor, como um registro do ciclo de vida por identidade de execução ou uma garantia verificável de exclusão do proprietário anterior. A recuperação automática no boot segue sem um provedor dessa prova. Quando ela falta, as tentativas permanecem abertas e a cobertura indeterminada.

Com prova válida, a recuperação fecha épocas abertas, encerra tentativas abertas da instância e grava a evidência em uma transação. Ela é idempotente, preserva outras instâncias e jamais reenvia inferências. No piloto em Observation, até `prepared` vira `uncertain / process_exit`, pois a barreira carece de certificação. Um crash em `dispatch_possible` antes da chamada ao transporte é indistinguível de outro após possível envio sem evidência adicional. Nos testes com `SIGKILL`, uso apenas em memória ficou desconhecido, uso já persistido ficou disponível e evidência tardia alterou somente o uso, preservando o desfecho e o corte histórico. [Teste de crash](../../tests/unit/attempt-registry-crash.test.js)

`openEpoch`, `closeEpoch`, `markCoverageGap` e `readCoverage` preservam o escopo e a primeira lacuna conhecida. A recuperação marca a época que ainda estava aberta com `owner_exit` desde sua abertura, pois o início exato da lacuna é desconhecido. Quando o mesmo processo observa a flag desligada no ingresso, fecha a época anterior e invalida novas preparações de contextos dessa geração. Tentativas já despachadas ainda podem registrar evidência. Ao reativar, uma nova época começa na primeira tentativa elegível. Com o piloto sempre desligado, ele sequer abre o banco. Uma falha ao gravar encerramento ou lacuna deixa a época indeterminada e mantém a operação pendente em memória até uma nova tentativa elegível. Uma reinicialização perde essa pendência em memória e exige as evidências de recuperação anteriores.

| Driver | Verificação e limite |
| --- | --- |
| `better-sqlite3` | Suíte de estado, contenção entre conexões, upgrade, rollback e reabertura. WAL e `synchronous=NORMAL` permanecem conforme o projeto. |
| `node:sqlite` | Smoke test com rollback, reabertura e leitura da sequência. O Node emite aviso de SQLite experimental nesta versão. |
| `sql.js` | Smoke test com rollback e reabertura após fechamento. A exportação é diferida. O repositório recusa épocas com barreira certificada nesse driver. |
| `bun:sqlite` | O repositório usa a mesma interface síncrona e SQL aditivo. Execução no Bun segue pendente. |

Os testes verificam transações e reabertura. A durabilidade diante de queda de energia ou falha do host depende do driver, configuração e armazenamento e ainda precisa ser avaliada. A recuperação deve respeitar as garantias efetivamente confirmadas.

## Piloto OpenAI direto

`ATTEMPT_REGISTRY_OPENAI_DIRECT=true` habilita o piloto. O padrão é desligado. Somente `POST /v1/chat/completions`, servido por `/api/v1/chat/completions`, cria o contexto no ingresso. O escopo exige seleção de modelo único, conexão OpenAI por API key, formatos Chat Completions nos dois lados e transporte Undici direto à URL oficial. A cadeia compartilha o `requestId` e cada tentativa recebe seu `attemptId`. Em cada envio, o piloto lê o modelo do corpo preparado e resolve o vínculo vigente da conexão. O vínculo fica `configured` quando a API key selecionada corresponde à autorização efetiva e o vínculo é único, ou `unknown` quando há ambiguidade, ausência ou sobrescrita de escopo. Os headers recebidos registram resposta observada com aceite `unknown`. [Rota](../../src/app/api/v1/chat/completions/route.js) · [Piloto](../../src/lib/quota/openAiDirectAttemptPilot.js) · [Fronteira HTTP](../../open-sse/utils/proxyFetch.js)

No JSON, o piloto lê o objeto original já parseado. No SSE nativo ou agregado em JSON, acompanha os frames brutos antes da tradução. Registra o primeiro chunk como início do stream e mantém modelo e uso em memória até finalizar, inclusive em interrupções. Cache e raciocínio permanecem detalhamentos de entrada e saída. `[DONE]` recebido do provedor encerra a tentativa. EOF sem terminal, cancelamento do leitor ou timeout após envio possível deixam a tentativa incerta. Um marcador produzido pelo gateway carece de valor como terminal do provedor. HTTP de erro fecha a tentativa com uso inicialmente desconhecido. Se o fluxo existente ler seu corpo JSON, o piloto preserva uso explícito como evidência parcial da tentativa correspondente. Corpos descartados durante retry permanecem desconhecidos. O piloto associa cada resposta ao objeto retornado pela chamada observada, inclusive se o refresh falhar e o gateway voltar a processar a resposta anterior.

Em Observation, erros de armazenamento deixam a época indeterminada ou com lacuna. Se a gravação da lacuna falhar, o processo tenta novamente na próxima tentativa elegível. A época declara `barrierCertified: false`. Uma falha constatada pela execução antes de chamar o transporte pode encerrar `not_sent`. Após crash, essa conclusão não pode ser reconstruída pelo piloto. Uma tentativa posterior a um predecessor ausente grava `causalGap: predecessor_unobserved`, preservando o `requestId` e a causa observada.

| Fronteira | Cobertura do piloto |
| --- | --- |
| Primeira chamada elegível ao Undici | Tentativa primária e resposta observada. |
| Retry do `BaseExecutor` por status ou erro de transporte | Novo `attemptId`, predecessor e causa `executor_retry`. |
| Replay explícito após falha de socket ou certificado TLS | Nova tentativa com `socket_replay` ou `tls_replay`. A política existente decide quando repetir. |
| Fallback para outra conexão OpenAI direta | Nova tentativa com `connection_fallback`. Resolve novamente modelo, conexão e vínculo no envio. |
| Reenvio após refresh no `chatCore` | Fronteira `credential_refresh` instrumentada e testada com retorno sintético. A conexão por API key da OpenAI não tem refresh nativo nesse executor. |
| Fallback de modelo e adaptador de capacidade | O roteamento passa por combos. Cobertura indeterminada neste incremento. |
| Proxies, redirecionamentos internos, retries opacos do Undici ou do SDK, outros endpoints e provedores | Cobertura indeterminada. Uma resposta redirecionada deixa incerta a tentativa externa observável. |
| Período entre épocas, banco indisponível e crash | Sem cobertura demonstrável. O estado é `unknown` ou `gap`, inclusive após fechamento limpo. |

O cancelamento é observável quando o leitor do stream cancela ou o transporte reporta aborto. A igualdade entre chamadas ao transporte simulado e tentativas persistidas valida aquela população observada, sem certificar a população total do gateway. A integração com a Reconciliation fica para a 7.1.2c4.

## Integração e backlog

- **Observation / fail-open.** Política escolhida para a primeira integração. Uma falha do Registry preserva o atendimento e deixa lacuna ou cobertura indeterminada. Um caminho que pode enviar após falhar na gravação da barreira deve declarar `barrierCertified: false`.
- **Required / fail-closed.** Opção futura de exigir o registro confirmado antes do envio. Depende de decisão explícita de disponibilidade e validação da durabilidade e da cobertura.
- **Histórico e Analytics.** O Registry preserva o único produtor de `usageHistory` e `usageDaily`. O despacho registra `usageHistoryLink: unverified` porque esse produtor ainda não entrega uma identidade de linha comprovada para a tentativa. `linkUsageHistory` fica disponível para uma futura associação com evidência explícita. Contadores iguais, timestamps e conexão compartilhada são insuficientes para vincular registros.
- **Desempenho.** A 7.1.2c3c mediu JSON e SSE com 1, 10, 50 e 100 requisições simultâneas. A 7.1.2c3c+ separou transações, statements e espera no event loop. O custo incremental de memória segue em aberto. [Benchmark](ATTEMPT-REGISTRY-BENCHMARK.md) · [Profiling e alternativas](ATTEMPT-REGISTRY-PROFILING.md)
- **Retenção configurável.** Planejar expiração em lotes de eventos encerrados, preservando tentativas abertas, dependências causais, tombstones de instância e marcadores de lacuna. Uma janela após expiração perde a evidência necessária para afirmar cobertura. A limpeza automática permanece no backlog.
- **Request Lifecycle Dashboard.** Backlog associado à Granular Observability. Inclui uma matriz de cobertura por rota, operação e transporte e um Request Inspector com linha do tempo por tentativa, causalidade, estados do transporte, desfecho, origem do uso, latência, retries e evidências. Incluir indicadores de desempenho, latência, throughput e saúde do armazenamento, entre eles contenção, falhas de persistência e crescimento do banco. O Inspector usa apenas metadados operacionais.
