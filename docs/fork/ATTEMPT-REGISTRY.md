# Attempt Registry

A etapa **7.1.2c2** implementou a persistência e a máquina de estados em SQLite. A **7.1.2c3a** liga o Registry ao primeiro envio elegível do Chat Completions direto da OpenAI. O Registry independe da Observability e opera com metadados tipados. [Repositório](../../src/lib/db/repos/attemptRegistryRepo.js) · [Roadmap](ROADMAP.md#incrementos-do-quota-manager)

## Schema e identidade

A migration versionada **003** cria tabelas e índices. `SCHEMA_VERSION = 4` aciona o backup pré-migration existente. O upgrade preserva as estruturas anteriores, sem importar tentativas históricas. [Migration](../../src/lib/db/migrations/003-inference-attempt-registry.js) · [Schema](../../src/lib/db/schema.js)

| Tabela | Identidade e invariantes |
| --- | --- |
| `inferenceRequests` | Um UUID do servidor por requisição. Guarda rota lógica, modelo solicitado e ingresso. Índice de ingresso para retenção. |
| `inferenceAttempts` | UUID distinto por submissão. FK para a requisição, época e predecessor causal opcional. Retries, fallbacks e continuações exigem predecessor da mesma requisição. Guarda provedor, conexão opaca, papel, estado atual, desfecho, instante de despacho possível e versão. Índices por requisição, organização e despacho, e por época para estados abertos. |
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

`recoverOpen` depende de um verificador injetado de inatividade. Por padrão, o repositório não confirma nenhuma instância. A futura integração deve vincular a prova ao UUID de uma execução que não pode voltar a atuar. Idade da tentativa e timeout isolado não qualificam. A recuperação fecha épocas abertas, encerra tentativas abertas da instância e registra a evidência em uma transação. Tentativas de outra instância ficam fora. A operação não reenvia inferências.

Uma tentativa ainda `prepared` pode virar `not_sent` quando o caminho certifica a barreira persistida. Depois de `dispatch_possible`, o reinício deixa a tentativa incerta. O SQLite e a rede não compartilham uma transação. A evidência da barreira, sozinha, não comprova recebimento pelo provedor.

`openEpoch`, `closeEpoch`, `markCoverageGap` e `readCoverage` preservam o escopo e a primeira lacuna conhecida. Nesta etapa, cobertura só pode ser `unknown` ou `gap`, inclusive após fechamento limpo. Uma falha que impeça gravar a própria lacuna ainda deixa a cobertura indeterminada. A conciliação futura vai definir quais evidências permitem afirmar cobertura e a partir de qual corte.

| Driver | Verificação e limite |
| --- | --- |
| `better-sqlite3` | Suíte de estado, contenção entre conexões, upgrade, rollback e reabertura. WAL e `synchronous=NORMAL` permanecem conforme o projeto. |
| `node:sqlite` | Smoke test com rollback, reabertura e leitura da sequência. O Node emite aviso de SQLite experimental nesta versão. |
| `sql.js` | Smoke test com rollback e reabertura após fechamento. A exportação é diferida. O repositório recusa épocas com barreira certificada nesse driver. |
| `bun:sqlite` | O repositório usa a mesma interface síncrona e SQL aditivo. Execução no Bun segue pendente. |

Os testes verificam transações e reabertura. A durabilidade diante de queda de energia ou falha do host depende do driver, configuração e armazenamento e ainda precisa ser avaliada. A recuperação deve respeitar as garantias efetivamente confirmadas.

## Piloto OpenAI direto

`ATTEMPT_REGISTRY_OPENAI_DIRECT=true` habilita o piloto. O padrão é desligado. Somente `POST /v1/chat/completions`, servido por `/api/v1/chat/completions`, cria o contexto no ingresso. O piloto seleciona o primeiro caminho de modelo único, com conexão OpenAI por API key, formatos Chat Completions nos dois lados e transporte Undici direto à URL oficial. O `requestId` acompanha esse contexto e o `attemptId` é gerado na preparação. O modelo enviado vem do corpo preparado para o transporte. O vínculo vigente é `configured` quando demonstrável pela configuração e `unknown` quando ausente ou ambíguo. Os headers recebidos registram resposta observada com aceite `unknown`. [Rota](../../src/app/api/v1/chat/completions/route.js) · [Piloto](../../src/lib/quota/openAiDirectAttemptPilot.js) · [Fronteira HTTP](../../open-sse/utils/proxyFetch.js)

No JSON, o piloto lê o objeto original já parseado. No SSE nativo ou agregado em JSON, acompanha os frames brutos antes da tradução. Registra o primeiro chunk como início do stream e mantém a observação de modelo e do último uso válido em memória até finalizar, inclusive em interrupções. Cache e raciocínio permanecem detalhamentos de entrada e saída. `[DONE]` recebido do provedor encerra a tentativa. EOF sem terminal, cancelamento do leitor ou timeout após envio possível deixam a tentativa incerta. Um marcador produzido pelo gateway não serve como evidência do terminal do provedor. HTTP de erro fecha o transporte observado com uso desconhecido. O Registry preserva a contabilização existente de Analytics e funciona com Observability desativada.

Em Observation, erros de armazenamento deixam a época indeterminada ou com lacuna. Se a gravação da lacuna falhar, o processo tenta novamente na próxima tentativa elegível. A época declara `barrierCertified: false`. Uma falha constatada pela execução antes de chamar o transporte pode encerrar `not_sent`. Após crash, essa conclusão não pode ser reconstruída pelo piloto.

Combos, fallbacks entre conexões, retries, refresh, replays TLS/socket, redirecionamentos internos, proxies, transportes alternativos, outros endpoints e outros provedores permanecem sem instrumentação certificada. Respostas de outra submissão ficam fora da tentativa original. A recuperação automática e a cobertura por caminho serão avaliadas nos incrementos seguintes. A integração com a Reconciliation fica para a 7.1.2c4.

## Integração e backlog

- **Observation / fail-open.** Política escolhida para a primeira integração. Uma falha do Registry preserva o atendimento e deixa lacuna ou cobertura indeterminada. Um caminho que pode enviar após falhar na gravação da barreira deve declarar `barrierCertified: false`.
- **Required / fail-closed.** Opção futura de exigir o registro confirmado antes do envio. Depende de decisão explícita de disponibilidade e validação da durabilidade e da cobertura.
- **Histórico e Analytics.** `linkUsageHistory` grava uma associação explícita para a cardinalidade piloto. O Registry não escreve em `usageHistory` nem `usageDaily`. A integração manterá um único produtor de Analytics.
- **Retenção configurável.** Planejar expiração em lotes de eventos encerrados, preservando tentativas abertas, dependências causais, tombstones de instância e marcadores de lacuna. Uma janela após expiração perde a evidência necessária para afirmar cobertura. A limpeza automática permanece no backlog.
- **Request Lifecycle Dashboard.** Backlog associado à Granular Observability. Inclui uma matriz de cobertura por rota, operação e transporte e um Request Inspector com linha do tempo por tentativa, estados do transporte, desfecho, origem do uso, latência, retries e evidências. O Inspector usa apenas metadados operacionais.
