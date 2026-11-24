# Runbook de desenvolvimento e operação

## Ambiente de referência

Linux ARM64, Docker com Compose, app Next.js standalone e SQLite. O [Dockerfile](../../Dockerfile) usa Node 22 Alpine, porta interna `20128` e `DATA_DIR=/app/data`. O SQLite fica em `${DATA_DIR}/db/data.sqlite`. Mantenha os dados, as credenciais e o Compose ativo fora do checkout. Registre nomes de hosts, endereços privados, caminhos reais e detalhes operacionais somente na documentação privada do ambiente.

## Testes

- Use a versão de Node indicada no [arquivo .nvmrc](../../.nvmrc). Em ambiente de desenvolvimento autorizado, instale as dependências do app e do pacote independente `tests/`. A partir de `tests/`, execute `npm test -- unit/<arquivo>.test.js` para os casos focados. Consulte [vitest.config.js](../../tests/vitest.config.js) e [as instruções para tradutores](../../tests/translator/AGENTS.md).
- Use fixtures, transporte simulado e um `DATA_DIR` temporário. Deixe `RUN_REAL` e `RUN_E2E` desativados. Antes de ampliar a suíte, compare o resultado com uma baseline do mesmo ambiente e confirme que os testes selecionados não dependem de credenciais. Veja [as divergências upstream](README.md) para a limitação do verificador histórico.
- Para a suíte offline, execute o Vitest em um container `--network none`, com `HOME` e `DATA_DIR` temporários. Exclua testes reais, live e ponta a ponta que possam usar serviços externos. Compare o fork e a revisão upstream com a mesma versão de Node, dependências e seleção de testes.
- Os [casos de aceite](BUGS.md) orientam regressões de formato HTTP, streaming, persistência e comportamento do botão Test.

## Build ARM64 e homologação

Execute em uma etapa autorizada, a partir do checkout da revisão a homologar. O build instala dependências dentro da imagem. O [workflow upstream](../../.github/workflows/docker-publish.yml#L125) é referência para runner ARM64 nativo e health check.

```sh
revision=$(git rev-parse HEAD)
short=$(git rev-parse --short HEAD)
git archive "$revision" | docker buildx build --platform linux/arm64 --load \
  --label "org.opencontainers.image.revision=$revision" \
  -t "9router-fork:dev-$short" -
docker image inspect --format '{{.Architecture}} {{.Id}}' "9router-fork:dev-$short"
```

1. Confira os arquivos versionados e a [.dockerignore](../../.dockerignore). O `git archive` restringe o contexto à revisão selecionada. Confirme `arm64` e registre revisão, ID local e digest disponível. A ausência de lockfile versionado e o uso de `npm install` permitem resoluções diferentes entre builds.
2. Use projeto Compose ou nome de container dedicado, porta livre publicada somente em loopback, como `127.0.0.1:21128:20128`, volume próprio em `/app/data` e logs com rotação. Guarde o arquivo de ambiente exclusivo fora do checkout com acesso restrito. Habilite autenticação do Dashboard e exija API key. O volume, o Compose e as variáveis da instalação ativa ficam fora do teste. A [inicialização do SQLite](../../src/lib/db/driver.js#L84) pode executar migrations automaticamente.
3. Verifique [`/api/health`](../../src/app/api/health/route.js), Dashboard e driver SQLite. Aponte a única conexão de teste para um upstream simulado em loopback, com uma chave fictícia. Exercite `/v1/chat/completions` em JSON e SSE e compare uso, custo zero e custo desconhecido no Dashboard, nas APIs de Analytics e no banco de teste. Reinicie a instância de teste para confirmar persistência.
4. Para validação manual remota, encaminhe a porta `21128` pelo VS Code Remote SSH ou use `ssh -L 21128:127.0.0.1:21128 <alias>`. Acesse `http://127.0.0.1:21128` localmente.

### Primeira homologação do fork

A imagem local `realbrubru/9router:dev-7afe9d48` corresponde ao commit `7afe9d48`. Foram validados `/api/health`, login, exigência de API key, JSON, SSE, o endpoint do botão Test, persistência após reinício e Usage & Analytics no Chromium. O teste conferiu o subtotal estimado no histórico e no agregado diário, incluindo tarifa zero e custo desconhecido.

A suíte offline registrou 4.852 aprovações, 69 falhas inesperadas, 14 falhas esperadas, 8 casos pulados e 1 pendente. As 69 falhas em 19 arquivos também ocorreram em `5ae63d22` com a seleção equivalente. A revisão final dos testes de Antigravity, Headroom e Ollama passou com 20 casos em 3 arquivos. Os ajustes desta rodada em documentação e testes dispensam um novo build da imagem em execução.

Para iniciar a homologação manual com dados limpos, use um volume novo e guarde o volume sintético para rollback. Recrie apenas a instância de homologação com a mesma imagem, o ambiente privado e a porta em loopback. Use o comando padrão da imagem e dispense a montagem da fixture. O arquivo de ambiente preserva a senha inicial e os segredos da instância. Um volume novo usa os padrões de autenticação e requer nova API key. Confira login, exigência de chave e Usage & Analytics vazio antes de cadastrar um provedor real.

## Deploy e rollback

1. Com autorização, registre o estado atual e os identificadores das imagens anterior e candidata. Faça backup consistente do SQLite e da configuração em armazenamento privado e teste a restauração em volume separado. Considere o estado do WAL e a compatibilidade do esquema antes da troca.
2. Aplique apenas a imagem homologada, referenciada por digest quando publicada, mantendo a configuração de operação revisada. Valide saúde, contrato de API e persistência. Uso de provedores reais e alterações no Hermes dependem de autorização e da etapa correspondente do [roadmap](ROADMAP.md).
3. Se a validação falhar, reverta para a imagem e configuração anteriores. Se a versão anterior for incompatível com o banco alterado, use a restauração testada do backup, considerando as gravações feitas após o backup antes de decidir sobre a restauração.
