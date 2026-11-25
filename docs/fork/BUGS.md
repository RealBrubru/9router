# Problemas conhecidos

**Escopo das evidências.** As observações iniciais na instalação experimental foram relatadas pelo proprietário. O diagnóstico rastreou o código no commit `5ae63d22`, e as reproduções sintéticas usaram dependências simuladas. A rodada manual posterior com OpenAI API ocorreu na imagem de homologação e está descrita no [runbook](RUNBOOK.md#homologação-inicial-com-openai-api).

## Bug 1 — JSON inválido com `stream: false`

**Correção implementada.** Na instalação experimental, o POST em `/v1/chat/completions` com `openai/gpt-5-mini`, `max_completion_tokens: 1024` e `stream: false` recebeu HTTP 200. O corpo tinha um JSON completo com `choices` e `usage`, seguido de `data: [DONE]`, e o tipo era `text/event-stream`. O parser retornou `Extra data: line 36 column 1 (char 797)`. Acrescentar `Accept: application/json` produziu o mesmo problema.

**Evidência no código.** O [registro da OpenAI](../../open-sse/providers/registry/openai.js#L26) força o sinal interno de streaming. O [core](../../open-sse/handlers/chatCore.js#L145) ignora a preferência JSON nesse caso. O [executor](../../open-sse/executors/default.js#L287) usa o sinal no cabeçalho, enquanto [o envio](../../open-sse/executors/base.js#L143) serializa o corpo que conserva `stream: false`. Ao receber JSON, [a conversão forçada](../../open-sse/handlers/chatCore/sseToJsonHandler.js#L189) devolve `null`, e o [despacho](../../open-sse/handlers/chatCore.js#L526) cai no [handler SSE](../../open-sse/handlers/chatCore/streamingHandler.js#L67).

**Reprodução e validação.** O transformador em passagem direta repassou um JSON de teste e anexou `data: [DONE]` após a chave final. O [flush](../../open-sse/utils/stream.js#L482) explica o sufixo. A correção passou em 120 testes em 11 arquivos, incluindo 14 novos cenários. A imagem ARM64 passou com upstream simulado e, na rodada manual com `gpt-6-luna`, entregou JSON válido com `stream: false` e SSE com `stream: true`.

**Aceite.** Para `stream: false`, obter um único objeto JSON com `application/json` e sem delimitadores SSE, com ou sem `Accept`. Se o upstream enviar SSE, agregá-lo no formato pedido pelo cliente. Preservar SSE para `stream: true` e o transporte de provedores que dependem dele.

## Bug 2 — Estimativa prematura e consumo consolidado incorretamente

**Correção implementada e validada com fixtures e SQLite temporário.** Os números abaixo resultam de chamadas distintas na instalação experimental e de uma reprodução sintética. O número de tokens de raciocínio pode variar entre chamadas.

| Origem | Entrada | Saída | Total | Detalhe |
| --- | ---: | ---: | ---: | --- |
| Instalação, resposta sem streaming | 19 | 80 | 99 | Uso informado pela OpenAI |
| Instalação, streaming sem `include_usage` | 2.038 | 6 | 2.044 | Evento com `estimated: true` |
| Instalação, streaming com `include_usage`, evento `stop` | 2.048 | 6 | 2.054 | Evento com `estimated: true` |
| Instalação, evento final da mesma chamada | 19 | 144 | 163 | `choices: []`, cache 0, raciocínio 128 |
| Sintético, evento `stop` | 2.049 | 6 | 2.055 | Estimativa sobre o corpo sintético |
| Sintético, evento final de upstream | 19 | 144 | 163 | Cache 0, raciocínio 128 |
| Sintético, estado interno após merge | 2.049 | 144 | 2.055 | `estimated: true` permanece |
| Sintético, após canonicalização | 2.049 | 144 | 2.193 | Total recalculado e marca de estimativa descartada |

**Causa na versão inicial.** Ao ver `finish_reason`, o [transformador](../../open-sse/utils/stream.js#L274) estima antes do evento real em passagem direta. Há lógica equivalente na [tradução](../../open-sse/utils/stream.js#L433). O [estimador](../../open-sse/utils/usageTracking.js#L356) usa o tamanho do JSON e do texto visível, aproximadamente quatro caracteres por token. A [margem de 2.000](../../open-sse/utils/usageTracking.js#L20) é somada à entrada e ao total. O [merge por máximo](../../open-sse/utils/usageTracking.js#L329) foi projetado para eventos cumulativos ou parciais de provedores e preserva a entrada estimada quando a entrada real é menor.

**Persistência na versão inicial.** O caminho de [finalização](../../open-sse/utils/stream.js#L108) chama [saveUsageStats](../../open-sse/handlers/chatCore/requestDetail.js#L118) uma vez no fluxo normal. A [transação](../../src/lib/db/repos/usageRepo.js#L243) alimenta `usageHistory`, `usageDaily` e o contador global com os dados canonicalizados. A sequência real acima poderia registrar `2048 + 144 = 2192` em uma linha e inflar o Dashboard. O teste automatizado em SQLite temporário reproduziu esse valor. Os registros da instalação ativa ficaram fora da validação. O filtro de duplicidade usa timestamp e contadores, portanto regravar uma tentativa com valores corrigidos pode criar outra linha. O [handler JSON](../../open-sse/handlers/chatCore/nonStreamingHandler.js#L285) também merece regressão: salva antes de [adicionar a margem ao retorno](../../open-sse/handlers/chatCore/nonStreamingHandler.js#L322).

**Histórico da margem.** O commit `7881db81`, de 3 de fevereiro de 2026, introduziu `addBufferToUsage` e a margem de 2.000 tokens nos formatos OpenAI e Claude para evitar erros de contexto em CLIs. O histórico local deixa em aberto qual cliente motivou a mudança e por que esse valor foi escolhido. Homologar com clientes CLI representativos e observar a compactação de contexto.

**Resultado após a correção.** A reprodução entrega um evento final com `19/144/163` e grava uma única linha com esses valores, incluindo detalhes de cache e raciocínio. O agregado diário registra a mesma entrada e saída. Estimativas ficam marcadas no JSON do SQLite. Um evento terminal com zero explícito e um JSON com zero explícito são contabilizados. Encerramentos sem consumo conhecido seguem a política de finalização. A rodada com `gpt-6-luna` confirmou o uso real em SSE com e sem `include_usage`, incluindo raciocínio no SQLite, sem margem artificial ou estimativa prematura nos cenários testados.

**Custo estimado.** A fórmula anterior somava o custo de toda a saída e mais uma parcela de raciocínio. Os 128 tokens de raciocínio já compõem os 144 de saída na amostra OpenAI. A [correção implementada](../../open-sse/providers/pricing.js#L481) reparte a saída entre raciocínio e demais tokens. Registros e agregados previamente gravados mantêm seus valores históricos. Detalhamentos negativos ou incompatíveis com os totais deixam o custo indisponível. A validação usou tarifas sintéticas e conferiu o histórico e os agregados em SQLite temporário.

**Aceite.** Uso real tem precedência. Com `include_usage`, o cliente recebe um único evento final de uso real quando disponível. Sem a opção, a contabilização interna pode ocorrer sem mudar o contrato do cliente. Se o uso real faltar até o término, manter a origem identificável na persistência. Cobrir interrupção, uma única linha por tentativa contabilizável e agregados consistentes.

## Bug 3 — Falso negativo do botão Test

**Validado com upstream simulado e OpenAI API.** O Dashboard mostrou `Provider returned no completion choices for this model` em testes de modelos OpenAI. Chamadas diretas geraram resposta. O JSON inválido do Bug 1 é uma causa reproduzida para a mensagem. Após a correção, o probe passou pela rota de chat com upstream simulado sem mudanças próprias. O botão Test também passou com `gpt-6-luna` na imagem ARM64.

**Reprodução sintética.** [pingModelByKind](../../src/app/api/models/test/ping.js#L194) mostrou exatamente essa mensagem com o JSON sintético seguido de `[DONE]`. Com o mesmo JSON limpo, retornou `ok: true`. A exceção de parse é ignorada, então HTTP 200 com corpo malformado cai na mesma mensagem que JSON com `choices` vazio.

**Hipóteses secundárias.** O probe usa 1.024 tokens e o [executor adapta](../../open-sse/translator/concerns/paramSupport.js#L59) `max_tokens` para `max_completion_tokens` no provedor OpenAI. Uma escolha limitada por raciocínio já pode passar. Conta, modelo e seleção da chave do probe também podem diferir de uma chamada manual. Priorizar a regressão do contrato JSON e separar no probe erro de protocolo, HTTP de erro e ausência de escolhas antes de avaliar mudanças de limite. [Seleção de chave](../../src/app/api/models/test/ping.js#L43) · [Validação da escolha](../../src/app/api/models/test/ping.js#L250)
