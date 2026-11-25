# Onboarding do fork 9Router

Este fork usa o 9Router como base para um gateway de LLMs com múltiplos provedores, controle de consumo e roteamento por política. A base do diagnóstico inicial é o commit `5ae63d22`, versão `0.5.123`.

| Documento | Conteúdo |
| --- | --- |
| [PROJECT.md](PROJECT.md) | Contexto, objetivos e colaboração |
| [ROADMAP.md](ROADMAP.md) | Ordem aprovada e situação das etapas |
| [BUGS.md](BUGS.md) | Evidências, reprodução sintética e pendências dos bugs |
| [DECISIONS.md](DECISIONS.md) | Decisões aprovadas e propostas abertas |
| [RUNBOOK.md](RUNBOOK.md) | Testes, build ARM64, homologação, deploy e rollback |
| [QUOTA-COLLECTOR.md](QUOTA-COLLECTOR.md) | Proposta técnica para o primeiro incremento do Quota Manager |
| [QUOTA-RECONCILIATION.md](QUOTA-RECONCILIATION.md) | Contrato e regras do cálculo passivo de conciliação |
| [AGENTS.md](../../AGENTS.md) | Instruções permanentes de desenvolvimento |

## Mapa do código

- `src/app/` contém o Dashboard e as rotas Next.js. O rewrite de `/v1/*` e o build standalone estão em [next.config.mjs](../../next.config.mjs).
- `src/sse/` autentica, resolve modelos e combos e seleciona conexões. O ponto de entrada de chat é [handleChat](../../src/sse/handlers/chat.js).
- `open-sse/` contém o [motor de chat](../../open-sse/handlers/chatCore.js), o registro de provedores, executores e tradutores. Consulte as [instruções locais](../../open-sse/AGENTS.md).
- `src/lib/db/` contém o driver SQLite e os repositórios. `cli/` contém o launcher. `tests/` contém o pacote Vitest e os [testes de tradução](../../tests/translator/AGENTS.md).

## Divergências da documentação upstream na base analisada

Use o [README](../../README.md), a [arquitetura](../ARCHITECTURE.md), o [guia Docker](../../DOCKER.md) e o [CLAUDE.md](../../CLAUDE.md) do upstream como referências gerais. Para os pontos abaixo, o código desta versão é a referência.

| Tema | Comportamento no checkout |
| --- | --- |
| Persistência | A arquitetura ainda descreve parte do estado em `db.json`. Ela e o `CLAUDE.md` mencionam `usage.json` e `log.txt` para uso e logs. O [shim usageDb](../../src/lib/usageDb.js) reexporta a camada SQLite, e [paths.js](../../src/lib/db/paths.js) trata esses formatos JSON de estado e uso como legados. O banco ativo fica em `${DATA_DIR}/db/data.sqlite`. |
| Testes | O `CLAUDE.md` menciona `NODE_PATH=/tmp/node_modules`. O [script atual](../../tests/package.json) executa Vitest diretamente. O [verificador histórico](../../tests/__baseline__/verify-no-regression.mjs) ainda pressupõe um caminho contendo `/app/`. |
| Docker e diretório de dados | O README descreve `/root/.9router` como link para `/app/data`. O [Dockerfile](../../Dockerfile) tenta criar o link apontando para `/app/data-home` e define explicitamente `DATA_DIR=/app/data`. Use `DATA_DIR` para a montagem. |
| Release | O guia Docker sugere `scripts/release.js`, ausente na base analisada. O [workflow Docker](../../.github/workflows/docker-publish.yml) recebe tags de release ou execução manual e valida as versões dos pacotes. |
