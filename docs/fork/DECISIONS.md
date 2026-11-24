# Decisões técnicas

## Aprovadas

- **Proximidade com o upstream.** Manter alterações pequenas, em commits com propósito claro. Preservar a documentação original e registrar aqui as decisões do fork.
- **Branches.** `master` é a integração estável. Usar `docs/*` para documentação, `fix/*` para correções, `feat/*` para funcionalidades e `sync/upstream-*` para integrações. A estrutura inicial usa uma única branch estável.
- **Testes e publicação.** Investigar a causa antes de corrigir e incluir regressões. Revisar as mudanças com o proprietário antes do primeiro commit. Seguir o [runbook](RUNBOOK.md) para operações de infraestrutura.
- **Segregação.** Contas pessoais e profissionais devem ficar em conjuntos elegíveis distintos. Hoje a [permissão do alvo](../../src/sse/services/keyAccess.js#L119) não restringe as [conexões ativas do provedor](../../src/sse/services/auth.js#L74). Duas chaves autorizadas para o mesmo modelo podem usar as mesmas contas. A segregação deve ser validada antes de habilitar fallback entre contas reais.

## Fluxo proposto para sincronização

Com a árvore limpa, atualizar as referências de `upstream`, revisar o que mudou desde a última integração e integrar em uma branch `sync/upstream-*` a partir de `master`. Executar regressões e revisar conflitos antes do merge em `master`. Preservar o histórico já publicado. Conferir o impacto das tags no [workflow Docker](../../.github/workflows/docker-publish.yml) antes da primeira release.

## Propostas para revisão

| Tema | Proposta |
| --- | --- |
| Contrato JSON/SSE | Orientar o despacho final pelo formato pedido pelo cliente e pelo formato efetivo do upstream. Manter o comportamento de transporte upstream nesta primeira correção, incluindo o streaming obrigatório de Codex. |
| Uso e custo | Aguardar o fim da oportunidade de receber uso real, consolidar a origem do dado e preservar as regras de merge para contadores reais parciais. Validar separadamente o custo de raciocínio. |
| Reprodutibilidade do build | Registrar commit e digest durante a homologação. Avaliar lockfile e fixação das entradas do build em mudança própria, após confirmar a política desejada para sincronizar com o upstream. |
| Daily Token Budget | Reservar saldo atomicamente antes de cada tentativa, liquidar pelo uso real com idempotência e manter uma política conservadora para consumo desconhecido. Usar o histórico local como insumo e avaliar reconciliação externa antes de prometer proteção contra cobranças. |
