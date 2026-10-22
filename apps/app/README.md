# @varanda/app

O aplicativo Varanda para iOS, Android e web (Expo e React Native), com a interface de membro em português. O nó roda num worklet Bare dentro do app nativo; na web, a interface fala com o `varanda-serve`. Pacote privado do monorepo.

Pontos de entrada:

- `index.js` e `App.js`: a raiz do app e a barra de abas.
- `src/screens/`: as telas (Conexão, Identidade, Perfil, Publicar, Seguindo, A Rua, Diário, Sincronizar); `src/node.js` guarda a conexão e o estado da sincronização; `src/config.js` valida a configuração.
- `src/client/`: o cliente do nó. No app nativo, `connect.native.js` usa o worklet (`native.js`, o único que importa `react-native-bare-kit`); na web, `connect.web.js` usa `web.js`, que fala com o `varanda-serve` por WebSocket e nunca importa o worklet.
- `worklet/main.js`: o código que roda no Bare e serve a sessão do `@varanda/core` por IPC.
- `src/gate/` e `scripts/gate-server.js`: a prova do nó no simulador iOS ([docs/ios-gate.md](../../docs/ios-gate.md)).

Comandos (a partir da raiz, com `-w apps/app`, ou aqui dentro): `npm run link:addons`, `npm run pack:worklet`, `npm run ios`, `npm run android`, `npm run web`, `npm run start`, `npm run gate`. Não há script de teste neste pacote. Depois de qualquer `npm install`, rode `link:addons` de novo antes de um build nativo.

Os PNGs do ícone e da tela de abertura são gerados a partir de `apps/site/artwork/logo` por `apps/site/scripts/render-assets.js`; nunca os regenere com `expo prebuild`, que sobrescreveria as correções de segurança feitas à mão em `ios/` e `android/`.

Documentação: [docs/app.md](../../docs/app.md) (o que o app faz e as telas) e [docs/development.md](../../docs/development.md) (como construir). O contrato com o nó está em [docs/rpc.md](../../docs/rpc.md).
