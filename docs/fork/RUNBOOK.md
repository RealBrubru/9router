# Runbook de desenvolvimento e operação

## Ambiente de referência

Linux ARM64, Docker com Compose, app Next.js standalone e SQLite. O [Dockerfile](../../Dockerfile) usa Node 22 Alpine, porta interna `20128` e `DATA_DIR=/app/data`. O SQLite fica em `${DATA_DIR}/db/data.sqlite`. Mantenha os dados, as credenciais e o Compose ativo fora do checkout. Registre nomes de hosts, endereços privados, caminhos reais e detalhes operacionais somente na documentação privada do ambiente.

## Testes

- Use a versão de Node indicada no [arquivo .nvmrc](../../.nvmrc). Em ambiente de desenvolvimento autorizado, instale as dependências do app e do pacote independente `tests/`. A partir de `tests/`, execute `npm test -- unit/<arquivo>.test.js` para os casos focados. Consulte [vitest.config.js](../../tests/vitest.config.js) e [as instruções para tradutores](../../tests/translator/AGENTS.md).
- Use fixtures, transporte simulado e um `DATA_DIR` temporário. Deixe `RUN_REAL` e `RUN_E2E` desativados. Antes de ampliar a suíte, compare o resultado com uma baseline do mesmo ambiente e confirme que os testes selecionados não dependem de credenciais. Veja [as divergências upstream](README.md) para a limitação do verificador histórico.
- Os [casos de aceite](BUGS.md) orientam regressões de formato HTTP, streaming, persistência e comportamento do botão Test.

## Build ARM64 e homologação

Execute em uma etapa autorizada, a partir do checkout da revisão a homologar. O build instala dependências dentro da imagem. O [workflow upstream](../../.github/workflows/docker-publish.yml#L125) é referência para runner ARM64 nativo e health check.

```sh
revision=$(git rev-parse --short HEAD)
docker buildx build --platform linux/arm64 --load \
  --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
  -t "9router-fork:arm64-$revision" .
docker image inspect --format '{{.Architecture}} {{.Id}}' "9router-fork:arm64-$revision"
```

1. Confirme `arm64` e registre revisão e ID local. Se a imagem for publicada com autorização, registre também o digest do manifesto. Use apenas o checkout como contexto e confira a [.dockerignore](../../.dockerignore). A ausência de lockfile versionado e o uso de `npm install` permitem resoluções diferentes entre builds.
2. Use projeto Compose ou nome de container dedicado, porta livre publicada somente em loopback, como `127.0.0.1:21128:20128`, e volume descartável em `/app/data`. Use credenciais fictícias, provedor simulado e rede de teste sem saída para provedores reais. O volume, o Compose e as variáveis da instalação ativa ficam fora do teste. A [inicialização do SQLite](../../src/lib/db/driver.js#L84) pode executar migrations automaticamente.
3. Verifique [`/api/health`](../../src/app/api/health/route.js), Dashboard e driver SQLite. Exercite `/v1/chat/completions` em JSON e SSE e confira o uso no Dashboard e no banco de teste. Reinicie a instância de teste para confirmar persistência. Se a revisão depender de módulos nativos ou de carregamento tardio, exercite também os caminhos afetados.

## Deploy e rollback

1. Com autorização, registre o estado atual e os identificadores das imagens anterior e candidata. Faça backup consistente do SQLite e da configuração em armazenamento privado e teste a restauração em volume separado. Considere o estado do WAL e a compatibilidade do esquema antes da troca.
2. Aplique apenas a imagem homologada, referenciada por digest quando publicada, mantendo a configuração de operação revisada. Valide saúde, contrato de API e persistência. Uso de provedores reais e alterações no Hermes dependem de autorização e da etapa correspondente do [roadmap](ROADMAP.md).
3. Se a validação falhar, reverta para a imagem e configuração anteriores. Se a versão anterior for incompatível com o banco alterado, use a restauração testada do backup, considerando as gravações feitas após o backup antes de decidir sobre a restauração.
