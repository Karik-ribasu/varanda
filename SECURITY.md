# Segurança

## Como relatar

Relate vulnerabilidades em privado pelo formulário [Report a vulnerability](https://github.com/Varanda-org/varanda/security/advisories/new).
Nunca publique o relato em uma issue, pull request ou discussão pública.

Se o formulário não abrir para você, fale em privado com o mantenedor pelo [site de Rodrigo Pavezi](https://www.rodrigopavezi.com/).
Na primeira mensagem, diga só que tem um relato de segurança, sem detalhes da falha.
O mantenedor responde e combina um canal privado para receber o relato completo.

Inclua no relato:

- Componente afetado: core, rpc, CLI/semeador, `varanda-serve`, app iOS/Android/web ou site.
- Passos para reproduzir o problema.
- Impacto observado ou possível.
- Versão usada: identificador do commit de `main` em que você encontrou o problema.

## Escopo e versão suportada

O Varanda é um protótipo e ainda não tem lançamentos.
A versão suportada é o estado atual da branch `main`.

Os riscos residuais conhecidos do protocolo estão na seção “Residual risks” de [docs/protocol.md](docs/protocol.md).
Consulte essa seção antes de enviar o relato.

## O que acontece depois

Os mantenedores confirmam o recebimento do relato.
Eles combinam com você os próximos passos e a divulgação da vulnerabilidade.
