# Decisões técnicas

## Aprovadas

- **Proximidade com o upstream.** Manter alterações pequenas, em commits com propósito claro. Preservar a documentação original e registrar aqui as decisões do fork.
- **Branches.** `master` é a integração estável. Usar `docs/*` para documentação, `fix/*` para correções, `feat/*` para funcionalidades e `sync/upstream-*` para integrações. A estrutura inicial usa uma única branch estável.
- **Testes e publicação.** Investigar a causa antes de corrigir e incluir regressões. Revisar as mudanças com o proprietário antes do primeiro commit. Seguir o [runbook](RUNBOOK.md) para operações de infraestrutura.
- **Segregação.** Contas pessoais e profissionais devem ficar em conjuntos elegíveis distintos. Hoje a [permissão do alvo](../../src/sse/services/keyAccess.js#L119) não restringe as [conexões ativas do provedor](../../src/sse/services/auth.js#L74). Duas chaves autorizadas para o mesmo modelo podem usar as mesmas contas. A segregação deve ser validada antes de habilitar fallback entre contas reais.
- **Integridade do uso.** Usar o consumo informado como fonte prioritária. Preservar estimativas com origem identificável no JSON existente. Manter a consolidação de eventos reais parciais e validar a retirada da margem de contexto com clientes CLI na homologação.
- **Repositório independente aprovado para etapa futura.** Criar `RealBrubru/piporouter` após a homologação e publicação do Quota Dashboard, preservando `RealBrubru/9router`, todo o histórico Git, os autores, as licenças e as atribuições. Manter a possibilidade de incorporar seletivamente melhorias do upstream original. O nome é PipoRouter, com posicionamento Open Source AI Infrastructure e slogan “Your AI. Your resources. Your rules.”. A verificação de disponibilidade, a criação e a configuração dos remotes pertencem à etapa de transição. [Direção estratégica](PROJECT.md#direção-para-um-projeto-independente)
- **Conciliação passiva.** O saldo indicativo preserva a janela, as hipóteses e a qualidade das informações. A futura autorização de envio exige decisão própria por tentativa, organização, política e janela, vinculada à reserva atômica. [Contrato de conciliação](QUOTA-RECONCILIATION.md)
- **Attempt Registry.** Propagar contexto explícito e registrar na fronteira semântica do envio. Recuperar somente com evidência de que a instância encerrou. O piloto usa Observation e fica desativado por padrão. Required e a retenção configurável seguem no backlog. [Persistência e recuperação](ATTEMPT-REGISTRY.md)

- **Simplicidade por design.** Preferir a solução mais simples que satisfaça requisitos demonstráveis. Priorizar uma primeira versão útil com segurança, integridade, privacidade e controle financeiro. Abstrair a complexidade interna da experiência do usuário e adiar melhorias não essenciais até haver benefício demonstrado. [Foco da primeira versão](PROJECT.md#foco-da-primeira-versão)
- **Persistência do Attempt Registry.** Adotar a configuração C, com releitura comum a todos os drivers, commit conjunto do modelo e uso e commit separado do desfecho. Manter o experimento `RETURNING` no histórico. [Comparação](ATTEMPT-REGISTRY-PROFILING.md#comparação-do-agrupamento-semântico)

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
- **Cost & Savings Dashboard.** Exibir consumo, franquias, créditos e custos com origem identificável. Explicitar a referência da economia e distinguir cobrança adicional, assinatura, custo teórico de API e faturamento confirmado.

Para a OpenAI API, o [experimento administrativo](RUNBOOK.md#experimento-com-a-openai-admin-usage-api) confirmou `incentivized-tier` e coleta com escopo Usage de leitura. Limites, agrupamentos de modelos e renovação devem ser configurados por organização. A margem inicial proposta de **10%**, ajustável, reduz o risco de cobrança mesmo com consumo externo, mas não garante custo zero. Para créditos financeiros, considerar saldo, expiração, defasagem e consumo externo. Para GitHub Copilot, verificar a cobertura do Quota Tracker frente ao ciclo e aos créditos vigentes. Para Codex, aplicar as permissões e janelas de cada conexão. Manter o desenho extensível a OpenRouter e outros provedores.

### Distribuição de orçamento por ciclo

Para recursos mensais, o **orçamento diário adaptativo** é a política inicial preferida, aprovada para implementação futura. Divide o saldo operacional pelos dias elegíveis restantes e redistribui o saldo não utilizado ao longo do ciclo. Por exemplo, US$ 100 em 22 dias úteis dão uma cota inicial aproximada de US$ 4,55. As opções configuráveis incluem o modo **fixo**, com uma cota diária definida, e o modo **livre**, com uso a qualquer momento dentro do limite do ciclo.

O calendário poderá usar dias úteis ou corridos, com margem de segurança configurável. Ao atingir a cota operacional diária, o roteador poderá fazer fallback para um recurso elegível. Uma opção explícita poderá permitir ultrapassar a cota diária dentro do limite mensal, respeitando a margem. A política vale para tokens, créditos e valores financeiros.

### Elegibilidade e proteção de créditos adicionais

Permitir políticas de uso restritas à franquia da assinatura, considerando janelas simultâneas, como cinco horas e uma semana. A proteção de créditos adicionais pagos depende de dados atualizados e do que o provedor permite consultar ou controlar. Se o gateway não puder distinguir a franquia de uma cobrança adicional com segurança suficiente, a política restritiva deve impedir a seleção daquela conexão e buscar fallback elegível.

## Propostas de descoberta e interface

| Tema | Escopo |
| --- | --- |
| Dynamic Model Discovery | Consultar catálogos nos provedores manualmente e em intervalos configuráveis. Identificar modelos novos ou descontinuados e capacidades disponíveis, preservando modelos personalizados. |
| Dynamic Pricing Discovery | Investigar fontes oficiais e o Model Cost Map do LiteLLM. Reutilizar a API e a página de preços para atualização automática e edição manual. Registrar fonte, vigência, atualidade e preços genéricos ou desconhecidos. Preservar custos históricos e adaptar a precisão monetária da interface. |
| Dynamic Free Model Discovery | Identificar ofertas gratuitas e seus provedores, limites, restrições, disponibilidade e desempenho. Distinguir gratuidade pública de franquias da conta. |
| Dynamic Discount Discovery | Detectar preços promocionais, condições, vigência, alterações e encerramentos. Expor os dados ao Smart Router. |
| Granular Observability | Configurar níveis, metadados e conteúdo separadamente, por aplicação ou API key. Definir retenção e proteção de dados sensíveis, diagnosticar decisões de roteamento e exibir a configuração efetiva. Avisar ou desabilitar controles sobrescritos pelo ambiente. Incluir Request Lifecycle Dashboard com a matriz de cobertura do registro de tentativas. |
| Timezone Management | Configurar o fuso de apresentação e aplicá-lo de forma consistente. Manter separado o fuso oficial de renovação de cada franquia. Investigar a aparente apresentação em UTC nos gráficos do Overview. |

A descoberta atualiza o catálogo. O envio de dados exige autorização explícita para a conexão e a aplicação.

### Verificação experimental de elegibilidade

Em Dynamic Free Model Discovery, a proposta é descobrir o modelo, verificar sua elegibilidade documentada, executar um microteste de inferência expressamente autorizado e consultar o uso administrativo para verificar `incentivized-tier`. Registrar a evidência, a organização e a data. Exigir orçamento específico para experimentos potencialmente pagos e usar apenas conteúdo sintético. O resultado vale para aquele teste. Grupo de franquia e gratuidade futura exigem evidências próprias.
