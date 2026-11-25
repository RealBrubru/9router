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

### Homologação sintética

A imagem local `realbrubru/9router:dev-7afe9d48` corresponde ao commit `7afe9d48`. Foram validados `/api/health`, login, exigência de API key, JSON, SSE, o endpoint do botão Test, persistência após reinício e Usage & Analytics no Chromium. O teste conferiu o subtotal estimado no histórico e no agregado diário, incluindo tarifa zero e custo desconhecido.

A suíte offline registrou 4.852 aprovações, 69 falhas inesperadas, 14 falhas esperadas, 8 casos pulados e 1 pendente. As 69 falhas em 19 arquivos também ocorreram em `5ae63d22` com a seleção equivalente. A revisão final dos testes de Antigravity, Headroom e Ollama passou com 20 casos em 3 arquivos. Os ajustes desta rodada em documentação e testes dispensam um novo build da imagem em execução.

Para iniciar a homologação manual com dados limpos, use um volume novo e guarde o volume sintético para rollback. Recrie apenas a instância de homologação com a mesma imagem, o ambiente privado e a porta em loopback. Use o comando padrão da imagem e dispense a montagem da fixture. O arquivo de ambiente preserva a senha inicial e os segredos da instância. Um volume novo usa os padrões de autenticação e requer nova API key. Confira login, exigência de chave e Usage & Analytics vazio antes de cadastrar um provedor real.

### Homologação inicial com OpenAI API

Na rodada manual relatada pelo proprietário, a imagem `realbrubru/9router:dev-7afe9d48` passou com `gpt-6-luna`. Foram validados cadastro da conexão e do modelo, botão Test, JSON com `stream: false`, SSE com um único evento final de uso real ao pedir `include_usage: true`, SSE sem esse evento quando a opção foi omitida, Usage & Analytics e persistência no SQLite. Nas chamadas verificadas, o uso real prevaleceu sem margem de 2.000 tokens ou estimativa prematura.

Em leitura de `usageHistory`, as sete requisições bem-sucedidas somaram **117 tokens de entrada, 129 de saída e 246 no total**. Os 38 tokens de raciocínio já estavam incluídos na saída. O subtotal teórico de **US$ 0,0000762** confere com as tarifas internas da revisão. O registro SSE sem `include_usage` conservou internamente 19 tokens de entrada, 46 de saída e 28 de raciocínio. A rodada administrativa posterior confirmou consumo incentivado no escopo observado. A conciliação com faturamento definitivo e a homologação com outros provedores e clientes CLI reais seguem pendentes.

