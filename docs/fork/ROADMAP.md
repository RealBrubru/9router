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
| 6. Eligibility Policies | Planejada | Restringir conexões por chave e aplicação em retries, combos e fallbacks. Definir políticas para usar apenas a franquia de assinatura quando o provedor permitir. |
| 7. Smart Budget & Quota Management | Planejada | Quota Manager, Budget Manager, Smart Router e Cost & Savings Dashboard. Adotar inicialmente orçamento diário adaptativo para recursos mensais, com opções configuráveis. |
| 8. Expansão de provedores e contas | Planejada | Configurar conexões autorizadas e validar elegibilidade e fallback com Codex, GitHub Copilot, OpenRouter, outros provedores e clientes CLI. |
| 9. Hermes | Planejada | Integrar e validar com credenciais e política próprias |

O detalhamento da homologação está no [runbook](RUNBOOK.md#homologação-inicial-com-openai-api). A etapa 7 amplia o Daily Token Budget. A investigação de fontes da OpenAI pode começar em paralelo à especificação de elegibilidade. A proteção preventiva depende da conciliação das fontes e da aplicação da elegibilidade em todos os caminhos de roteamento. [Decisões de orçamento e elegibilidade](DECISIONS.md#smart-budget--quota-management)

## Incrementos do Quota Manager

| Etapa | Entrega | Situação |
| --- | --- | --- |
| 7.1.1 — Quota Collector | Coleta passiva por organização, com SQLite e API interna de leitura | Homologação real (7.1.1e) concluída em ARM64 com OpenAI Usage e Costs. Retomada do agendamento confirmada após reinício. |
| 7.1.2a — Investigação | Inventariar o consumo local e remoto e definir a estratégia de conciliação | Concluída e aprovada. |
| 7.1.2b — Cálculo passivo | Motor puro, saldo indicativo corrente ou histórico, qualidade da observação e avaliação pelo conhecimento disponível | Aprovado e consolidado localmente. [Contrato](QUOTA-RECONCILIATION.md) |
| 7.1.2b+ — Reconciliation Read Service | Adaptar a leitura dos snapshots dimensionais e do histórico local, com cobertura e proveniência explícitas | Implementação e fixtures SQLite em revisão. Exposição pela API administrativa fica para rodada posterior. [Serviço de leitura](QUOTA-RECONCILIATION.md#serviço-interno-de-leitura) |
| 7.1.2c — Registro de tentativas | Persistir identidade, vínculo, estados, janelas e origem do uso | Planejada. |
| 7.1.2d — Conciliação fina | Avaliar buckets de minuto, revisões, chaves compartilhadas e virada em observação | Planejada. Coleta por minuto depende de homologação autorizada. |
| 7.1.3 — Quota Dashboard | Acompanhar franquias, configurar grupos e mostrar origem, cobertura e atualidade | Planejada. A configuração e a visualização dos snapshots podem começar após a coleta. Exibir saldo quando a conciliação o sustentar. |
| 7.1.4 — Quota Enforcement | Aplicar franquias na elegibilidade por conexão e no Smart Router | Planejada. Exige decisão explícita por tentativa, organização, política e janela, com reserva atômica. Depende de conciliação e de elegibilidade em retries, combos e fallbacks. |

Os três primeiros incrementos preservam o roteamento atual. A etapa 7.1.1 encerra o aceite da coleta passiva. Defasagem, classificação incompleta de modelos e renovação UTC em tempo real seguem registradas para as etapas seguintes. [Homologação real e limitações](QUOTA-COLLECTOR.md#homologação-real-na-imagem-arm64) · [Experimento administrativo anterior](RUNBOOK.md#experimento-com-a-openai-admin-usage-api)

## Backlog sem ordem rígida de implementação

- **Catálogo e preços.** Dynamic Model Discovery, Dynamic Pricing Discovery, Dynamic Free Model Discovery e Dynamic Discount Discovery.
- **Pricing UI e precisão monetária.** Oferecer edição manual com fonte, vigência e precisão adaptativa. Em Pricing Settings, investigar modal transparente, ausência de acesso pela navegação normal, lista restrita a GH e TOKENROUTER e texto da fórmula desatualizado. Verificar com fixtures a diferença entre a API de listagem e a resolução de preços por modelo. [Página](../../src/app/dashboard/settings/pricing/page.js) · [Repositório de preços](../../src/lib/db/repos/pricingRepo.js)
- **Free Tier Verification.** Verificação experimental da elegibilidade no backlog de Dynamic Free Model Discovery. [Procedimento proposto](DECISIONS.md#verificação-experimental-de-elegibilidade)
- **Diagnóstico e apresentação.** Granular Observability e Timezone Management.

Os escopos estão nas [propostas de descoberta e interface](DECISIONS.md#propostas-de-descoberta-e-interface).

## Backlog estratégico do projeto independente

Propostas futuras para o [PipoRouter](PROJECT.md#direção-para-um-projeto-independente), sem ordem rígida de implementação.

- **Licenças e distribuição.** Auditar licenças, dependências e assets. Inventariar os componentes efetivamente distribuídos e incluir os avisos e licenças correspondentes nas imagens e nos pacotes.
- **Privacidade e comunicação externa.** Remover o Google Analytics vinculado ao upstream, revisar a telemetria e a comunicação com serviços externos e adotar telemetria desativada por padrão.
- **Builds e publicação.** Versionar o lockfile, buscar builds reproduzíveis, preparar infraestrutura própria de CI/CD e desenvolver mecanismos próprios de publicação e atualização.
- **Evolução técnica.** Modularizar a arquitetura incrementalmente, migrar gradualmente para TypeScript, redesenhar a interface e avaliar a arquitetura de persistência em etapa própria.
