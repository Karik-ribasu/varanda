# varanda — development guide

How to work in this repository. Normative facts about formats and the wire are in [protocol.md](protocol.md) and [rpc.md](rpc.md). The iOS proof is in [ios-gate.md](ios-gate.md).

## Prerequisites

- Node.js 20 or newer (`engines.node` is `>=20`) and npm. On the Mac this was written on: Node v26.10.0 and npm 11.19.1 (an example, not a requirement).
- For the iOS app only: Xcode and CocoaPods. The gate passed with Xcode 26.2, CocoaPods 1.16.2 and an iPhone 17 Pro simulator (iOS 26.2). These are examples from [ios-gate.md](ios-gate.md).
- For a native Android build: an Android SDK and Java. Neither is installed on that Mac, so no native Android run has been verified (see "Android").

## Layout (npm workspaces)

The root `package.json` declares the workspaces `packages/*` and `apps/*`.

| Path | Package | Role |
|---|---|---|
| `packages/rpc` | `@varanda/rpc` | JSON contract between the UI and the node. No dependencies, no Node built-ins. |
| `packages/core` | `@varanda/core` | The protocol library and the node session. Runs on Node and on Bare (`#fs`, `#path` and `#process` resolve through the package `imports`, with the `bare` condition for Bare). |
| `apps/cli` | `varanda` | The CLI, the seeder, the demo and `varanda-serve`. |
| `apps/app` | `@varanda/app` | The Expo / React Native app and its Bare worklet. |

`bin/varanda.js` and `bin/varanda-serve.js` at the root forward to `apps/cli/bin/`.

## Install

From the repo root:

```sh
npm install
```

Only the root `package-lock.json` exists. Do not create one inside a workspace and do not run `npm install` inside a workspace directory with a lockfile of its own: the workspaces share one tree under the root `node_modules`.

After every `npm install` or `npm ci`, the native app needs `npm run link:addons -w apps/app` again (see "iOS").

## Lint

```sh
npm run lint
```

Runs `standard` over the whole repo. `apps/cli` also has `npm run lint -w apps/cli`. Generated native projects and bundles are ignored (see the `standard.ignore` list in the root `package.json`).

## Tests

All workspaces, from the root:

```sh
npm test
```

This runs `npm test --workspaces --if-present`. Each workspace test script is `node ../../scripts/run-tests.js`, which runs every `test/*.test.js` of that workspace one per child process, in order, with a timeout per file (`VARANDA_TEST_TIMEOUT_MS`, default 180000).

One workspace:

```sh
npm test -w packages/rpc
npm test -w packages/core
npm test -w apps/cli
```

One file, from the repo root:

```sh
node apps/cli/test/serve.test.js
```

`apps/app` has no test script. Network tests use an in-process local DHT bound to `127.0.0.1`. No test uses the public DHT.

### Bare desktop smoke test

The core must load and sync under the real Bare runtime. `packages/core/test/bare-load.test.js` (part of `npm test -w packages/core`) spawns `node_modules/.bin/bare` (devDependency `bare-runtime`) on `packages/core/test/bare/smoke.js`, which must print `BARE OK` and exit 0. There is no separate command: run the core tests, or `node packages/core/test/bare-load.test.js`.

## Demo

```sh
npm run demo
```

Runs `npm run demo -w apps/cli`, that is `node scripts/demo.js`: an automatic walkthrough with a local DHT, a seeder and two members. The root README describes it in "Demo automática".

## varanda-serve with the web export

`varanda-serve` runs a node on this computer and exposes it to a browser UI over a loopback WebSocket. Its flags and security rules are in the root [README](../README.md) ("Servidor local para a interface web"). One way to use it with the exported web app:

```sh
cd apps/app
npx expo export --platform web      # writes the static site (Expo's default output directory is dist; check the command output)
cd ../..
node bin/varanda-serve.js --data ./data --association <hex> \
  --bootstrap <host:port> --dht-host 127.0.0.1 --ui apps/app/dist
```

Use `--public-dht` instead of `--bootstrap` to opt in to the public DHT. The server prints the URL with the token in the fragment once. Open that URL. Without `--ui`, serve the web build with `npm run web -w apps/app` (Expo dev server) and pass its exact origin with `--origin http://localhost:8081`.

The `dist` directory is ignored by version control. The web export itself has not been run for this document: confirm the output directory it reports before relying on `apps/app/dist`.

## iOS

The detail, with the simulator commands and the evidence, is in [ios-gate.md](ios-gate.md) ("Commands, in order"). The short form, from the repo root:

```sh
npm ci
npm run link:addons -w apps/app      # bare-link into react-native-bare-kit's addon directories
npm run pack:worklet -w apps/app     # bare-pack the worklet, then scan for Node built-ins
cd apps/app/ios
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install
cd ..
npm run ios                          # expo run:ios
```

- `link:addons` runs `scripts/link-addons.sh`. It fails unless rocksdb-native, udx-native, sodium-native and bare-fs are linked for every platform it handles. The linked addons live in `node_modules/react-native-bare-kit`, so every install wipes them.
- `pack:worklet` runs `scripts/pack-worklet.sh` and writes `apps/app/assets/worklet/main.bundle.js` (generated and ignored by version control).
- `ios/` and `android/` are committed. Regenerate them only with `npx expo prebuild --no-install` from `apps/app`.
- `npm run gate -w apps/app` is the gate driver (`scripts/gate-server.js`), used with a Metro started with `EXPO_PUBLIC_VARANDA_GATE_URL`. See ios-gate.md.

## Android

Status: prebuild and `npx expo export --platform android` were checked, and bare-link produces the `.so` addons for arm64-v8a and x86_64. No native Android run is verified (no SDK or Java on the Mac used). `npm run android` is `expo run:android`; an emulator run must still confirm that the addons are picked up. See "Residual risks" in [ios-gate.md](ios-gate.md).

## Adding a dependency

Every dependency in every `package.json` uses an exact version: no `^`, no `~`, no ranges. The lockfile stays at the root.

```sh
npm install --save-exact <name>@<version> -w <workspace>
npm install --save-exact --save-dev <name>@<version> -w <workspace>
```

For example `-w packages/core`. Then run `npm run lint` and `npm test`. For a package the worklet loads, also run `npm run pack:worklet -w apps/app`, whose scan fails if the bundle reaches a Node built-in. Workspace packages depend on each other by exact version (`"@varanda/rpc": "0.1.0"`).
