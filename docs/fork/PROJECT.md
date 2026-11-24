# Contexto e colaboração

O fork parte do 9Router para centralizar acesso a LLMs por aplicações e agentes, incluindo o Hermes. O ambiente inicial é experimental e, no início do projeto, não tinha usuários ativos nem aplicações dependentes. Código, configuração de operação, credenciais e dados persistentes ficam separados.

## Objetivos

- Roteamento entre OpenAI API, OpenAI Codex, GitHub Copilot, OpenRouter e provedores adicionais conforme a necessidade.
- Priorizar franquias elegíveis, créditos e assinaturas já contratadas. Controlar consumo antes do envio quando o provedor continuar atendendo após o fim da franquia.
- Oferecer fallback automático somente entre conexões elegíveis para a aplicação. Segregar contas pessoais e profissionais, conforme permissões e políticas aplicáveis.
- Preservar a compatibilidade com o upstream, manter mudanças pequenas e validar o contrato de API antes da integração com o Hermes.

## Como trabalhamos

| Participante | Responsabilidade |
| --- | --- |
| Proprietário | Desenvolvimento, decisões finais, prioridades e validações práticas |
| ChatGPT | Arquitetura, planejamento, requisitos e revisão técnica |
| Codex | Investigação no repositório, implementação, testes, documentação e discussão técnica |

O proprietário compartilha análises e revisões entre ChatGPT e Codex. Codex pode questionar propostas, apresentar evidências e sugerir alternativas. A decisão final cabe ao proprietário. Para acompanhar o que já foi aceito e o que está em discussão, consulte [DECISIONS.md](DECISIONS.md).
