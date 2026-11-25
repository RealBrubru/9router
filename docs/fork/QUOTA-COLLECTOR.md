# Proposta técnica do Quota Collector

Escopo da etapa **7.1.1**. Adaptador, persistência, agendador e API interna de leitura foram consolidados na branch de desenvolvimento. A imagem ARM64 passou na homologação inicial e na homologação real **7.1.1e** com OpenAI Usage e Costs. Consulte o [experimento anterior](RUNBOOK.md#experimento-com-a-openai-admin-usage-api) e os [incrementos seguintes](ROADMAP.md#incrementos-do-quota-manager).

## Composição e reaproveitamento

| Componente | Uso proposto |
| --- | --- |
| [Quota Tracker](../../src/app/(dashboard)/dashboard/quota/page.js) e [ProviderLimits](../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js#L271) | Reaproveitar a apresentação na etapa de Dashboard. Hoje a página consulta por conexão, tem atualização periódica no navegador e [cache local](../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js#L195). |
| [Adaptadores de uso](../../open-sse/services/usage.js#L93) e [rota por conexão](../../src/app/api/usage/%5BconnectionId%5D/route.js#L134) | Reaproveitar o padrão de normalização por provedor. A rota atual usa a identidade da conexão e pode renovar OAuth. O adaptador administrativo é separado, com credencial e escopo de organização. |
| [Auto-ping](../../src/shared/services/quotaAutoPing.js#L294) e [agendas](../../src/shared/services/quotaPingSchedule.js) | Reaproveitar ideias de controle de sobreposição e histórico de tentativas. O auto-ping atual é opcional para Claude e Codex, usa caches em memória, persiste marcadores por conexão e pode enviar inferência. Para o coletor, usar um agendador próprio de GETs. |
| [Inicialização do servidor](../../src/instrumentation.js) e [sincronização do catálogo](../../src/lib/modelCatalog/sync.js#L256) | A instrumentação Node inicia o coletor, independentemente de páginas abertas. O coletor ignora fases de build e usa uma instância por processo. A versão inicial assume um processo por diretório de dados. CLI e Docker standalone precisam de homologação com a imagem candidata. |
| [Histórico local](../../src/lib/db/repos/usageRepo.js#L249) e [seleção de conexões](../../src/sse/services/auth.js#L74) | Na conciliação, usar timestamps de `usageHistory` na fronteira UTC da franquia. `usageDaily` agrega no fuso do processo. A pré-filtragem existente de Antigravity é referência para Enforcement, fora da etapa do coletor. |

O núcleo agenda por **organização e fonte** e usa um adaptador por provedor. O primeiro adaptador traduz páginas de Usage e Costs da OpenAI em buckets com janela, dimensões, unidades, valores, origem e timestamps. Os identificadores e valores desconhecidos são preservados como tais. As categorias de cache ficam disponíveis como detalhe do total, e o tier é o informado na fonte administrativa. Cada organização é opt-in, com os grupos, modelos elegíveis e limites configurados manualmente. Mantenha a leitura de Costs independente, inclusive para frequência e estado.

**Coleta por organização, elegibilidade por conexão.** Uma organização pode conter várias conexões e projetos. Vincule explicitamente a conexão local à organização e ao identificador administrativo da chave de inferência, com projeto opcional e vigência do vínculo para rotações. Não derive esse identificador do valor secreto. Conexões que compartilham uma chave compartilham o mesmo escopo oficial, contado uma vez. Quando uma chave é compartilhada com aplicações externas, a atribuição por aplicação pode continuar desconhecida. A associação identifica a franquia aplicável. A permissão de usar a conexão e o consumo dessa franquia serão decisões próprias do roteador.

## Persistência e compatibilidade

Proposta de tabelas aditivas no SQLite existente. As estruturas abaixo são lógicas e podem ser ajustadas aos padrões do repositório antes da implementação.

| Estrutura | Dados e invariantes |
| --- | --- |
| `quotaOrganizations` | ID interno, provedor, identificador externo ou outra identidade fornecida pelo adaptador, referência de segredo e habilitação. Configuração validada com janelas, fuso e horário de renovação, grupos estáveis, modelos, limites, unidades, frequências e margem. Uma organização externa tem uma única configuração por provedor. |
| `quotaConnectionBindings` | Organização, conexão, ID administrativo da chave, projeto opcional e vigência. Uma conexão tem no máximo um vínculo efetivo por instante. Várias conexões podem apontar para a mesma chave. Preservar vínculos encerrados para a conciliação histórica. |
| `quotaBuckets` | Chave composta por organização, fonte, escopo estável da consulta, resolução e limites UTC do bucket. Linhas normalizadas em JSON versionado, com dimensões, métricas e horário de observação. Um bucket retornado vazio persiste como `[]`. Guardar valor monetário com moeda e representação decimal, inclusive zero. Um bucket revisado substitui o anterior por inteiro. |
| `quotaCollectionState` | Por organização, fonte e escopo, registra intervalo solicitado, início e fim da última tentativa, último sucesso completo, lacunas, próxima tentativa e classe de erro sanitizada. Opcionalmente guarda progresso de reparos históricos por janela. |

Manter a resolução diária separada da resolução de minuto e separar escopos filtrados de totais. Nenhum consumidor deve somar representações sobrepostas. Uma resposta que omite um bucket não prova zero nem confirma a versão anterior. Registre a lacuna e mantenha a observação anterior identificável. Organizações diferentes sempre entram no filtro e na chave da consulta e da escrita.

Registrar separadamente o instante da coleta, a janela consultada e a atualidade efetiva dos dados. Uma coleta recente indica a hora da observação. O provedor ainda pode contabilizar eventos com atraso. Na renovação diária, começar a nova janela como desconhecida até obter um snapshot válido daquela janela. Falhas, credenciais expiradas e ausência de dados preservam o último snapshot válido com sua própria janela e estado. Modelos sem classificação de franquia ficam desconhecidos. Um tier diferente de `incentivized-tier` não confirma faturamento.

Usar o [adapter](../../src/lib/db/driver.js#L83), declarar tabelas e índices no [schema](../../src/lib/db/schema.js) e seguir a [sincronização aditiva](../../src/lib/db/migrate.js#L77). Nesta proposta, as tabelas começam vazias. Sem backfill obrigatório, alterações em `usageHistory` ou `usageDaily` ou migração de credenciais. Confirmar a necessidade de uma migration versionada segundo o runner e a política de backup da base de implementação. O contador de versão do registro de migrations e a constante de backup de schema têm papéis distintos. A atualização deve falhar de forma isolada se o coletor não puder usar seu schema. Testar banco novo, upgrade e rollback da aplicação em cópia sintética, preservando dados existentes. Evitar ou adiar execução concorrente entre processos até validar os drivers compartilhados e um mecanismo de lease. Não assumir coordenação entre processos no fallback `sql.js`.

## Credenciais e operação

- Guardar a Admin Key em um gerenciador de segredos ou arquivo privado montado somente para leitura. Usar no SQLite apenas uma referência opaca a um segredo provisionado pelo operador. A aplicação resolve a referência no servidor, com acesso mínimo, sem aceitar um caminho arbitrário vindo da API. A rotação troca o segredo sem misturar configurações ou histórico de organizações. Para a OpenAI, usar **Restricted** e **Usage API Scope: Read**. A credencial de inferência permanece separada.
- Fixar a origem HTTPS no adaptador OpenAI. Desabilitar redirecionamentos no cliente administrativo. Representar falhas por classe, status, instante e identificador de requisição quando apropriado. Excluir cabeçalhos de autorização, corpos de erro brutos, chaves e valores de configuração privada de logs, API e exportações. Registros administrativos também devem ficar restritos ao escopo autorizado.
- Propor Usage a cada **60 s**, Costs a cada **60 min**, renovação OpenAI às **00:00 UTC**, limiar inicial de defasagem de Usage de **5 min** e margem operacional de **10%** para o futuro Enforcement. Tudo configurável. Costs precisa de limiar próprio compatível com a hora de coleta e com o atraso observado. São parâmetros locais, sujeitos a medição. A margem não é aplicada pelo coletor.
- Em cada rodada, fixar a janela e os parâmetros até o fim da paginação. Validar páginas, limites e cursores repetidos. Publicar os buckets e o estado de sucesso em transação curta depois de receber e validar todas as páginas. Uma falha de página preserva o último resultado completo. Repetir a coleta substitui buckets e remove linhas antigas dentro de um bucket retornado, sem acumular contagens. Impedir escrita de resultados de tentativas superadas.
- Usar timeout, concorrência limitada e exclusão por organização e endpoint, inclusive entre consultas com agrupamentos ou janelas diferentes. A primeira versão roda em um único processo por diretório de dados. Para `429`, respeitar `Retry-After` quando presente e aplicar backoff com limite. Fazer o mesmo para timeouts e falhas transitórias, com política própria. Para `401` e `403`, sinalizar configuração, expiração ou permissão inválida. O futuro agendador limita tentativas, distribui o horário de coleta entre organizações e retoma após reinício.

### Janelas de consulta

Começar pelo agregado diário da janela corrente, uma consulta lógica por organização com o agrupamento necessário. Atualizar o dia encerrado após a virada e reconsultar janelas históricas selecionadas com cadência menor. Custos usam buckets diários e reconsultam dias recentes, pois lançamentos podem aparecer depois. Evitar repetir consultas por conexão e evitar deduzir cobertura financeira de Usage.

Minutos são úteis para a conciliação. Capturar inicialmente uma janela recente sobreposta sob opção de configuração, com lookback e cadência ajustáveis. Se 7.1.1 precisar ser menor, validar esse adaptador com fixtures e ativar a coleta de minutos em 7.1.2. Reparos históricos paginam por janelas limitadas, sem reconstruir o dia inteiro a cada rodada. O agregado diário é a visão total. A série de minutos é uma vista de diagnóstico e conciliação. Para uma renovação fora da fronteira diária disponibilizada pelo provedor, usar buckets finos que cubram a janela inteira ou retornar cobertura insuficiente.

## API interna de leitura

Proposta de `GET /api/quota/organizations/:orgId/snapshots` com `source=usage|costs`, `resolution=1d|1m`, `start`, `end` e cursor interno com limite de intervalo. A resolução depende da fonte. Retornar escopo e janela solicitada, horários da tentativa e do último sucesso, cobertura consultada, lacunas e lista de buckets. A leitura usa exclusivamente o SQLite. A rota exige sessão administrativa no servidor e verificação da organização mesmo quando o login geral do Dashboard estiver desativado. Nenhuma credencial, referência de segredo ou payload bruto sai por essa rota.

Expor `valid`, `unknown` e `stale` com motivo. `valid` indica uma consulta íntegra e recente para o escopo, sem garantia de que o provedor já registrou todos os eventos. `unknown` cobre janela sem observação utilizável e buckets omitidos. `stale` mantém a última observação conhecida com seu horário. Distinguir bucket vazio explícito de ausência de bucket, e valor monetário zero de ausência de lançamento. O estado da tentativa mais recente pode ser um erro mesmo com uma observação anterior ainda válida. O contrato deixa saldo disponível e decisões do roteador para os incrementos seguintes.

## Testes e sequência de implementação

1. **Adaptador e fixtures.** Testar Usage e Costs paginados, agrupamentos com campos nulos, classificação do tier literal observado, `default` sem inferência de cobrança, cache sem dupla contagem, buckets vazios ou omitidos, `0.0` com quantidade positiva, revisão tardia, precisão monetária, resposta inválida e ciclos de cursor. Usar IDs, horários e volumes inventados e nenhuma amostra bruta de produção.
2. **Repositório e coletor acionável localmente por função.** Validar paginação completa com HTTP simulado e SQLite temporário, substituição atômica, falha na segunda página, repetição idempotente, isolamento e múltiplas conexões para a mesma chave. Exercitar upgrade, backup e rollback em banco sintético e a ausência de alterações no histórico de uso.
3. **Agendador e API interna.** Testar com relógio controlado a virada UTC, atraso configurado, timeout, `429`, credencial inválida, reinício e concorrência. Verificar que a inicialização acontece sem Dashboard, que build e configuração desativada ficam sem chamadas, e que a rota rejeita acesso anônimo ou a outra organização e omite segredos. Conferir inicialização e embalagem do standalone em homologação isolada.

**Critério para avançar a 7.1.2.** Obter snapshots desduplicáveis com escopo, tempo e cobertura explícitos. Preparar fixtures nas quais a soma local aparece inteira, parcialmente ou com atraso no uso oficial. Manter consumo oficial incentivado e não incentivado, consumo externo identificável, uso local possivelmente pendente e requisições em andamento como sinais distintos. Agregados por minuto e chave podem reduzir a ambiguidade, sem provar correspondência por requisição. Dashboard e Enforcement têm critérios próprios no [roadmap](ROADMAP.md#incrementos-do-quota-manager).

## Agendador e leitura implementados

O [agendador](../../src/lib/quota/scheduler.js) limita a concorrência por processo e mantém Usage e Costs independentes por organização. Coletas Usage de minuto e dia compartilham a mesma trava. A próxima execução e as falhas consecutivas persistem em `kv/quotaSchedule`, por organização, fonte e resolução. Isso permite retomar após reinício sem migration adicional. Os timers são cancelados e os GETs, leitura de resposta e espera de retry recebem cancelamento no encerramento. Em caso de interrupção antes do fim, a rodada volta a ser devida ao reiniciar. A execução compartilhada entre réplicas requer um coordenador ou um processo coletor dedicado.

| Configuração | Padrão |
| --- | --- |
| `QUOTA_COLLECTOR_ENABLED` | Desativado. Habilitar com `true` no servidor e habilitar cada organização na persistência. |
| `QUOTA_COLLECTOR_CONCURRENCY` | `2`, de 1 a 16 tarefas por processo |
| `QUOTA_COLLECTOR_TIMEOUT_MS` | `10000` por tentativa HTTP |
| `QUOTA_COLLECTOR_SECRETS_DIR` e `QUOTA_COLLECTOR_SECRET_REFS` | Sem diretório implícito e sem referências autorizadas por padrão. O diretório absoluto deve ser dedicado e montado como somente leitura. As referências `ref:<nome>` formam uma lista separada por vírgulas e apontam para arquivos regulares de mesmo nome. |
| Organização | Usage a cada 60 s e Costs a cada 60 min. Reconsulta do dia UTC corrente mais 1 dia anterior em Usage e 7 dias anteriores em Costs. Limiares de defasagem de 5 min e 2 h, respectivamente. |
| Minutos | Desativados por organização. Quando habilitados, a cada 60 s com 10 minutos anteriores por padrão. |
| Falhas | Depois das tentativas do adaptador, backoff do agendador de 30 s até 5 min, respeitando `Retry-After` maior. Credencial ausente, inválida ou expirada e falta de permissão voltam a ser tentadas após 15 min. |

O resolvedor de arquivos usa Linux com `/proc/self/fd`, trava o diretório durante o acesso e rejeita symlinks no caminho e no arquivo. A rotação substitui o arquivo autorizado ou troca a referência por outra já autorizada. A próxima coleta lê o arquivo novamente. Guarde credenciais fora da imagem, do repositório, de variáveis públicas e do SQLite. A configuração das organizações permanece uma operação local do operador, via repositório, até a etapa de gerenciamento.

As rotas exigem o cookie de sessão assinado, mesmo com `requireLogin=false`. O administrador que entrou por senha tem acesso à instalação inteira. Delegação por OIDC exige `issuer` e `subject` explicitamente configurados em `oidcReaders` para cada organização. Sessões OIDC anteriores precisam de novo login. O SAML existente carece das duas claims necessárias à delegação. A API não expõe IDs administrativos de organizações, projetos e chaves, `credentialRef` ou as listas de leitores.

- `GET /api/quota/organizations` lista as organizações acessíveis em páginas. A resposta contém o ID local, o provedor, a habilitação e o número de grupos.
- `GET /api/quota/organizations/:orgId/snapshots` consulta `source`, `resolution`, `start` e `end` em segundos Unix, com `limit` e `offset` para registros. Intervalos começam em fronteiras UTC da resolução. O fim explícito alinha à resolução ou coincide com o segundo corrente. A janela máxima é de 31 dias ou 120 minutos. Usage retorna totais por modelo e tier, e Costs retorna lançamentos. A resposta inclui grupos, status, lacunas, buckets, última tentativa concluída, último sucesso e próximo horário previsto ou início da coleta em andamento. Horários de coleta e agendamento usam milissegundos Unix.

As rotas fazem leitura local e enviam `Cache-Control: private, no-store`. Cada página de organizações ou registros tem até 100 entradas. A resposta de snapshots exibe até 50 grupos e 100 modelos por grupo, com os respectivos totais para indicar truncamento. Buckets que estavam no histórico e foram omitidos pela última resposta sobreposta continuam visíveis com `omitted: true`. Eles ficam fora dos totais retornados. Um snapshot válido representa uma observação recebida dentro da janela. A fonte pode ainda estar processando eventos recentes.

### Homologação inicial

A imagem ARM64 `dev-b6e3083e`, construída a partir de `b6e3083e`, passou em instância exclusiva de loopback. Com o coletor e a Observability desativados, foram confirmados health check, migrations do SQLite, montagem somente leitura, login, API administrativa vazia, rejeição de acesso anônimo ou por chave de inferência e persistência após reinício. O gateway respondeu à listagem de modelos e rejeitou requisições inválidas em JSON. O procedimento de cadastro da organização foi validado em SQLite temporário com configuração sintética.

### Homologação real na imagem ARM64

Na etapa **7.1.1e**, o proprietário homologou manualmente a imagem ARM64 `realbrubru/9router:dev-b6e3083e`, construída do commit `b6e3083e894207bf7162e9e92a6c72b95e1bbfac`. Uma organização foi provisionada no SQLite. A Admin Key **Restricted**, limitada a **Usage API Scope: Read**, foi instalada no diretório privado montado somente para leitura. A coleta começou com o Dashboard fechado.

| Cenário | Evidência registrada |
| --- | --- |
| Usage | Totais de tokens e requisições conferiram com as consultas administrativas independentes, incluindo o último microteste. Todos os registros observados vieram como `incentivized-tier`. As rodadas periódicas não apresentaram duplicação observada. |
| Costs no dia UTC anterior | Os lançamentos consultados registraram quantidades positivas de tokens com custo explicitamente igual a zero. |
| Costs no dia UTC corrente | A tentativa de coleta foi bem-sucedida. A janela corrente retornou `status: unknown`, `coverage: missing` e ausência de registros. A ausência de um lançamento não confirma custo zero. |
| Reinício | Organização, configuração, snapshots e agendamento persistiram. O último sucesso de Usage observado ocorreu cerca de 36 segundos após o início do container. A próxima coleta estava prevista cerca de 60 segundos depois. Os snapshots observados tinham zero falhas consecutivas. |

Os totais da organização, o conteúdo dos snapshots e os horários absolutos da instância ficam no registro privado de homologação. O procedimento reutilizável e o diagnóstico do HTTP 404 do auxiliar estão no [runbook](RUNBOOK.md#operação-da-homologação-do-quota-collector).

**Limitações.** A defasagem efetiva do provedor continua desconhecida e `dataAsOf` permanece nulo. `collectedAt` indica quando o coletor observou os dados, e a cobertura do dia corrente pode ser parcial. A classificação de modelos nos grupos de franquia está incompleta. A virada às 00:00 UTC foi exercitada com relógio simulado e segue pendente em tempo real. O Collector é passivo. Quota Reconciliation, saldo operacional e Enforcement permanecem como etapas futuras.