O modelo tem [capacidades](../../open-sse/providers/capabilities.js#L345) e [tarifas](../../open-sse/providers/pricing.js#L100) no checkout. O [catálogo padrão da OpenAI](../../open-sse/providers/registry/openai.js#L31) ainda exige adicioná-lo como modelo personalizado. A [API de preços](../../src/app/api/pricing/route.js) oferece `GET`, `PATCH` e `DELETE`. O acesso direto a `/dashboard/settings/pricing` foi confirmado na homologação. As limitações da página estão no [backlog](ROADMAP.md#backlog-sem-ordem-rígida-de-implementação).

### Experimento com a OpenAI Admin Usage API

O proprietário validou `GET /v1/organization/usage/completions` e `GET /v1/organization/costs` com uma Admin API Key **Restricted**, **Usage API Scope: Read** e demais permissões em **None**. Usage aceitou os agrupamentos combinados `model`, `service_tier`, `project_id` e `api_key_id`, além do filtro `api_key_ids`. Chaves distintas no mesmo projeto permitiram separar o consumo de aplicações. Uma inferência com tier `default` apareceu no agregado administrativo como `incentivized-tier`. A classificação do incentivo deve vir da fonte administrativa.

| Snapshot da organização | Entrada | Saída | Total | Requisições |
| --- | ---: | ---: | ---: | ---: |
| `gpt-6-luna` | 10.589 | 1.950 | 12.539 | 9 |
| `gpt-6.1-sol` | 182.075 | 7.867 | 189.942 | 5 |
| Total | 192.664 | 9.817 | 202.481 | 14 |

Todo o snapshot acima foi classificado como `incentivized-tier`. O total usa entrada mais saída. Leitura e escrita de cache já entram na entrada. No filtro pela chave exclusiva do gateway, os totais coincidiram com o SQLite antes do microteste (`7` chamadas, `117/129/246`) e depois (`8`, `131/134/265`).

O microteste de `14/5` tokens ocorreu entre 15:04:43 e 15:04:45 UTC em 25/11/2026. A consulta, entre 15:06:55 e 15:06:56 UTC, já incluía a chamada no bucket UTC `15:04–15:05` de `1m`. A API também retornou buckets vazios. **131 segundos** é o limite superior observado para essa chamada. A defasagem exata e a distribuição em outras condições seguem desconhecidas.

Na consulta de sete dias de Costs agrupada por `line_item`, observaram-se lançamentos com quantidades positivas e `amount.value` de `0.0 USD`. Entre as categorias da resposta estavam entrada, saída, leitura de cache e escrita de cache, inclusive com retenção de 12 horas. O dia corrente ainda não apareceu em Costs, embora já estivesse em Usage. Preserve a distinção entre custo explicitamente zerado, ausência de lançamento e informação defasada.

O Dashboard oficial mostrou 1 milhão e 10 milhões de tokens diários para os dois grupos e compartilhamento de inputs e outputs em todos os projetos da organização experimental. Esses valores são específicos daquele escopo. A lista de modelos do tooltip estava desatualizada em relação à documentação oficial. Confirme a configuração por organização e registre a fonte da lista de modelos. [Regras oficiais do programa](https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai)

### Observability e aba Details

Quando `ENABLE_REQUEST_LOGS` está definida, somente o valor `true`, sem distinção de maiúsculas, habilita Details. Isso tem precedência sobre `enableObservability` no Dashboard. Sem a variável, o valor booleano do Dashboard prevalece. `OBSERVABILITY_ENABLED` é o fallback quando a configuração da interface não fornece um booleano. Para devolver o controle ao Dashboard, remova `ENABLE_REQUEST_LOGS` do ambiente do container e recrie somente a instância autorizada. [Precedência no repositório de detalhes](../../src/lib/db/repos/requestDetailsRepo.js#L13)

A Observability pode permanecer desativada. A contabilização de tokens e do custo estimado usa um caminho independente que continua alimentando `usageHistory`, `usageDaily` e Usage & Analytics. [Registro de uso](../../open-sse/handlers/chatCore/requestDetail.js#L111) · [Persistência de uso e custo](../../src/lib/db/repos/usageRepo.js#L249)

Na rodada real, a remoção de `ENABLE_REQUEST_LOGS=false` devolveu os metadados à aba Details. A interface exibiu `{"redacted": true}` em Client Request, Provider Request e Provider Response, e `[No content]` em Client Response. Pelo código, a API substitui os campos de conteúdo **depois da leitura** do SQLite. O repositório pode gravar os campos recebidos com sanitização de cabeçalhos da requisição do cliente e truncamento. O conteúdo armazenado dessa requisição não foi inspecionado. [API de detalhes](../../src/app/api/usage/request-details/route.js#L49) · [Persistência](../../src/lib/db/repos/requestDetailsRepo.js#L99)

## Deploy e rollback

1. Com autorização, registre o estado atual e os identificadores das imagens anterior e candidata. Faça backup consistente do SQLite e da configuração em armazenamento privado e teste a restauração em volume separado. Considere o estado do WAL e a compatibilidade do esquema antes da troca.
2. Aplique apenas a imagem homologada, referenciada por digest quando publicada, mantendo a configuração de operação revisada. Valide saúde, contrato de API e persistência. Uso de provedores reais e alterações no Hermes dependem de autorização e da etapa correspondente do [roadmap](ROADMAP.md).
3. Se a validação falhar, reverta para a imagem e configuração anteriores. Se a versão anterior for incompatível com o banco alterado, use a restauração testada do backup, considerando as gravações feitas após o backup antes de decidir sobre a restauração.
