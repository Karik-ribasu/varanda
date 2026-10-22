# @varanda/core

O núcleo do protocolo Varanda: registros do diário, certificados, armazenamento (Corestore), rede (Hyperswarm), sincronização, o semeador e a sessão do nó que a interface usa por RPC. Pacote privado do monorepo, usado por `apps/cli` e `apps/app`.

- Roda no Node 20 ou mais novo e no runtime Bare. O acesso a `fs`, `path` e `process` passa pelos `imports` do `package.json` (`#fs`, `#path`, `#process`): com a condição `bare` vão para `lib/bare/*`, sem ela para `lib/node/*`.
- `require('@varanda/core')` exporta `records`, `safe`, `feed`, `cert`, `store`, `net`, `sync` e `errors`. `seeder` e `assoc` só por caminho: `@varanda/core/lib/seeder`, `@varanda/core/lib/assoc`.
- `lib/member.js` tem as operações de membro sobre um diretório de dados (identidade, certificado, perfil, publicação, seguidos, diário, feed). `lib/session.js` é a sessão do nó (`createSession`), a que o worklet do app e o `varanda-serve` servem pelo contrato `@varanda/rpc`.
- O mapa de módulos, o modo de lock `worklet` e as regras de cada formato estão em [docs/protocol.md](../../docs/protocol.md) (seções 8 e 9). O contrato da interface está em [docs/rpc.md](../../docs/rpc.md).

Testes: `npm test -w packages/core`. Isso inclui o teste de carga sob o Bare (`test/bare-load.test.js`, que roda `test/bare/smoke.js` com o `bare-runtime` e espera `BARE OK`).
