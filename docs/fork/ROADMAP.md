# Roadmap

Ordem aprovada para o início do fork. O proprietário pode revisar as prioridades conforme surgirem novas evidências.

| Etapa | Situação | Entrega |
| --- | --- | --- |
| 0. Infraestrutura inicial | Concluída | Instalação experimental e checkout separado dos dados e das credenciais |
| 1. Diagnóstico técnico inicial | Concluída | Fluxo de chat e achados registrados em [BUGS.md](BUGS.md), com escopo de validação por evidência |
| 2. Documentação e organização | Concluída | Onboarding, instruções de desenvolvimento e fluxo de branches |
| 3. Contrato JSON/SSE e botão Test | Em andamento | Corrigir o despacho da resposta e validar o probe com upstream simulado |
| 4. Contabilização, persistência e custo | Planejada | Dar precedência ao uso real, preservar a origem, validar SQLite e Analytics e corrigir a fórmula de preço conforme o provedor |
| 5. Imagem Docker ARM64 | Planejada | Construir e homologar imagem própria em ambiente isolado |
| 6. Segregação de contas | Planejada | Restringir a elegibilidade de conexões por chave e cobrir retries e combos |
| 7. Daily Token Budget | Planejada | Especificar regras por provedor e implementar controle preventivo |
| 8. Provedores e contas | Planejada | Configurar conexões autorizadas e validar elegibilidade e fallback |
| 9. Hermes | Planejada | Integrar e validar com credenciais e política próprias |

A etapa 7 precisa definir franquia por identidade da conta e grupo de modelos, janela e reset configuráveis, margem de segurança, política de cache e raciocínio, reserva concorrente, persistência, liquidação por uso real e fallback autorizado. A interface deve mostrar uso e reservas. A conciliação de consumo externo depende da granularidade, do atraso e das permissões das fontes oficiais. Limites, modelos elegíveis e regras de cada provedor serão verificados nessa etapa. Consulte a [proposta técnica](DECISIONS.md).
