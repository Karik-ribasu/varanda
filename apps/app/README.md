# @varanda/app

O aplicativo Varanda para iOS, Android e web (Expo e React Native). A interface está em construção. O nó roda num worklet Bare dentro do app nativo; na web, a interface fala com o `varanda-serve`. Pacote privado do monorepo.

Pontos de entrada:

- `index.js` e `App.js`: a raiz do app e as telas.
- `src/client/`: o cliente do nó. `index.native.js` usa o worklet (`native.js`, o único que importa `react-native-bare-kit`); `index.web.js` não importa o worklet (a web não tem nó no app; o cliente do `varanda-serve` está em construção).
- `worklet/main.js`: o código que roda no Bare e serve a sessão do `@varanda/core` por IPC.
- `src/gate/` e `scripts/gate-server.js`: a prova do nó no simulador iOS ([docs/ios-gate.md](../../docs/ios-gate.md)).

Comandos (a partir da raiz, com `-w apps/app`, ou aqui dentro): `npm run link:addons`, `npm run pack:worklet`, `npm run ios`, `npm run android`, `npm run web`, `npm run start`, `npm run gate`. Não há script de teste neste pacote. Depois de qualquer `npm install`, rode `link:addons` de novo antes de um build nativo.

Documentação: [docs/app.md](../../docs/app.md) (o que o app faz e as telas) e [docs/development.md](../../docs/development.md) (como construir). O contrato com o nó está em [docs/rpc.md](../../docs/rpc.md).
