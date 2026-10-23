# Histórico de mudanças

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Ainda não há versões lançadas: todos os pacotes estão em `0.1.0` e nenhum foi publicado.

## [Não lançado]

### Adicionado

- Protótipo P2P da fase 0 no Holepunch: CLI com identidade, certificado de membro, perfil, publicações, respostas, seguir pessoas, feed e sincronização.
  Semeador com admissão por certificado e referência normativa em `docs/protocol.md`. ([#1](https://github.com/Varanda-org/varanda/pull/1))
- Monorepo com CLI, núcleo compartilhado, contrato RPC e app P2P para iOS, Android e web.
  O nó roda em um worklet Bare no celular. ([#3](https://github.com/Varanda-org/varanda/pull/3))
- Página de apresentação do varanda.app, logotipo de cadeira de praia e prévia do desenho do app. ([#4](https://github.com/Varanda-org/varanda/pull/4))
- CI em cada pull request, com lint, testes e demo no Node 20 e 24; teste que compara a ajuda da CLI com o README.
  Guias de contribuição, segurança e conduta, modelos de issue e de PR, e CODEOWNERS.

### Corrigido

- Liberação de referências a sockets fechados nas buscas em quarentena. ([#2](https://github.com/Varanda-org/varanda/pull/2))
- DHT pública com endereço local de loopback: o app e a sessão do nó recusam a combinação, que só terminava em tempo esgotado.
  Avisos de tela somem quando o nó encerra, quando a sincronização termina ou quando a resposta muda. ([#10](https://github.com/Varanda-org/varanda/issues/10))
