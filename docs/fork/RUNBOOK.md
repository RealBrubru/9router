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

### Operação da homologação do Quota Collector

Provisione a organização localmente com `putOrganization` enquanto o coletor global estiver desativado. Registre os limites e os modelos conforme a organização, com a janela de renovação e a margem acordadas. Guarde a Admin Key de leitura fora do checkout e do SQLite e monte seu diretório em modo somente leitura. Ao ativar o coletor na instância isolada, aguarde o primeiro ciclo com o Dashboard fechado. Compare Usage e Costs com consultas administrativas independentes para o mesmo escopo e janela, usando o tráfego já existente. Após o reinício, confira `lastSuccess.collectedAt` e `schedule.nextAt`. [Resultado da homologação ARM64](QUOTA-COLLECTOR.md#homologação-real-na-imagem-arm64)

Na homologação, `read-quota.py usage` retornou HTTP `404` porque o ID local padrão do auxiliar era diferente do ID provisionado. Liste as organizações acessíveis com `read-quota.py list` e informe o ID local com `read-quota.py usage --org <id-local>` ou `read-quota.py costs --org <id-local>`. Esse ajuste resolveu a consulta. O endpoint de snapshots espera o ID local retornado pela listagem. Se o `404` persistir, confira a autorização da sessão para a organização.

### Homologação integrada do Quota Manager

A imagem local `realbrubru/9router:dev-b492e205` foi construída com `git archive` e Buildx ARM64 a partir de `b492e2056eaa5958e3b9d12795d96af2d0679116`, com o rótulo OCI da revisão e sem publicação. O digest local do índice foi `sha256:e832d33c70b45b9f19a73169f6a743490bcc37e4d7358f50c0212684cb910cdf`. O runtime é Node 22.23.4, Next.js 16.4.6, better-sqlite3 12.11.1 e SQLite 3.53.2. O contexto veio do Git e os testes de conteúdo da imagem encontraram ausência de banco, arquivo de ambiente local e segredo de sessão incorporados.

| Suíte offline, mesmo ambiente | Base original `5ae63d22` | Fork `b492e205` |
| --- | ---: | ---: |
| Arquivos coletados | 458 | 476 |
| Passaram | 4.827 | 5.096 |
| Falhas de caso | 49 | 49 |
| Falhas esperadas | 14 | 14 |
| Pulados | 14 | 16 |
| Pendentes | 1 | 1 |

A comparação por arquivo e nome encontrou as mesmas 49 falhas, todas conhecidas do baseline histórico. As duas revisões também apresentaram os mesmos três erros de suíte em `db-benchmark` por falta de `lowdb`, `embeddings.cloud` por falta do checkout Cloud e `nvidia-params` por falta de casos coletáveis. A execução usou Node ARM64 em `--network none`, código extraído por Git, dependências separadas e `DATA_DIR` temporário. Foram excluídos `translator/real/**`, `unit/mimo-free.live.test.js`, `unit/rtk.e2e.test.js` e `unit/rtk.multi-provider.e2e.test.js`. Outros casos condicionados a credenciais ou rede permaneceram desativados.

A nova instância sintética usa volume próprio, rede Docker interna sem saída externa e acesso via relay limitado ao loopback. Ela inicia com `QUOTA_COLLECTOR_ENABLED=false`, `ATTEMPT_REGISTRY_OPENAI_DIRECT=false`, `MODEL_CATALOG_SYNC=off` e `ENABLE_REQUEST_LOGS=false`. O SQLite novo executou 001, 002 e 003. Em outro SQLite sintético descartável, o standalone atualizou 002 → 003, gerou backup pré-migration e preservou as linhas de uso e quota. Nos dois bancos, `integrity_check=ok` e `foreign_key_check` devolveu zero linhas.

Depois de reiniciar a instância sintética, passaram novamente healthcheck, login, autorização, integridade e persistência. A API de conciliação apresentou 163 tokens no histórico e 163 no Registry como valores separados, com um vínculo persistido, 80 tokens no snapshot remoto simulado, `dataAsOf: null`, cobertura local parcial e saldo indicativo nulo. Os endpoints administrativos rejeitaram acesso anônimo e chave de inferência. A rota Chat Completions rejeitou a ausência de chave e devolveu 404 sem conexão ativa para requisições JSON e SSE autenticadas. Os respectivos fluxos de sucesso foram exercitados com transporte simulado na suíte offline.

#### Próxima rodada, mediante autorização

1. Use um volume limpo para separar o Analytics da rodada real e preserve o volume sintético para rollback. Na primeira inicialização real, use um nome e uma porta loopback livres, em outra rede dedicada, com um arquivo privado de ambiente que mantenha o coletor e o Registry desligados. Estas variáveis referem-se exclusivamente à nova homologação. `state` aponta para o diretório privado com `tools/provision.mjs`, `env_file` para o arquivo de ambiente da rodada real e `port` para uma porta loopback livre.

   ```bash
   docker network create "$real_network"
   docker volume create "$real_data_volume"
   docker run -d --name "$container" --network "$real_network" \
     --publish "127.0.0.1:$port:20128" --env-file "$env_file" \
     --mount "type=volume,src=$real_data_volume,dst=/app/data" \
     --mount "type=bind,src=$state/tools,dst=/fixture,readonly" \
     --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 "$image"
   base="http://127.0.0.1:$port"
   curl -fsS "$base/api/health"
   ```

   Cadastre a conexão OpenAI no Dashboard. No diretório privado, prepare `organization.json` com `organization` aceito por `putOrganization` e `bindings` com `connectionId`, `apiKeyId`, `projectId` opcional e `validFrom` em ms UTC. Use os modelos e limites verificados pelo proprietário, com `minuteEnabled: false` e só a referência opaca da Admin Key. Execute o auxílio local `provision.mjs` enquanto o coletor global está desligado.

   ```sh
   docker exec --user node -i "$container" node /fixture/provision.mjs < "$state/organization.json"
   ```

2. Instale a Admin Key restrita em um volume próprio, fora do SQLite e da imagem. Este exemplo recebe o segredo sem pô-lo nos argumentos do processo. Use um volume novo e acessível apenas ao runtime da homologação. Mantenha a API key de inferência separada e cadastre-a pelo Dashboard.

   ```bash
   docker volume create "$quota_secrets_volume"
   read -rsp 'Admin Key restrita: ' admin_key; printf '\n'
   printf '%s\n' "$admin_key" | docker run --rm --network none -i \
     --mount "type=volume,src=$quota_secrets_volume,dst=/secrets" \
     --entrypoint sh "$image" -ceu '
       umask 077
       cat > /secrets/openai-homolog
       chown node:node /secrets /secrets/openai-homolog
       chmod 700 /secrets
       chmod 400 /secrets/openai-homolog
     '
   unset admin_key
   ```

   Use `credentialRef: "ref:openai-homolog"`. No arquivo privado de ambiente, defina `QUOTA_COLLECTOR_SECRETS_DIR=/run/quota`, `QUOTA_COLLECTOR_SECRET_REFS=ref:openai-homolog`, `QUOTA_COLLECTOR_ENABLED=true`, `ATTEMPT_REGISTRY_OPENAI_DIRECT=true` e mantenha catálogo e conteúdo desativados. Recrie somente a homologação destinada à rodada real com o mesmo comando e volume de dados, acrescentando `--mount "type=volume,src=$quota_secrets_volume,dst=/run/quota,readonly"` antes da imagem. Permita saída à OpenAI na rede dedicada dessa rodada. Preserve as instalações anteriores e a homologação sintética. [Provisionamento do Collector](#operação-da-homologação-do-quota-collector)

3. Aguarde uma coleta com o Dashboard fechado. Consulte o estado da organização e confirme que o Registry está restrito ao piloto direto. Depois da autorização explícita, execute uma requisição JSON e uma SSE de baixo custo. Passe o cabeçalho com chave local pelo stdin do `curl`, usando um prompt sintético e modelo verificado no Dashboard.

   ```bash
   read -rsp 'API key da homologação: ' gateway_key; printf '\n'
   for stream in false true; do
     jq -n --arg model "$model" --argjson stream "$stream" '
       {model:$model, messages:[{role:"user",content:"Responda apenas OK"}],
        stream:$stream, max_completion_tokens:128}
       + if $stream then {stream_options:{include_usage:true}} else {} end
     ' > "$state/request.json"
     printf 'header = "Authorization: Bearer %s"\n' "$gateway_key" | \
       curl --config - -fsS -N -H 'Content-Type: application/json' \
         --data-binary "@$state/request.json" "$base/v1/chat/completions"
   done
   unset gateway_key
   ```

4. Com o cookie privado de uma sessão administrativa, compare as leituras locais e a Usage API para a mesma janela e chave. Consulte Costs separadamente. Distinga ausência de lançamento, zero explícito e faturamento confirmado. Compare eventos do Registry com o Analytics, confira `dataAsOf` e interprete eventual saldo indicativo pelas hipóteses e lacunas retornadas. Consumo local e remoto sobrepostos exigem evidência independente, e o teste controlado deixa a cobertura geral em aberto.

   ```sh
   scope="$base/api/quota/organizations/$org"
   curl -fsS -b "$cookiejar" "$scope/snapshots?source=usage"
   curl -fsS -b "$cookiejar" "$scope/snapshots?source=costs"
   curl -fsS -b "$cookiejar" "$scope/groups/$group/reconciliation"
   ```

### Observability e aba Details

Quando `ENABLE_REQUEST_LOGS` está definida, somente o valor `true`, sem distinção de maiúsculas, habilita Details. Isso tem precedência sobre `enableObservability` no Dashboard. Sem a variável, o valor booleano do Dashboard prevalece. `OBSERVABILITY_ENABLED` é o fallback quando a configuração da interface não fornece um booleano. Para devolver o controle ao Dashboard, remova `ENABLE_REQUEST_LOGS` do ambiente do container e recrie somente a instância autorizada. [Precedência no repositório de detalhes](../../src/lib/db/repos/requestDetailsRepo.js#L13)

A Observability pode permanecer desativada. A contabilização de tokens e do custo estimado usa um caminho independente que continua alimentando `usageHistory`, `usageDaily` e Usage & Analytics. [Registro de uso](../../open-sse/handlers/chatCore/requestDetail.js#L111) · [Persistência de uso e custo](../../src/lib/db/repos/usageRepo.js#L249)

Na rodada real, a remoção de `ENABLE_REQUEST_LOGS=false` devolveu os metadados à aba Details. A interface exibiu `{"redacted": true}` em Client Request, Provider Request e Provider Response, e `[No content]` em Client Response. Pelo código, a API substitui os campos de conteúdo **depois da leitura** do SQLite. O repositório pode gravar os campos recebidos com sanitização de cabeçalhos da requisição do cliente e truncamento. O conteúdo armazenado dessa requisição não foi inspecionado. [API de detalhes](../../src/app/api/usage/request-details/route.js#L49) · [Persistência](../../src/lib/db/repos/requestDetailsRepo.js#L99)

## Deploy e rollback

1. Com autorização, registre o estado atual e os identificadores das imagens anterior e candidata. Faça backup consistente do SQLite e da configuração em armazenamento privado e teste a restauração em volume separado. Considere o estado do WAL e a compatibilidade do esquema antes da troca.
2. Aplique apenas a imagem homologada, referenciada por digest quando publicada, mantendo a configuração de operação revisada. Valide saúde, contrato de API e persistência. Uso de provedores reais e alterações no Hermes dependem de autorização e da etapa correspondente do [roadmap](ROADMAP.md).
3. Se a validação falhar, reverta para a imagem e configuração anteriores. Se a versão anterior for incompatível com o banco alterado, use a restauração testada do backup, considerando as gravações feitas após o backup antes de decidir sobre a restauração.
