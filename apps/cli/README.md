# varanda (CLI)

O programa de linha de comando da fase 0: associação de teste, certificados, identidade, perfil, publicações, seguidos, feed, sincronização e semeador. Também traz o `varanda-serve`, o nó local que expõe uma interface web por WebSocket em loopback. Pacote privado do monorepo; a lógica está em `@varanda/core`.

Pontos de entrada:

- `bin/varanda.js`: o programa (`node apps/cli/bin/varanda.js help`, ou `node bin/varanda.js help` a partir da raiz).
- `bin/varanda-serve.js`: o servidor local da interface web. Opções em `apps/cli/lib/serve/args.js` e na seção "Servidor local para a interface web" do [README da raiz](../../README.md).
- `scripts/demo.js`: a demo automática (`npm run demo`, da raiz ou com `-w apps/cli`). `scripts/local-dht.js` sobe uma DHT local.

Uso, formatos, códigos de saída e o passo a passo estão no [README da raiz](../../README.md). A referência normativa é [docs/protocol.md](../../docs/protocol.md).

Testes e lint, da raiz: `npm test -w apps/cli` e `npm run lint -w apps/cli` (o `npm run lint` da raiz cobre o repositório todo). Um arquivo: `node apps/cli/test/serve.test.js`.
