# Contexto e colaboração

O fork parte do 9Router para centralizar acesso a LLMs por aplicações e agentes, incluindo o Hermes. O ambiente inicial é experimental e, no início do projeto, não tinha usuários ativos nem aplicações dependentes. Código, configuração de operação, credenciais e dados persistentes ficam separados.

## Objetivos

- Roteamento entre OpenAI API, OpenAI Codex, GitHub Copilot, OpenRouter e provedores adicionais conforme a necessidade.
- Priorizar franquias elegíveis, créditos e assinaturas já contratadas. Controlar consumo antes do envio quando o provedor continuar atendendo após o fim da franquia.
- Oferecer fallback automático somente entre conexões elegíveis para a aplicação. Segregar contas pessoais e profissionais, conforme permissões e políticas aplicáveis.
- Preservar a compatibilidade com o upstream, manter mudanças pequenas e validar o contrato de API antes da integração com o Hermes.

## Direção para um projeto independente

**PipoRouter** é o nome definitivo escolhido para o futuro projeto independente. O posicionamento é **Open Source AI Infrastructure** e o slogan é **“Your AI. Your resources. Your rules.”**. O desenvolvimento continua no fork atual do 9Router. A transição futura preservará o histórico Git, a atribuição ao 9Router e um remote para incorporar correções relevantes do upstream. O trabalho parte da base atual e avança por refatorações incrementais. [Escopo homologado](QUOTA-COLLECTOR.md#homologação-real-na-imagem-arm64)

Os princípios preliminares são **Privacy by default**, **Cost awareness**, **Security first**, **User control**, **Provider agnostic**, **Open source**, **Self-hosted first** e **Test-driven evolution**. A licença MIT do projeto e os avisos aplicáveis ao código original e de terceiros serão preservados no repositório e nos artefatos distribuídos.

A direção de produto combina gateway e roteamento inteligente, políticas de acesso, quotas, orçamentos e FinOps, descoberta de modelos, tarifas, gratuidades e descontos, e observabilidade granular. Branding técnico, infraestrutura e distribuição próprias seguem no backlog estratégico. [Backlog estratégico](ROADMAP.md#backlog-estratégico-do-projeto-independente)

O saldo indicativo de franquia informa o operador com a janela, as hipóteses e as lacunas que sustentam o cálculo. A API administrativa disponibiliza a visão diagnóstica por organização e grupo. A autorização de consumo terá política própria, decisão por tentativa e reserva atômica. [Contrato da API de conciliação](QUOTA-RECONCILIATION.md#api-administrativa-de-conciliação)

O Attempt Registry preserva identidade, estados e evidências de consumo em metadados operacionais independentes do conteúdo das conversas. A primeira integração usará Observation e sinalizará lacunas causadas por falhas de registro. [Attempt Registry](ATTEMPT-REGISTRY.md)

## Como trabalhamos

| Participante | Responsabilidade |
| --- | --- |
| Proprietário | Desenvolvimento, decisões finais, prioridades e validações práticas |
| ChatGPT | Arquitetura, planejamento, requisitos e revisão técnica |
| Codex | Investigação no repositório, implementação, testes, documentação e discussão técnica |

O proprietário compartilha análises e revisões entre ChatGPT e Codex. Codex pode questionar propostas, apresentar evidências e sugerir alternativas. A decisão final cabe ao proprietário. Para acompanhar o que já foi aceito e o que está em discussão, consulte [DECISIONS.md](DECISIONS.md).
