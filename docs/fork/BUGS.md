# Problemas conhecidos

**Escopo das evidências.** As observações na instalação experimental foram relatadas pelo proprietário. O diagnóstico rastreou o código no commit `5ae63d22`. As reproduções sintéticas executaram trechos do checkout em memória, com entradas e dependências simuladas. A imagem em execução, seu digest e as linhas do SQLite ativo ainda precisam de verificação autorizada. Os testes permanentes entram nas branches de correção.

## Bug 1 — JSON inválido com `stream: false`

**Correção implementada.** Na instalação experimental, o POST em `/v1/chat/completions` com `openai/gpt-5-mini`, `max_completion_tokens: 1024` e `stream: false` recebeu HTTP 200. O corpo tinha um JSON completo com `choices` e `usage`, seguido de `data: [DONE]`, e o tipo era `text/event-stream`. O parser retornou `Extra data: line 36 column 1 (char 797)`. Acrescentar `Accept: application/json` produziu o mesmo problema.

**Evidência no código.** O [registro da OpenAI](../../open-sse/providers/registry/openai.js#L26) força o sinal interno de streaming. O [core](../../open-sse/handlers/chatCore.js#L145) ignora a preferência JSON nesse caso. O [executor](../../open-sse/executors/default.js#L287) usa o sinal no cabeçalho, enquanto [o envio](../../open-sse/executors/base.js#L143) serializa o corpo que conserva `stream: false`. Ao receber JSON, [a conversão forçada](../../open-sse/handlers/chatCore/sseToJsonHandler.js#L189) devolve `null`, e o [despacho](../../open-sse/handlers/chatCore.js#L526) cai no [handler SSE](../../open-sse/handlers/chatCore/streamingHandler.js#L67).

**Reprodução sintética.** O transformador em passagem direta repassou um JSON de teste e anexou `data: [DONE]` após a chave final. O [flush](../../open-sse/utils/stream.js#L482) explica o sufixo. Essa reprodução isolou o transformador. A correção foi verificada pela rota de chat com upstream simulado. A rodada final aprovou 120 testes em 11 arquivos, incluindo 14 novos cenários de regressão. A imagem Docker em uso ainda aguarda validação.

**Aceite.** Para `stream: false`, obter um único objeto JSON com `application/json` e sem delimitadores SSE, com ou sem `Accept`. Se o upstream enviar SSE, agregá-lo no formato pedido pelo cliente. Preservar SSE para `stream: true` e o transporte de provedores que dependem dele.

## Bug 2 — Estimativa prematura e consumo consolidado incorretamente

**Aberto.** Os números abaixo resultam de chamadas distintas na instalação experimental e de uma reprodução sintética. O número de tokens de raciocínio pode variar entre chamadas.

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

**Causa no código.** Ao ver `finish_reason`, o [transformador](../../open-sse/utils/stream.js#L274) estima antes do evento real em passagem direta. Há lógica equivalente na [tradução](../../open-sse/utils/stream.js#L433). O [estimador](../../open-sse/utils/usageTracking.js#L356) usa o tamanho do JSON e do texto visível, aproximadamente quatro caracteres por token. A [margem de 2.000](../../open-sse/utils/usageTracking.js#L20) é somada à entrada e ao total. O [merge por máximo](../../open-sse/utils/usageTracking.js#L329) foi projetado para eventos cumulativos ou parciais de provedores e preserva a entrada estimada quando a entrada real é menor.

**Persistência e impacto previstos.** O caminho de [finalização](../../open-sse/utils/stream.js#L108) chama [saveUsageStats](../../open-sse/handlers/chatCore/requestDetail.js#L118) uma vez no fluxo normal. A [transação](../../src/lib/db/repos/usageRepo.js#L243) alimenta `usageHistory`, `usageDaily` e o contador global com os dados canonicalizados. A sequência real acima poderia registrar `2048 + 144 = 2192` em uma linha e inflar o Dashboard. Esse valor é inferido do código. A linha real ainda precisa de conferência. O filtro de duplicidade usa timestamp e contadores, portanto regravar uma tentativa com valores corrigidos pode criar outra linha. O [handler JSON](../../open-sse/handlers/chatCore/nonStreamingHandler.js#L285) também merece regressão: salva antes de [adicionar a margem ao retorno](../../open-sse/handlers/chatCore/nonStreamingHandler.js#L322).

**Custo.** A [fórmula](../../open-sse/providers/pricing.js#L480) soma o custo de toda a saída e mais uma parcela de raciocínio. Como os 128 tokens de raciocínio já compõem os 144 de saída na amostra OpenAI, há risco de contagem duplicada no custo exibido. Confirmar a semântica de cada provedor antes de alterar a fórmula.

**Aceite.** Uso real tem precedência. Com `include_usage`, o cliente recebe um único evento final de uso real quando disponível. Sem a opção, a contabilização interna pode ocorrer sem mudar o contrato do cliente. Se o uso real faltar até o término, manter a origem identificável na persistência. Cobrir interrupção, uma única linha por tentativa contabilizável e agregados consistentes.

## Bug 3 — Falso negativo do botão Test

**Resolvido no teste com upstream simulado.** O Dashboard mostrou `Provider returned no completion choices for this model` em testes de modelos OpenAI. Chamadas diretas geraram resposta. O JSON inválido do Bug 1 é uma causa reproduzida para a mensagem. Após a correção do Bug 1, o probe passou pela rota de chat com upstream simulado sem mudanças no próprio probe. A instalação Docker ainda aguarda validação.

**Reprodução sintética.** [pingModelByKind](../../src/app/api/models/test/ping.js#L194) mostrou exatamente essa mensagem com o JSON sintético seguido de `[DONE]`. Com o mesmo JSON limpo, retornou `ok: true`. A exceção de parse é ignorada, então HTTP 200 com corpo malformado cai na mesma mensagem que JSON com `choices` vazio.

**Hipóteses secundárias.** O probe usa 1.024 tokens e o [executor adapta](../../open-sse/translator/concerns/paramSupport.js#L59) `max_tokens` para `max_completion_tokens` no provedor OpenAI. Uma escolha limitada por raciocínio já pode passar. Conta, modelo e seleção da chave do probe também podem diferir de uma chamada manual. Priorizar a regressão do contrato JSON e separar no probe erro de protocolo, HTTP de erro e ausência de escolhas antes de avaliar mudanças de limite. [Seleção de chave](../../src/app/api/models/test/ping.js#L43) · [Validação da escolha](../../src/app/api/models/test/ping.js#L250)
