# Desenvolvimento do fork 9Router

- Comece pelo [onboarding do fork](docs/fork/README.md). Consulte o [roadmap](docs/fork/ROADMAP.md) e as [decisões](docs/fork/DECISIONS.md) antes de mudar comportamento.
- Mantenha as mudanças pequenas e próximas do upstream. Investigue a causa antes de corrigir, cubra bugs com testes de regressão e discuta mudanças de contrato ou escopo com o proprietário.
- Respeite as instruções locais, em especial [open-sse/AGENTS.md](open-sse/AGENTS.md) e [tests/translator/AGENTS.md](tests/translator/AGENTS.md).
- Use mocks e dados fictícios. Mantenha credenciais, bancos, logs com dados reais e detalhes privados de infraestrutura fora do Git. Chamadas pagas exigem autorização.
- Use o [runbook](docs/fork/RUNBOOK.md) para build e homologação. Alterações na instalação ativa, em containers, no banco existente ou no Hermes exigem autorização específica. Faça push somente quando solicitado.
