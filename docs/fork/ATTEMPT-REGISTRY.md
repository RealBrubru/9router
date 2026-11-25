# Attempt Registry

A etapa **7.1.2c2** implementa a persistência e a máquina de estados em SQLite. A integração futura propagará contexto explícito da requisição até as fronteiras semânticas de submissão, inclusive retries e fallbacks. O Registry independe da Observability e opera com metadados tipados. Nesta etapa, somente os testes chamam o repositório. [Repositório](../../src/lib/db/repos/attemptRegistryRepo.js) · [Roadmap](ROADMAP.md#incrementos-do-quota-manager)

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
| `not_sent` | A partir de `prepared`, por encerramento anterior à barreira certificada ou recuperação de proprietário inativo nesse mesmo caminho. |
| `dispatch_possible` | A partir de `prepared`, por `markDispatchPossible`. A gravação deve anteceder a chamada à rede na futura integração. |
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

## Integração e backlog

- **Observation / fail-open.** Política escolhida para a primeira integração. Uma falha do Registry preserva o atendimento e deixa lacuna ou cobertura indeterminada. Um caminho que pode enviar após falhar na gravação da barreira deve declarar `barrierCertified: false`.
- **Required / fail-closed.** Opção futura de exigir o registro confirmado antes do envio. Depende de decisão explícita de disponibilidade e validação da durabilidade e da cobertura.
- **Histórico e Analytics.** `linkUsageHistory` grava uma associação explícita para a cardinalidade piloto. O Registry não escreve em `usageHistory` nem `usageDaily`. A integração manterá um único produtor de Analytics.
- **Retenção configurável.** Planejar expiração em lotes de eventos encerrados, preservando tentativas abertas, dependências causais, tombstones de instância e marcadores de lacuna. Uma janela após expiração perde a evidência necessária para afirmar cobertura. A limpeza automática permanece no backlog.
- **Request Lifecycle Dashboard.** Backlog associado à Granular Observability. Deve mostrar estados, retries, origem do uso e uma matriz de cobertura por rota, operação e transporte. Conversas e conteúdo seguem uma política separada.
