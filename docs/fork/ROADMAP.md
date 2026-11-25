# Roadmap

Ordem aprovada para o início do fork. O proprietário pode revisar as prioridades conforme surgirem novas evidências.

| Etapa | Situação | Entrega |
| --- | --- | --- |
| 0. Infraestrutura inicial | Concluída | Instalação experimental e checkout separado dos dados e das credenciais |
| 1. Diagnóstico técnico inicial | Concluída | Fluxo de chat e achados registrados em [BUGS.md](BUGS.md), com escopo de validação por evidência |
| 2. Documentação e organização | Concluída | Onboarding, instruções de desenvolvimento e fluxo de branches |
| 3. Contrato JSON/SSE e botão Test | Homologada com OpenAI API | 120 testes aprovados em 11 arquivos, incluindo 14 novos cenários. JSON, SSE e botão Test passaram com upstream simulado e com `gpt-6-luna`. |
| 4. Contabilização, persistência e custo | Homologada com OpenAI API | Uso, raciocínio e custo teórico conferidos no SQLite e em Usage & Analytics. Faturamento e elegibilidade à franquia seguem pendentes. |
| 5. Imagem Docker ARM64 | Homologação inicial concluída | Validação sintética e validação real dos cenários com `gpt-6-luna` na imagem `dev-7afe9d48`. Outros provedores e clientes CLI reais seguem pendentes. |
| 6. Elegibilidade de conexões | Planejada | Restringir conexões por chave e aplicação em retries, combos e fallbacks. Definir políticas para usar apenas a franquia de assinatura quando o provedor permitir. |
| 7. Smart Budget & Quota Management | Planejada | Quota Manager, Budget Manager, Smart Router e Cost & Savings Dashboard. Adotar inicialmente orçamento diário adaptativo para recursos mensais, com opções configuráveis. |
| 8. Provedores e contas | Planejada | Configurar conexões autorizadas e validar elegibilidade e fallback com outros provedores e clientes CLI. |
| 9. Hermes | Planejada | Integrar e validar com credenciais e política próprias |

O detalhamento da homologação está no [runbook](RUNBOOK.md#homologação-inicial-com-openai-api). A etapa 7 amplia o Daily Token Budget. A investigação de fontes da OpenAI pode começar em paralelo à especificação de elegibilidade. A proteção preventiva depende da conciliação das fontes e da aplicação da elegibilidade em todos os caminhos de roteamento. [Decisões de orçamento e elegibilidade](DECISIONS.md#smart-budget--quota-management)

## Próxima investigação do Quota Manager

1. Revisar a documentação oficial de `GET /v1/organization/usage/completions` para levantar permissões, escopo, filtros e agrupamentos por modelo, projeto, chave e `service_tier`. Registrar unidades, dimensões ausentes, janelas, paginação e como medir defasagem. Usar `GET /v1/organization/costs` como investigação complementar de custos.
2. Mapear quais dados permitem identificar consumo elegível à franquia e quais dependem de regras externas, grupos de modelos e horário oficial de renovação. Confirmar separadamente se a API expõe elegibilidade, saldo ou cobertura financeira antes de usar esses dados no roteamento.
3. Esboçar com fixtures uma conciliação por janela e escopo entre totais da organização e registros locais. Incluir uso externo, sobreposição, registros tardios e ausência de separação por projeto ou chave. Definir quando o resultado fica desconhecido ou defasado e qual fallback conservador se aplica.

O primeiro entregável é uma matriz de campos, fonte, granularidade, atualidade e limitações, acompanhada de exemplos sintéticos. Consultas a organizações reais ficam para uma etapa autorizada.

## Backlog sem ordem rígida de implementação

- **Catálogo e preços.** Dynamic Model Discovery, Dynamic Pricing Discovery, Dynamic Free Model Discovery e Dynamic Discount Discovery.
- **Diagnóstico e apresentação.** Granular Observability e Timezone Support.

Os escopos estão nas [propostas de descoberta e interface](DECISIONS.md#propostas-de-descoberta-e-interface).
