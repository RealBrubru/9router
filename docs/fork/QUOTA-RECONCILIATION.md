# Quota Reconciliation — cálculo passivo

A investigação **7.1.2a** confirmou que o histórico local registra consumo na finalização, sem identidade durável por tentativa. Os buckets administrativos têm identidade, escopo e revisão. O adaptador OpenAI atual deixa a marca de completude nula. A entrega **7.1.2b** calcula uma indicação a partir de dados normalizados e evidências fornecidas pelo chamador. [Histórico local](../../src/lib/db/repos/usageRepo.js#L249) · [Snapshots do Collector](../../src/lib/db/repos/quotaRepo.js#L268) · [Adaptador OpenAI](../../src/lib/quota/openai.js#L240)

A função é pura. A etapa **7.1.2b+** adapta os dados locais. A **7.1.2b++** expõe a visão diagnóstica na API administrativa. O Attempt Registry está em piloto para envios OpenAI diretos e seus reenvios observáveis, com causalidade registrada e desligado por padrão. A etapa **7.1.2c4** integra as observações do piloto ao serviço de leitura, com cobertura local no máximo parcial. A homologação da coleta em granularidade de minuto e o controle de envio têm etapas próprias. [Motor](../../src/lib/quota/reconciliation.js) · [Attempt Registry](ATTEMPT-REGISTRY.md) · [Roadmap](ROADMAP.md#incrementos-do-quota-manager)

Para a 7.1.2c4, um encerramento recuperado continua sujeito ao que já estava disponível no SQLite ou chegou como evidência tardia. Cobertura local exige evidência própria para o escopo e o intervalo avaliados. Abertura ou fechamento de época e correspondência entre contagens do benchmark não certificam a população de inferências. [Recuperação e cobertura](ATTEMPT-REGISTRY.md#recuperação-cobertura-e-durabilidade)

## Contrato de entrada

`reconcileQuota({ policy, evaluatedAt, knowledgeAt?, localCoverage?, observations?, attempts?, evidence? })` avalia uma organização, grupo, revisão de política e unidade. As listas omitidas começam vazias. Datas são inteiros seguros em **milissegundos desde a época Unix**. Janelas usam `[start, end)`. A integração futura deve converter os segundos do Collector explicitamente.

| Entrada | Campos e semântica |
| --- | --- |
| `policy` | `scope` contém `organizationId`, `groupId`, `policyRevision` e `unit`. São obrigatórios `window` da franquia, `knownAt`, `validFrom`, `validTo` (nulo para vigência aberta), `resolution`, `usageScope`, `scale` (0 a 18), `limit`, `safetyMargin` (de 0 inclusive a 1 exclusive), `models` e `excludedModels`. As listas contêm modelos canônicos do grupo e modelos comprovadamente fora dele. |
| Limiares da política | `maxCollectionAgeMs` define a idade permitida desde a coleta. `maxObservationTailMs` define quanto a janela de referência pode terminar antes da avaliação e ainda ser indicada como corrente. `maxReportingLagMs` define a tolerância para lacunas diante de uma marca de completude informada. Esses parâmetros são independentes, em milissegundos. |
| `evaluatedAt`, `knowledgeAt` | O primeiro fixa o horizonte temporal do consumo, limitado ao fim da franquia. O segundo fixa até quando os fatos podem ser conhecidos. Por padrão são iguais. `knowledgeAt > evaluatedAt` produz uma reconstrução retrospectiva, sempre identificada na saída. |
| `localCoverage` | Declaração `{ status, knownAt }`. O estado é `complete`, `partial` ou `unknown` para a janela avaliada. Uma declaração ausente ou posterior ao corte é desconhecida. Uma lista vazia só representa ausência observada de tentativas se a cobertura for completa. |
| `observations[]` | `id` lógico estável, `revision` inteira crescente, `scope`, `source: "usage"`, `resolution`, `usageScope`, `populationCoverage`, `bucketWindow` nominal, `observedWindow` coberta pelos contadores, `status`, `collectedAt`, `knownAt`, `dataAsOf` (pode ser nulo) e `rows`. A população usa `complete`, `partial` ou `unknown`. O estado da observação é `observed`, `stale` ou `omitted`. Uma observação omitida tem lista vazia e deixa uma lacuna. |
| `observations[].rows[]` | `id` único na revisão e `amount` normalizado à unidade. Dimensões opcionais ou nulas incluem `model`, `projectId`, `apiKeyId`, `serviceTier` e `attemptId`. `incentive` usa `incentivized`, `not-incentivized` ou `unknown`. `origin` usa `gateway`, `external` ou `unknown`. `keyUse` usa `exclusive`, `shared` ou `unknown`. As três classificações têm padrão `unknown`. |
| `attempts[]` | `id`, `scope`, `window` de atribuição possível, `knownAt` e `state` entre `observed`, `estimated`, `pending` e `unknown`. `amount` é obrigatório nos dois primeiros estados e ausente ou nulo nos demais. Dimensões e `incentive` seguem a linha remota. Use `serviceTier` local quando a classificação administrativa for conhecida. Um estado sem medição pode trazer `reserved` e `upperBound: { amount, reference }`. |
| `evidence[]` | `id`, `basis`, `reference`, `attemptId`, `attemptKnownAt`, `observationId`, `revision`, `rowId`, `knownAt` e `amount`. A referência identifica o registro confiável que demonstrou o montante sobreposto. |

### Visibilidade e revisões

- A política deve ser conhecida até o corte e vigente para a janela da franquia. O chamador seleciona a revisão pertinente. Se ela estiver indisponível, o motor retorna indicação nula sem atribuir uso a essa política.
- A tentativa é identificada por `id`. Seu estado e os fatos associados são selecionados pelo último `knownAt` disponível. A janela da tentativa expressa onde o provedor **pode atribuir** o consumo. O `knownAt` expressa **quando** o gateway conheceu aquele estado, montante, reserva ou limite. O chamador fornece as versões anteriores necessárias para reconstruir o passado, consolida cada tentativa em um único estado por instante e declara a cobertura que consegue demonstrar.
- Para a resolução principal, cada identidade de bucket mantém o mesmo intervalo nominal, que pode conter várias versões da janela efetivamente observada. A revisão mais alta conhecida até o corte substitui a anterior. Isso permite avanço do bucket aberto, omissões e correções para baixo. Buckets nominais principais são disjuntos. Uma revisão com contadores que cruzam o horizonte avaliado não pode ser recortada nem substituída silenciosamente pela revisão anterior. As outras resoluções são informativas.
- `collectedAt` registra o fim da coleta. `knownAt` registra quando a observação e todos os seus metadados ficaram disponíveis, inclusive flags de estado se fornecidas. Uma prova só participa depois do seu `knownAt` e fica vinculada à revisão remota e ao estado local exato. Dados posteriores ao corte ficam fora da avaliação contemporânea. Uma reconstrução pode usar conhecimento posterior para o mesmo horizonte.
- Escopos ou fontes incompatíveis deixam a indicação nula e ficam fora dos subtotais. Campos estruturalmente inválidos geram `TypeError`. A futura integração responde pela origem das provas, pelas identidades estáveis, por linhas remotas disjuntas e pela semântica das classificações e dos limites superiores.

### Sobreposição e unidades

- **`verified-attempt`** exige identidade explícita comum à linha remota e à tentativa local. Pode servir a chaves compartilhadas com essa evidência.
- **`verified-exclusive-aggregate`** exige uma linha atribuída ao gateway, chave comprovadamente exclusiva para o intervalo e evidência do montante incluído para a tentativa. Contadores iguais, chave igual, idade ou `collectedAt` não demonstram inclusão.
- Ambas as formas exigem medição local, linha remota incentivada no grupo, modelo, projeto e chave compatíveis e contenção da janela de atribuição no intervalo observado. Um tier administrativo local conhecido também precisa coincidir. A prova deve ter sido conhecida após, ou junto de, suas duas origens.
- Cada tentativa admite uma dedução consolidada. O motor rejeita provas concorrentes, IDs repetidos, montantes acima do uso local ou remoto e conjuntos cujo total exceda uma linha remota. Uma revisão substituída torna indisponível a prova que a referencia.
- Montantes são strings decimais exatas. O motor recusa negativos, expoentes, números de ponto flutuante e frações além da escala. A integração normaliza a semântica do provedor. Para OpenAI Usage, o total em tokens usa entrada mais saída. Cache e raciocínio já incluídos ficam fora da soma. `Costs` continua como fonte financeira separada.

## Fórmula e saída

```text
teto após margem = limite − margem retida
subtotal considerado = remoto incentivado observado
                      + (local observado − sobreposição aceita)
                      + reservas + parcela dos limites superiores acima das reservas
saldo indicativo = max(0, teto após margem − subtotal considerado)
excedente indicativo = max(0, subtotal considerado − teto após margem)
```

A margem retida é `limite × safetyMargin`, arredondada para cima apenas até o menor incremento da unidade. As demais operações são exatas. Para uma tentativa sem medição, reserva e limite superior cobrem a mesma exposição e entram uma vez, pelo maior valor. Estimativas heurísticas aparecem separadamente. Se o limite estiver ausente, sem referência ou for menor que a estimativa, o motor preserva os dados conhecidos e registra a inconsistência ou a lacuna. Uma reserva, por si só, não demonstra um limite superior.

O resultado JSON inclui:

| Campo | Semântica |
| --- | --- |
| `indicative` | `amount`, `excess`, `status` (`current`, `historical`, `unknown`), `referenceWindow`, `consideredSubtotal`, `assumptions`, `limitations` e `blockers`. A interface usa o valor calculado pelo motor. |
| `quality.temporal`, `quality.population` | Cobertura dos intervalos recebidos em relação ao horizonte avaliado, lacunas na janela de referência e abrangência do escopo consultado. |
| `quality.collection`, `quality.completeness` | Idade e estado da coleta (`recent`, `stale`, `unknown)) e garantia de inclusão de eventos conforme a fonte (`complete`, `partial`, `unknown`). Uma coleta `stale` pode ter, ao mesmo tempo, completude `unknown`. Cada observação preserva seu `dataAsOf`, inclusive nulo. |
| `quality.local`, `quality.external` | Cobertura local conhecida no corte e risco de consumo externo ainda não reportado. Os valores externos observados e de origem indeterminada são preservados dentro do total incentivado. |
| `remote`, `local`, `overlap` | Subtotais diagnosticáveis, estados e limites locais, provas aceitas ou rejeitadas e revisões utilizadas. O `consideredSubtotal` no nível principal inclui o uso local conhecido até o horizonte avaliado. O subtotal dentro de `indicative` usa a janela de referência. Sem observação remota utilizável, `remote` e a indicação são nulos. |

**Indicação corrente.** Exige coleta recente, observações coerentes e representativas, cobertura local e ausência de lacunas impeditivas. Se a referência terminar antes do horizonte avaliado, a cauda não observada deve caber em `maxObservationTailMs` e aparece como limitação. Uma observação com consumo reportado pode sustentar a indicação com `dataAsOf: null`. Nesse caso, a saída explicita que só inclui o consumo externo já reportado. Um zero sem confirmação de completude permanece visível como subtotal e não produz indicação.

**Indicação histórica.** Uma coleta defasada, uma reconstrução retrospectiva, uma janela encerrada ou uma cauda acima da tolerância podem fornecer um valor histórico para uma janela de referência coerente. Lacunas materiais dentro dessa referência, escopo ou classificação incompatível, cobertura local insuficiente ou uso potencialmente elegível sem limite superior defensável mantêm `amount: null`. As versões de tentativas que atravessam a renovação podem contribuir com todo o montante possível em cada avaliação independente. A soma dessas avaliações exige resolver a atribuição.

**Limite de responsabilidade.** Um saldo indicativo positivo não autoriza consumo. O futuro serviço de enforcement deverá decidir explicitamente por tentativa, organização, revisão da política e janela, com reserva atômica vinculada à decisão. O motor passivo fornece evidências e hipóteses para essa política. O controle de envio pertence ao serviço de decisão.

### Exemplos sintéticos

Com franquia de 1.000 tokens, margem de 100 e nenhuma sobreposição demonstrada:

| Cenário | Resultado |
| --- | --- |
| Coleta recente com `dataAsOf: null`, remoto 600 e local medido 250 | Subtotal 850, indicação corrente de 50 sob a hipótese de consumo externo conforme reportado. |
| Mesmos números, coleta defasada | Subtotal 850, indicação histórica de 50, com janela de referência e completude ainda desconhecida. |
| Nova janela sem observação válida | Consumo remoto desconhecido e indicação nula. |
| Remoto 600, local medido 250 e tentativa pendente com reserva de 40 sem limite superior | Subtotal conhecido de 890 e indicação nula, com a razão `local_without_upper_bound`. |

## Serviço interno de leitura

`createQuotaReconciliationReadService(db, { now? }).read({ organizationId, groupId, resolution?, evaluatedAt?, knowledgeAt? })` recebe um adaptador SQLite já aberto e faz uma leitura transacional. O chamador será responsável pela autorização por organização antes de qualquer exposição. O serviço usa o dia da organização em **UTC às 00:00**, para grupos OpenAI em tokens. `resolution` usa `1d` por padrão ou `1m` para leitura de dados já armazenados. A avaliação e o conhecimento usam o instante da leitura se omitidos. [Serviço](../../src/lib/quota/reconciliationReadService.js) · [Fixtures SQLite](../../tests/unit/quota-reconciliation-read-service.test.js)

| Saída | Semântica |
| --- | --- |
| `status: "available"` | Visão diagnóstica obtida. `policyBasis: "current_config_only"` identifica a configuração atual usada para classificar dados. O fingerprint identifica essa configuração sem afirmar sua vigência passada. |
| `result` | Escopo, janela, avaliação, sinais de qualidade, subtotal oficial remoto e indicação produzida pelo motor. Nesta etapa, a indicação permanece nula pela cobertura local incompleta ou desconhecida. Os valores remotos e locais conhecidos aparecem separadamente, sem subtotal conciliado. |
| `provenance.remote` | Buckets do escopo **Usage sem filtros**, agrupado por modelo, tier, projeto e chave administrativa. Cada bucket preserva intervalo nominal, intervalo devolvido pelo provedor, janela da consulta, janela efetivamente observada, horário de coleta, estado, marca de completude e `revisionRef` da coleção materializada. O ordinal `revision: 0` serve à chamada do motor e o `revisionRef` identifica a revisão persistida. |
| `provenance.local` | Linhas identificáveis de `usageHistory`, classificadas como uso medido, estimado ou desconhecido. A identidade é da linha SQLite. A cobertura é parcial quando há linhas atribuíveis e desconhecida quando elas faltam. Subtotais sem valores medidos ou estimados ficam nulos. Uma medição zero explícita é preservada. O retorno sinaliza truncamento quando a seleção ultrapassa 10.000 linhas candidatas. |
| `status: "unavailable"` | Motivo explícito e `result: null` para escopo inexistente, escopo não suportado, precisão de política não suportada ou estado histórico indisponível. |

O repositório fornece linhas anteriores ao rollup da API administrativa. O serviço escolhe um escopo e uma resolução por leitura. A revisão atual substitui a anterior. Uma omissão preserva a identidade da coleção que a registrou, com lista de contadores vazia. Dimensões duplicadas deixam o bucket inutilizável. Contadores de um bucket que se estende além do horizonte solicitado ficam disponíveis como proveniência da observação original e são rejeitados pelo motor para aquele cálculo. A marca `dataAsOf: null` é preservada.

O histórico seleciona timestamps ISO UTC no intervalo semiaberto. Um vínculo vigente naquele timestamp é contexto da linha, e o vínculo efetivo no despacho permanece desconhecido. Linhas sem vínculo demonstrável e conexões com vínculos em mais de uma organização ficam fora da atribuição. O serviço fornece diagnósticos locais ao lado do resultado e passa apenas a cobertura ao motor, pois uma linha de histórico não identifica uma tentativa. A igualdade de dimensões ou contadores não produz prova de sobreposição.

A referência administrativa de chave e projeto é apresentada como identificador opaco por organização. O resultado exclui credenciais, chaves de clientes, payloads e referências de secrets. A fonte atual também deixa a origem do tráfego desconhecida. Um ID sem vínculo local pode corresponder a uso externo, e o valor comprovadamente externo permanece nulo enquanto essa origem não for demonstrável.

**Limite histórico.** As tabelas guardam o bucket materializado, a última coleta e a configuração atual. O histórico não registra quando cada linha ficou visível, nem versões da política ou estados anteriores da tentativa. O serviço usa o instante da leitura para `knownAt`. Um pedido com corte de conhecimento anterior à leitura, ou referente a outro dia UTC, retorna `historical_state_unavailable`. A reconstrução no mesmo dia com conhecimento atual usa somente os contadores que cabem no horizonte pedido e continua indeterminada em relação ao saldo.

### Evidência local do Attempt Registry

A 7.1.2c4 usa o mesmo snapshot SQLite que protege a autorização e a leitura administrativa. Captura o último número de sequência disponível e considera os eventos com ocorrência até `evaluatedAt`, conhecimento até `knowledgeAt` e gravação até esse corte. Uma evidência tardia pode revisar uma leitura retrospectiva quando já estava gravada no corte de conhecimento e sua ocorrência pertence ao horizonte. Quando políticas ou snapshots administrativos históricos não podem ser reconstruídos, a API mantém `historical_state_unavailable`.

A identidade, a causalidade, a revisão, o estado e o vínculo de despacho permanecem no serviço interno. O vínculo registrado tem precedência sobre rotações posteriores. Uma conexão com vínculo desconhecido só aparece como candidata se havia configuração vigente no ingresso e a conexão pertenceu exclusivamente à organização no histórico disponível. Isso limita a exposição entre organizações, sem confirmar qual credencial foi usada. As tentativas inconclusivas conservam a janela possível entre o despacho e o horizonte da leitura. Tentativas que cruzam a renovação exibem o valor observado como evidência da tentativa, sem atribuí-lo integralmente a um dia.

Somente tentativas concluídas, com vínculo `confirmed`, modelo do grupo demonstrável e janela dentro da franquia, podem fornecer valor completo ao motor como medição ou estimativa. Uso parcial, vínculo `configured` ou `unknown`, janela incerta e tentativas pendentes continuam diagnósticos e razões de indeterminação. O motor permanece puro. Uma tentativa conhecida não comprova inclusão nos buckets da Usage API e o serviço fornece zero provas de sobreposição.

O campo `local.totals` preserva os subtotais do histórico legado. `local.registry` acrescenta subtotais separados de uso medido, parte conhecida de uso parcial e estimativa, com contagens por qualidade, finalidade e vínculo. `pending` e `crossesWindow` são dimensões que podem coincidir com outra contagem. `linkedHistoryRows` conta somente linhas presentes nos dois recortes e com vínculo persistido em `inferenceUsageLinks`. Os subtotais das duas origens **não podem ser somados**. O motor recebe tentativas do Registry e mantém o legado como diagnóstico, evitando duplicação mesmo quando falta associação verificável.

A leitura aceita até mil candidatas do Registry por consulta e informa truncamento. `gapEpochs` conta lacunas conhecidas de épocas das tentativas visíveis no escopo. Falhas anteriores à gravação e caminhos não instrumentados podem ficar sem evidência atribuível. Um total nulo representa ausência de medição naquela categoria, e uma tentativa interrompida não preenche esse total com zero. Com a cobertura parcial ou desconhecida, o valor indicativo permanece nulo. A cobertura e `dataAsOf` do Collector preservam seus próprios estados.

## API administrativa de conciliação

`GET /api/quota/organizations/{orgId}/groups/{groupId}/reconciliation` exige uma sessão administrativa assinada em `auth_token` e usa a mesma autorização dos snapshots do Collector. A sessão local representa o operador. Uma sessão OIDC precisa de emissor e sujeito explicitamente autorizados para a organização. A validação se aplica mesmo com `requireLogin=false`. Chaves de inferência e tokens de CLI não concedem acesso. [Rota](../../src/app/api/quota/organizations/%5BorgId%5D/groups/%5BgroupId%5D/reconciliation/route.js) · [Testes](../../tests/unit/quota-reconciliation-api.test.js)

| Parâmetro | Regra |
| --- | --- |
| `orgId` e `groupId` | De 1 a 160 caracteres ASCII alfanuméricos, com hífen ou sublinhado. |
| `resolution` | `1d` por padrão ou `1m` para dados já coletados. |
| `evaluatedAt` | Instante UTC em milissegundos desde a época Unix. O padrão é o instante da leitura. |
| `knowledgeAt` | Corte explícito de conhecimento em milissegundos. Exige `evaluatedAt`. O padrão é o instante da leitura. |

Parâmetros repetidos, desconhecidos, futuros ou com `evaluatedAt > knowledgeAt` retornam `400`. Omitir os dois cortes produz uma avaliação contemporânea. Um `evaluatedAt` anterior no mesmo dia com `knowledgeAt` omitido pede reconstrução com o conhecimento da leitura atual.

Uma resposta `200` com `status: "available"` inclui o escopo e a janela, os horários da avaliação, `quality` com cobertura temporal e de população, atualidade, completude, cobertura local e incerteza externa, além de `remote`, `local.totals`, limitações locais, observações resumidas e `indicative`. A rota preserva os estados `current`, `historical` e `unknown` produzidos pelo motor. Com o histórico disponível hoje, a cobertura local deixa a indicação nula. Os subtotais medidos continuam acessíveis.

Um corte que o banco não consegue reconstruir retorna `200` com `status: "unavailable"`, `reason: "historical_state_unavailable"`, os cortes de avaliação e `result: null`. Sessão ausente ou inválida retorna `401`. Uma organização inexistente ou sem acesso retorna o mesmo `404`. Um grupo inexistente em organização autorizada retorna `404`. Escopo válido fora do suporte desta etapa retorna `422`. Dados indisponíveis ou adaptador ainda não inicializado retornam `503` com mensagem genérica.

Todas as respostas do handler usam `Cache-Control: private, no-store`. Os resumos de observação trazem horários, janela e qualidade. Linhas individuais, modelos, revisões internas e identificadores de projetos, chaves e conexões ficam fora da resposta. A rota consulta o SQLite já inicializado e usa transações de leitura, inclusive no fallback `sql.js`. O atendimento não dispara coleta, inicialização do banco nem autorização de inferência.
