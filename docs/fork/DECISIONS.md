# Decisões técnicas

## Aprovadas

- **Proximidade com o upstream.** Manter alterações pequenas, em commits com propósito claro. Preservar a documentação original e registrar aqui as decisões do fork.
- **Branches.** `master` é a integração estável. Usar `docs/*` para documentação, `fix/*` para correções, `feat/*` para funcionalidades e `sync/upstream-*` para integrações. A estrutura inicial usa uma única branch estável.
- **Testes e publicação.** Investigar a causa antes de corrigir e incluir regressões. Revisar as mudanças com o proprietário antes do primeiro commit. Seguir o [runbook](RUNBOOK.md) para operações de infraestrutura.
- **Segregação.** Contas pessoais e profissionais devem ficar em conjuntos elegíveis distintos. Hoje a [permissão do alvo](../../src/sse/services/keyAccess.js#L119) não restringe as [conexões ativas do provedor](../../src/sse/services/auth.js#L74). Duas chaves autorizadas para o mesmo modelo podem usar as mesmas contas. A segregação deve ser validada antes de habilitar fallback entre contas reais.
- **Integridade do uso.** Usar o consumo informado como fonte prioritária. Preservar estimativas com origem identificável no JSON existente. Manter a consolidação de eventos reais parciais e validar a retirada da margem de contexto com clientes CLI na homologação.

## Fluxo proposto para sincronização

Com a árvore limpa, atualizar as referências de `upstream`, revisar o que mudou desde a última integração e integrar em uma branch `sync/upstream-*` a partir de `master`. Executar regressões e revisar conflitos antes do merge em `master`. Preservar o histórico já publicado. Conferir o impacto das tags no [workflow Docker](../../.github/workflows/docker-publish.yml) antes da primeira release.

## Propostas para revisão

| Tema | Proposta |
| --- | --- |
| Contrato JSON/SSE | Orientar o despacho final pelo formato pedido pelo cliente e pelo formato efetivo do upstream. Manter o comportamento de transporte upstream nesta primeira correção, incluindo o streaming obrigatório de Codex. |
| Custo estimado | Calcular a partir do uso e das tarifas conhecidas, com semântica explícita de categorias e sem sobreposição. |
| Reprodutibilidade do build | Registrar commit e digest durante a homologação. Avaliar lockfile e fixação das entradas do build em mudança própria, após confirmar a política desejada para sincronizar com o upstream. |
| Smart Budget & Quota Management | Evolução futura do Daily Token Budget com políticas de franquia, orçamento e elegibilidade por conexão. |

## Uso, custo e faturamento

| Conceito | Significado |
| --- | --- |
| Actual Usage | Consumo medido e informado pelo provedor |
| Estimated Usage | Estimativa sinalizada quando a medição não chega |
| Reserved Budget | Capacidade reservada preventivamente para requisições em andamento |
| Estimated Cost | Valor teórico do uso às tarifas configuradas. Pode ser parcial ou indisponível conforme os dados disponíveis |
| Free Allowance | Parcela do consumo coberta por franquia |
| Payable Cost | Estimativa do valor a pagar após franquias e benefícios |
| Actual Billing | Valor confirmado pelo provedor |
| Savings | Economia estimada em relação a uma alternativa de roteamento |

Esta etapa trata do **Estimated Cost**. As novas estimativas aplicam as tarifas conhecidas a categorias sem sobreposição. O histórico retém o custo registrado à época, inclusive valores calculados pela fórmula anterior. Zeros históricos podem representar ausência de tarifa no cálculo antigo. Franquias, reservas, economia e faturamento ficam para etapas próprias.


## Smart Budget & Quota Management

- **Quota Manager.** Controlar tokens, créditos, requisições e outras unidades por conta ou conexão, com janelas diárias, mensais ou específicas do provedor. Registrar origem, atualidade e estado do uso.
- **Budget Manager.** Controlar orçamento, saldo promocional, validade e renovação. Reservar saldo atomicamente para requisições em andamento, liquidar de forma idempotente e conciliar uso externo sem duplicação.
- **Smart Router.** Ordenar recursos com prioridades configuráveis, incluindo expiração mais próxima. Verificar modelo, ferramentas e contexto. Aplicar elegibilidade por chave e aplicação em combos, retries e fallbacks. Exigir opção explícita para recursos pagos e adotar fallback conservador com dados ausentes ou defasados.
- **Cost & Savings.** Exibir consumo, franquias, créditos e custos com origem identificável. Explicitar a referência da economia e distinguir cobrança adicional, assinatura, custo teórico de API e faturamento confirmado.

Investigar para a OpenAI API os endpoints `GET /v1/organization/usage/completions` e `GET /v1/organization/costs`, permissões administrativas, agregação por modelo, projeto, chave e `service_tier`, latência e granularidade. Confirmar os critérios oficiais de elegibilidade, grupos e renovação antes de aplicar uma margem inicial sugerida de **10%**, ajustável. Projetos externos podem consumir a franquia mesmo com margem. Para créditos financeiros, considerar saldo, expiração, defasagem e consumo externo. Para GitHub Copilot, verificar a cobertura do Quota Tracker frente ao ciclo e aos créditos vigentes. Para Codex, aplicar as permissões e janelas de cada conexão. Manter o mesmo desenho extensível a OpenRouter e outros provedores.
