# Roadmap

Ordem aprovada para o início do fork. O proprietário pode revisar as prioridades conforme surgirem novas evidências.

| Etapa | Situação | Entrega |
| --- | --- | --- |
| 0. Infraestrutura inicial | Concluída | Instalação experimental e checkout separado dos dados e das credenciais |
| 1. Diagnóstico técnico inicial | Concluída | Fluxo de chat e achados registrados em [BUGS.md](BUGS.md), com escopo de validação por evidência |
| 2. Documentação e organização | Concluída | Onboarding, instruções de desenvolvimento e fluxo de branches |
| 3. Contrato JSON/SSE e botão Test | Homologada com OpenAI API | 120 testes aprovados em 11 arquivos, incluindo 14 novos cenários. JSON, SSE e botão Test passaram com upstream simulado e com `gpt-6-luna`. |
| 4. Contabilização, persistência e custo | Homologada com OpenAI API | Uso, raciocínio e custo teórico conferidos. A coleta administrativa confirmou consumo incentivado e coincidiu com os totais locais no escopo testado. Faturamento definitivo segue pendente. |
| 5. Imagem Docker ARM64 | Homologação inicial concluída | Validação sintética e validação real dos cenários com `gpt-6-luna` na imagem `dev-7afe9d48`. Outros provedores e clientes CLI reais seguem pendentes. |
| 6. Elegibilidade de conexões | Planejada | Restringir conexões por chave e aplicação em retries, combos e fallbacks. Definir políticas para usar apenas a franquia de assinatura quando o provedor permitir. |
| 7. Smart Budget & Quota Management | Planejada | Quota Manager, Budget Manager, Smart Router e Cost & Savings Dashboard. Adotar inicialmente orçamento diário adaptativo para recursos mensais, com opções configuráveis. |
| 8. Provedores e contas | Planejada | Configurar conexões autorizadas e validar elegibilidade e fallback com outros provedores e clientes CLI. |
| 9. Hermes | Planejada | Integrar e validar com credenciais e política próprias |

O detalhamento da homologação está no [runbook](RUNBOOK.md#homologação-inicial-com-openai-api). A etapa 7 amplia o Daily Token Budget. A investigação de fontes da OpenAI pode começar em paralelo à especificação de elegibilidade. A proteção preventiva depende da conciliação das fontes e da aplicação da elegibilidade em todos os caminhos de roteamento. [Decisões de orçamento e elegibilidade](DECISIONS.md#smart-budget--quota-management)

## Incrementos do Quota Manager

| Etapa | Entrega | Situação |
| --- | --- | --- |
| 7.1.1 — Quota Collector | Coleta passiva por organização, com SQLite e API interna de leitura | Homologação real (7.1.1e) concluída em ARM64 com OpenAI Usage e Costs. Retomada do agendamento confirmada após reinício. |
| 7.1.2 — Quota Reconciliation | Conciliar uso oficial, local, externo e requisições em andamento por janela e escopo | Planejada, aguardando autorização. Preparar fixtures de sobreposição, defasagem e virada UTC. |
| 7.1.3 — Quota Dashboard | Acompanhar franquias, configurar grupos e mostrar origem, cobertura e atualidade | Planejada. A configuração e a visualização dos snapshots podem começar após a coleta. Exibir saldo quando a conciliação o sustentar. |
| 7.1.4 — Quota Enforcement | Aplicar franquias na elegibilidade por conexão e no Smart Router | Planejada. Depende de conciliação, reservas e elegibilidade em retries, combos e fallbacks. |

Os três primeiros incrementos preservam o roteamento atual. A etapa 7.1.1 encerra o aceite da coleta passiva. Defasagem, classificação incompleta de modelos e renovação UTC em tempo real seguem registradas para as etapas seguintes. [Homologação real e limitações](QUOTA-COLLECTOR.md#homologação-real-na-imagem-arm64) · [Experimento administrativo anterior](RUNBOOK.md#experimento-com-a-openai-admin-usage-api)

## Backlog sem ordem rígida de implementação

- **Catálogo e preços.** Dynamic Model Discovery, Dynamic Pricing Discovery, Dynamic Free Model Discovery e Dynamic Discount Discovery.
- **Pricing Settings.** Investigar modal de edição com fundo transparente, ausência de acesso pela navegação normal, lista restrita a GH e TOKENROUTER apesar de haver outras tarifas internas e texto sobre a fórmula desatualizado. A página consulta a API de listagem, enquanto a precificação por modelo também tem um caminho de resolução próprio. Verificar a origem da diferença com fixtures. [Página](../../src/app/dashboard/settings/pricing/page.js) · [Repositório de preços](../../src/lib/db/repos/pricingRepo.js)
- **Free Tier Verification.** Verificação experimental da elegibilidade no backlog de Dynamic Free Model Discovery. [Procedimento proposto](DECISIONS.md#verificação-experimental-de-elegibilidade)
- **Diagnóstico e apresentação.** Granular Observability e Timezone Support.

Os escopos estão nas [propostas de descoberta e interface](DECISIONS.md#propostas-de-descoberta-e-interface).

## Backlog estratégico do projeto independente

Propostas futuras para a [direção BHRoute](PROJECT.md#direção-para-um-projeto-independente), sem ordem rígida de implementação.

- **Licenças e distribuição.** Auditar licenças, dependências e assets. Inventariar os componentes efetivamente distribuídos e incluir os avisos e licenças correspondentes nas imagens e nos pacotes.
- **Privacidade e comunicação externa.** Remover o Google Analytics vinculado ao upstream, revisar a telemetria e a comunicação com serviços externos e adotar telemetria desativada por padrão.
- **Builds e publicação.** Versionar o lockfile, buscar builds reproduzíveis, preparar infraestrutura própria de CI/CD e desenvolver mecanismos próprios de publicação e atualização.
- **Evolução técnica.** Modularizar a arquitetura incrementalmente, migrar gradualmente para TypeScript, redesenhar a interface e avaliar a arquitetura de persistência em etapa própria.
