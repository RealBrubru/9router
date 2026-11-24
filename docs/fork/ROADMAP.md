# Roadmap

Ordem aprovada para o início do fork. O proprietário pode revisar as prioridades conforme surgirem novas evidências.

| Etapa | Situação | Entrega |
| --- | --- | --- |
| 0. Infraestrutura inicial | Concluída | Instalação experimental e checkout separado dos dados e das credenciais |
| 1. Diagnóstico técnico inicial | Concluída | Fluxo de chat e achados registrados em [BUGS.md](BUGS.md), com escopo de validação por evidência |
| 2. Documentação e organização | Concluída | Onboarding, instruções de desenvolvimento e fluxo de branches |
| 3. Contrato JSON/SSE e botão Test | Implementada | 120 testes aprovados em 11 arquivos, incluindo 14 novos cenários. O falso negativo do botão Test foi resolvido com upstream simulado. A validação na imagem Docker fica na etapa 5. |
| 4. Contabilização, persistência e custo | Concluída em testes locais | Uso e custo estimado validados em SQLite temporário. O Dashboard distingue total parcial e custo indisponível. |
| 5. Imagem Docker ARM64 | Em andamento | Construir e homologar imagem própria em ambiente isolado |
| 6. Segregação de contas | Planejada | Restringir a elegibilidade de conexões por chave e cobrir retries e combos |
| 7. Smart Budget & Quota Management | Planejada | Especificar franquias, orçamentos, roteamento elegível e acompanhamento de custos |
| 8. Provedores e contas | Planejada | Configurar conexões autorizadas e validar elegibilidade e fallback |
| 9. Hermes | Planejada | Integrar e validar com credenciais e política próprias |

A etapa 7 amplia o Daily Token Budget. Começa pela especificação de unidades, janelas, fontes dos dados e limites por conexão. A proteção preventiva e os relatórios dependem da conciliação das fontes e da política de elegibilidade. Consulte a [direção futura](DECISIONS.md#smart-budget--quota-management).
