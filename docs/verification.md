# varanda — end-to-end verification

Date: 2026-10-22 (sections 1 to 5) and 2026-10-23 (section 6, the public DHT). Every check below was run on one Mac. Logs and screenshots stayed in the verification sessions' scratchpads (not committed).

## Machine

| Item | Version |
|---|---|
| macOS | 15.7.3 (24G419) |
| Xcode | 26.2 (17C52) |
| CocoaPods | 1.16.2 |
| Simulator | iPhone 17 Pro, iOS 26.2 |
| Node.js | v26.10.0 |
| npm | 11.19.1 |

## 1. Clean baseline

| Command (repo root) | Outcome |
|---|---|
| `npm ci` | exit 0 |
| `npm run lint` | exit 0 (`standard`, no findings) |
| `npm test` | exit 0: `packages/core` 7 files, `packages/rpc` 8 files, `apps/cli` 14 files, 0 failures, no `not ok` line |
| `npm run demo` | exit 0, `DEMO OK` |
| `node bin/varanda.js help` | exit 0; byte-identical (`cmp`, same SHA-1) to the README "Ajuda" fence |
| `node bin/varanda-serve.js --help` | exit 0; prints the option list |

## 2. iOS gate on the final code

Run after `npm ci` on the current client (recover defaults to true; an IPC that ends on its own terminates the worklet).

```sh
npm run link:addons -w apps/app      # exit 0, rocksdb/udx/sodium/bare-fs linked for every platform
npm run pack:worklet -w apps/app     # 1841105 bytes, 344 files, 38 linked addon entries; node scan clean
(cd apps/app/ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install)   # exit 0
(cd apps/app/ios && xcodebuild -workspace Varanda.xcworkspace -scheme Varanda -configuration Debug \
  -sdk iphonesimulator -destination 'name=iPhone 17 Pro' -derivedDataPath build build)   # BUILD SUCCEEDED
xcrun simctl install booted apps/app/ios/build/Build/Products/Debug-iphonesimulator/Varanda.app
EXPO_PUBLIC_VARANDA_GATE_URL=http://127.0.0.1:8790 npx expo start --port 8081 --clear   # from apps/app, no CI=1
npm run gate -- --device booted      # from apps/app, exit 0
```

Driver summary (trace lines omitted, long lines shortened):

```
[gate 15:14:02] PASS a: diag structuredClone=function O_NOFOLLOW=yes O_EXCL=yes bare=v1.33.4
[gate 15:14:02] PASS b: identity.create 017be000...
[gate 15:14:02] PASS c: cert.add seq 0, node.info memberCert true
[gate 15:14:02] PASS d: post.create 017be000...:1
[gate 15:14:02] data-dir lock before the kill: present; after the kill: present
[gate 15:14:05] PASS e: log.read after kill+relaunch: seq 1 "post do app (gate)" (2 entries, recover true)
[gate 15:14:21] PASS f: app sync once done (seederConfirmed true, downloaded {"660fd368...":2}); feed.read has the CLI peer post
[gate 15:14:28] PASS g: node.info after background/resume: publicKey 017be000, sync idle
[gate 15:14:37] PASS h: second worklet (no recover) node.info -> LOCKED; its node.close stop clean in 1 ms; first worklet still answers
[gate 15:14:37] PASS i: terminateNode clean in 1 ms; startNode without recover + node.info + log.read in 144 ms (2 entries)
GATE OK
```

Screenshot: `02-gate-ok.png` in the scratchpad.

## 3. Web: export, varanda-serve, member flow in a browser

```sh
cd apps/app && npx expo export --platform web     # "Exported: dist": apps/app/dist
```

Output: `dist/index.html` (1.2 KB), `dist/favicon.ico`, `dist/metadata.json` and one bundle `dist/_expo/static/js/web/index-<hash>.js` (428 KB). The output directory is `apps/app/dist`, as `--ui apps/app/dist` assumes; docs/development.md now says so.

Environment (all on loopback, data under the scratchpad):

```sh
node apps/cli/scripts/local-dht.js --port 49800
# association, seeder key + certificate, CLI member "Carla CLI" (assoc init, seed key,
# assoc certify-seeder, seed cert add, id create, assoc certify, cert add, profile set)
node bin/varanda.js seed --data <env>/seeder --association <assoc> --bootstrap 127.0.0.1:49800 --dht-host 127.0.0.1
node bin/varanda-serve.js --data <env>/web --association <assoc> --bootstrap 127.0.0.1:49800 \
  --dht-host 127.0.0.1 --port 8787 --ui apps/app/dist
```

varanda-serve printed its two lines once (`varanda-serve em http://127.0.0.1:8787`, `abra http://127.0.0.1:8787/#token=...`).

HTTP checks with curl: `/` and the JS bundle answer 200 with the CSP (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ... connect-src 'self' ws://127.0.0.1:8787 ws://localhost:8787; frame-ancestors 'none'; ...`), `nosniff`, `no-referrer`, `DENY` and `no-store`. `Host: evil.com` -> 421, `POST /` -> 405, `/../package.json` (path as is) -> 404, `/qualquer` -> 200 (index.html fallback).

Browser: the built-in browser of the Claude desktop app (Chromium), opened on the printed URL. The page ran under the server's CSP (inline `expo-reset` style allowed by `style-src 'unsafe-inline'`; no CSP error blocked the app). Member flow, all through the UI:

| Step | Result |
|---|---|
| Token | After load: `location.href` = `http://127.0.0.1:8787/` (fragment removed), `localStorage` and `sessionStorage` empty, `document.cookie` empty, the token not in the DOM |
| Identidade | "criar identidade" -> key `d28af364...`; association shown |
| Certificate, invalid | another member's certificate (issued by the CLI for the CLI member) -> refused, "certificado inválido (member-mismatch)" |
| Certificate, valid | issued with `node bin/varanda.js assoc certify --member d28af364... --age-band 18+ --method stub` -> "certificado gravado", "certificado de membro: válido" |
| Perfil | "Wanda Web" / "membro pelo navegador" published (Diário #1) |
| Publicar | "ola do navegador (web 1)" (Diário #2) |
| Seguindo | followed the CLI member `de74d3f3...` |
| Sincronizar (uma vez) | `sync ready`, `peer seeder 2ad91b1c`, `admitted d28af364... 0`, `have d28af364... 3`, `downloaded de74d3f3... 3`, then "última execução 1: concluída" |
| A Rua | "Carla CLI · ola do terminal (cli 1)" and the own post |
| Reply | "responder" on the CLI post -> Diário #3 shows "resposta a de74d3f3:2"; A Rua shows the same line on the reply |
| 390 px | viewport 390x844: `scrollWidth` 390 (no horizontal page scroll); cards fit; the tab bar scrolls horizontally by design (`ScrollView horizontal`) |

## 4. Cross-platform P2P matrix (one local DHT, one certified seeder)

Members: the CLI member "Carla CLI" (`de74d3f3...`), the browser member "Wanda Web" (`d28af364...`, the varanda-serve node of section 3) and the iOS simulator member "Iara iPhone" (`5fb284f3...`). The iOS app was the member UI build: the same Debug binary, uninstalled and reinstalled (empty Documents), with Metro started without `EXPO_PUBLIC_VARANDA_GATE_URL` (`npx expo start --port 8081 --clear`, no CI=1). The Conectar screen got the association, bootstrap `127.0.0.1:49800` and DHT host `127.0.0.1`; the certificate was issued by `assoc certify` and typed into Identidade.

| Check | Result |
|---|---|
| Each member posts | CLI `ola do terminal (cli 1)`; web `ola do navegador (web 1)` and a reply to the CLI post; iOS `ola do iPhone (ios 1)` |
| Each follows the other two | CLI `follow` x2; web Seguindo x2 ("2 diários seguidos"); iOS Seguindo x2 |
| Sync, every post in every feed | After `sync --once` (CLI), "sincronizar uma vez" (web, iOS) in turn, the CLI `feed` lists all six posts of the three members (replies shown as `↳ de74d3f3#2` and `↳ d28af364#3`); web A Rua lists the same six; iOS A Rua lists the five posts by the others plus its own |
| Offline post | CLI `post 'feito offline no terminal (cli 2)'` with no sync running, then one `sync --once`: it appeared in iOS A Rua (during iOS's continuous sync; the CLI log shows `peer member 01cfc5b7`, a direct member connection) and in web A Rua after the next web sync |
| Reads and writes during a continuous sync | iOS "sincronizar sempre" (run 2 running), then A Rua (feed.read) and a reply `resposta do iPhone durante sync continuo` (post.reply) succeeded; Diário #3 shows it; the CLI and the web got it on their next sync |
| Force-kill and relaunch iOS | `xcrun simctl terminate` while the continuous sync held the lock, then `launch`: the app went straight to the member UI (saved config), same key `5fb284f3...`, certificate "válido", 2 follows, Diário #0 to #3 intact |
| Invalid certificate | web UI: "certificado inválido (member-mismatch)" (section 3); CLI `cert add` of another member's certificate: `erro: certificado inválido (member-mismatch)`, exit 1. The demo (section 1) also covers `untrusted-association` |

Screenshots: `04-ios-*.png` in the scratchpad.

### Defect found and fixed: smart quotes in the iOS certificate field

Typing the certificate JSON on iOS turned `"` into curly quotes (iOS smart punctuation; `autoCorrect={false}` does not turn it off), and "gravar certificado" answered "JSON inválido" (`04-ios-cert-smartquotes.png`). Pasting is not affected. Fix in `apps/app/src/screens/Identidade.js`: the curly double quotes (U+201C, U+201D, U+201E, U+201F, U+2033) are read as `"` before `JSON.parse`; a certificate holds only ASCII values, so nothing valid changes. After Fast Refresh the same typed text was accepted ("certificado gravado", `04-ios-cert-ok.png`). `apps/app` has no test script, so there is no regression test; `standard` passes on the file.

## 4b. UI resilience

| Check | How | Result |
|---|---|---|
| Web, takeover (4000) | Draft "rascunho que deve sobreviver" in Publicar, then a second browser tab opened on the same URL | First tab: banner "outra aba assumiu a conexão" + "reconectar"; the draft still in the field. "reconectar" in the first tab: banner gone, draft intact; the second tab then showed the same banner |
| Web, server stopped | Draft extended, then `kill -INT` on varanda-serve | Banner "a conexão com o nó foi encerrada"; "reconectar" while the server was down: "não foi possível abrir a conexão com o varanda-serve", draft intact. varanda-serve restarted on the same data dir with `VARANDA_SERVE_TOKEN` set to the same token (the page keeps the token only in memory), then "reconectar": connected (`session.open` ok, `sync.status` idle), draft intact. Afterwards the security audit removed `VARANDA_SERVE_TOKEN` (a fixed token would keep a URL in the browser history valid across restarts): a restart now prints a new URL, which the page must be reopened with |
| iOS, node ends on its own | A temporary dev-only hook (removed afterwards, see below) ended the client side of the IPC 40 s after the first `launch()` of the JS context, the same path as a framing error from the node (`ipc.end()` then `finish()`), while a continuous sync was running (run 1) | The UI left the ready state: banner "a conexão com o nó foi encerrada" + "reconectar"; Sincronizar went from "sincronizando (contínuo, execução 1)" to "parado" with the lines cleared. "reconectar": a new `session.open` (a fresh worklet), the banner left, and "sincronizar uma vez" completed on the new node ("última execução 1: concluída") |
| Reply line | | "resposta a de74d3f3:2" in web A Rua and Diário; "resposta a de74d3f3:2" in iOS A Rua; "resposta a d28af364:3" in iOS Diário and web A Rua |
| iOS "DHT pública" with bootstrap entries | Conexão tab, bootstrap `127.0.0.1:49800` present, switch turned on | The switch applies in the form: the bootstrap field greys out and the notice "O nó vai usar a DHT pública da internet para achar pares." appears (`04b-ios-public-dht-toggle.png`). "aplicar e reiniciar o nó" was NOT pressed, so the node never joined the public DHT; the switch was turned off again. What submit would send was checked with the app's own `checkForm` in Node, with the same form: `{ bootstrap: null, dhtHost: "127.0.0.1", allowPublicDht: true }` (accepted; the raw form without the submit's bootstrap blanking gives "bootstrap e DHT pública são exclusivos"). The node-side acceptance of that config was not exercised here (section 6 does) |

Simulator note: with `simctl`-injected input, the first tap on a button right after typing into a TextInput was often swallowed and a second tap was needed; `Page` already sets `keyboardShouldPersistTaps='handled'`. Not reproduced by hand, so it is recorded as a harness observation, not a defect.

## 5. Leak checks

- **Browser (WebSocket frames).** After the page loaded, `window.WebSocket` was wrapped in the page (from the browser tool, not in the app source) and "reconectar" was pressed, so every later connection was captured: 2 connections, 85 frames, 52 inbound (responses and events: `sync.started`, `sync.event`, `sync.stopped`), covering every method the UI used (`session.open`, `sync.status`, `node.info`, `identity.create`, `identity.show`, `cert.add`, `profile.set`, `post.create`, `post.reply`, `follow.add`, `follow.list`, `sync.start`, `feed.read`, `log.read`). Scan of the inbound text: no string containing `/` (no filesystem path), no `secret`/`privateKey`/`primaryKey`, not the token, not the bootstrap port 49800 and not `127.0.0.1` (no DHT host). The only 128-hex value was `signature` of the member certificate in `log.read`, which is public block-0 data. The first connection (before the wrap: `session.open`, `sync.status`, `node.info`) was not captured; the same three calls were captured on the second connection. A separate scripted WebSocket client was not run.
- **iOS (IPC frames).** Temporary `console.log('[T11-FRAME] ' + JSON.stringify(obj))` in the frame decoder of `apps/app/src/client/native.js`, read through Metro's log (90 captured inbound frames, `05-ios-frames.log` in the scratchpad), then removed. Same scan: no `/` string (no `Documents` path or data dir), no secret key name, no bootstrap or DHT host; the only 128-hex value was the certificate `signature`. Metro may not forward every console line, so 90 is what was captured, not a proven total.
- **varanda-serve output.** Both runs printed exactly two lines; the token appears once, in the `abra ...#token=` line, and never again after startup (`grep -c` of the token = 1 per log).
- **Temporary code removed.** `apps/app/src/client/native.js` was restored from a copy taken before the edits: `git diff` shows no change to it, and `grep -rn T11 apps packages` finds nothing.

## 6. Public DHT (issue #9)

Date: 2026-10-23, the same Mac, Node.js v24.22.1, npm 11.19.1, hyperdht 6.34.1, hyperswarm 4.17.2, at `main` 19e3744. Every process, the iOS simulator included (it shares the Mac's network stack), ran on this one Mac, behind one router and one public address. Distinct machines, networks and NAT or CGNAT between peers were not covered (issues #36 and #42).

### CLI

The README "DHT pública" path: no `local-dht.js`, `VARANDA_BOOTSTRAP` and `VARANDA_DHT_HOST` unset (`env` showed no `VARANDA_*`, and the timing wrapper also removed both from every child's environment), no `--bootstrap` and no `--dht-host`. An association, a certified seeder and two members (Alice, Bob), each in its own data dir, were set up offline with the README steps 2 to 4. Then every network command ran as its own process:

```sh
node bin/varanda.js seed --data <env>/seeder --association <assoc>
node bin/varanda.js sync --data <env>/alice --once --timeout-ms 30000
node bin/varanda.js follow --data <env>/bob --author <alice>
node bin/varanda.js sync --data <env>/bob --once --timeout-ms 30000
node bin/varanda.js feed --data <env>/bob
```

A small wrapper timed every output line from the process start (seconds below).

| Step (README 5 and 6) | Output | Exit |
|---|---|---|
| `seed` | `seed ready` 4.3 | stays up |
| Alice `sync --once` | `peer seeder 5a702e87` 3.3, `admitted 6186af23... 0` 3.4, `have 6186af23... 3` 3.4, `sync ready` 4.7, `sync done` 6.5 | 0 |
| Bob `follow` Alice, `sync --once` | `peer seeder 5a702e87` 3.1, `admitted 80450766... 0` 3.1, `downloaded 6186af23... 3` 3.1, `sync ready` 4.9, `sync done` 6.5 | 0 |
| Bob `feed` | Alice's post `primeira publicação pela DHT pública` | 0 |
| Bob `reply`, `sync --once` | `admitted 80450766... 1` 3.5, `have 80450766... 2` 3.5, `sync done` 7.0 | 0 |
| Alice `follow` Bob, `sync --once`, `feed` | `downloaded 80450766... 2` 3.6, `sync done` 6.8; the feed shows Bob's reply (`↳ 6186af23#2`) | 0 |

Then 30 more runs on the same seeder (Alice posts, Alice syncs, Bob syncs: 15 pairs) and 4 later runs (Bob after following the iPhone member below, Alice after a new post, Alice and Bob after the seeder restart below). All 38 `sync --once` runs:

| Measure | Value |
|---|---|
| Result | 36 `sync done` (exit 0), 2 `sync failed: sem pares` (exit 1) |
| First `peer seeder` (discovery) | 36 runs: min 2.9, median 3.8, max 31.0 |
| `admitted` after `peer seeder` | within 0.04 in 35 runs, 1.8 in one |
| `sync ready` (join and DHT flush) | 33 runs: min 4.7, median 7.0, 90th percentile 17.8, max 22.4 |
| `sync done` | 36 runs: min 6.2, median 9.0, max 32.6 |
| Ended only after the 30 s deadline | 4 runs (31.4 to 32.6), all `sync done` with `admitted` printed, none with `sync ready` |

The two failures:

- Bob: `sync ready` 20.6, then `aviso: par descartado (5a702e87): hello-timeout` 30.4 and `sync failed: sem pares` 31.5. A socket to the seeder opened but carried no hello; the seeder logged no `peer member` line during that run.
- Alice: no peer and no `sync ready`, `sync failed: sem pares` 32.4; the seeder logged nothing. Alice's next run (after one Bob run) ended `sync done` in 9.0.

Observations:

- `--once` cannot end before `sync ready`: the grace timer and the goal check start after the join and the DHT flush (`packages/core/lib/sync.js`). On the public DHT that flush, not the transfer, sets the run time: discovery and admission took a median 3.8 s, `sync ready` a median 7.0 s. When the flush outlasts `--timeout-ms`, the run ends at the deadline and still succeeds when its goals hold (the 4 runs above). The README's `--timeout-ms 30000` worked; a much shorter value would turn slow announces into failures.
- `downloaded <key> <length>` sometimes appears twice with the same length (2 CLI runs and the app run below). `packages/core/lib/sync.js` emits it both when the gate of a key completes and when the key grows. Cosmetic; not investigated further.

Seeder stop and restart:

- SIGINT to the `seed` process (forwarded to `node` by the timing wrapper, unlike the `pkill -f` note in "Not verified"): exit 0.
- Seeder down, Bob `sync --once`: `sync ready` 6.6, `sync failed: sem pares` 31.5, exit 1.
- The same `seed` command on the same data dir: `seed ready` 8.2. Alice (one new post): `admitted 6186af23... 19`, `have 6186af23... 20`, `sync done` 19.3. Bob: `downloaded 6186af23... 20`, `sync done` 20.6. SIGINT: exit 0 again.

### App (iOS simulator)

Built at the same commit with the section 2 steps: `npm ci`, `link:addons`, `pack:worklet` (1841148 bytes, 344 files, 38 linked addon entries; node scan clean), `pod install`, `xcodebuild` Debug (BUILD SUCCEEDED). The app was uninstalled, then installed; Metro ran without `EXPO_PUBLIC_VARANDA_GATE_URL` (member UI). iPhone 17 Pro simulator, iOS 26.2.

| Step | Result |
|---|---|
| Conectar | Association typed, bootstrap empty, "DHT pública" on (notice "O nó vai usar a DHT pública da internet para achar pares."), "endereço local da DHT" empty, "conectar": the member UI opened. `Documents/varanda-config.json` in the app container: `{"association":"<assoc>","bootstrap":null,"dhtHost":null,"allowPublicDht":true}`, which is only written after the node starts with it (docs/app.md) |
| Identidade | "criar identidade" -> `a08067be...`; the certificate from `assoc certify` was typed (iOS turned the quotes curly; the section 4 fix read them) -> "certificado de membro: válido" |
| Seguindo, Publicar | Alice and Bob followed ("2 diários seguidos"); `ola do iPhone pela DHT publica` -> "publicado" |
| Sincronizar uma vez | `peer seeder 5a702e87`, `admitted a08067be... 0`, `have a08067be... 2`, `downloaded 80450766... 2`, `downloaded 6186af23... 11`, `... 14`, `... 18`, `sync ready`; "última execução 1: concluída". The seeder logged the iPhone member about 5 s after the tap (wall clock, tap latency included) |
| A Rua | Alice's posts (`lote 10`, `lote 9`, ...) and the own post |
| CLI receives the iPhone post | After the app's run ended: Bob `follow a08067be...`, `sync --once` -> `admitted 80450766... 2`, `downloaded a08067be... 2`, `sync done` 7.7, exit 0; Bob's `feed` shows `ola do iPhone pela DHT publica` |

Screenshots: `09-ios-*.png` in the scratchpad.

Harness note: injected taps on the "DHT pública" switch were unreliable (once it showed on, then off again with no further tap). The state was checked on a screenshot before "conectar", and the saved config above confirms what the node received.

### Known defect reproduced: a loopback DHT host with the public DHT (issue #10)

Conexão tab, "DHT pública" still on, `127.0.0.1` typed in "endereço local da DHT", "aplicar e reiniciar o nó": accepted with no warning; the saved config became `{"bootstrap":null,"dhtHost":"127.0.0.1","allowPublicDht":true}`. "sincronizar uma vez" printed no line at all (not even `sync ready`) and ended "última execução 1: tempo esgotado"; the seeder logged no connection. With the field cleared and applied again (`dhtHost: null`), "sincronizar uma vez" printed `peer seeder 5a702e87`, `admitted a08067be... 2`, `downloaded 6186af23... 19` (a post Alice made meanwhile) and `sync ready`, and ended "concluída". The stale "sincronização única iniciada" notice also stayed on Sincronizar across both node restarts. Both are in issue #10; nothing was changed here.

## Not verified

- Android native run (no SDK or Java on this Mac).
- Real devices (iOS or Android); only the iPhone 17 Pro simulator.
- The public DHT between distinct machines or networks, or through NAT or CGNAT: section 6 joined it, but with every peer on one Mac (issues #36 and #42).
- The web client on the public DHT (`varanda-serve --public-dht`), and a continuous sync ("sincronizar sempre", `sync` without `--once`) on it.
- A scripted WebSocket client acting like the page (the real page in a browser was used instead).
- The exit code of `seed` and `local-dht.js` on SIGINT in this run: they were stopped with `pkill -INT -f`, which also signalled their wrapper shells, so the wrapper reported 1. The demo covers the seeder's SIGTERM exit 0.

## Residual risks

- Everything in the "Residual risks" list of [ios-gate.md](ios-gate.md) still applies (Android unverified, fs facade TOCTOU, Bare version split between bare-kit and bare-runtime, linked addons wiped by every install, dev reload can take over a live lock).
- **Public DHT with a loopback DHT host.** Turning on "DHT pública" keeps the "endereço local da DHT" field (`127.0.0.1` here) in the config. The README warns that a loopback DHT host keeps the DHT away from public peers. The form does not clear or warn about it. Section 6 reproduced it: the sync times out without a single line (issue #10). Fixed afterwards (#10): the form and the node session refuse a loopback DHT host with the public DHT, and a configuration saved before the fix loses only that host when the app reads it; checked on the simulator (the refusal in Conexão; a hand-written old config started on the public DHT and synced).
- **Public DHT reliability.** On one Mac, 2 of 38 `sync --once` runs found no usable peer within 30 s (`sem pares`) while the seeder was up, and 4 ran into the deadline because the DHT flush was slow. A person may need to sync again; across real networks the rate is unknown until #36 and #42.
- **Stale notices.** Screen-local notices outlive the state they describe: "sincronização contínua iniciada" stays after the node ended and the sync state was reset; "publicado" stays on the Responder screen. Cosmetic. Fixed afterwards (#10): a notice now belongs to the node run and to its screen context (the sync run, the post being answered) and is cleared when either ends; checked on the simulator ("iniciada" gone when the run ended, "publicado" gone on Responder, after cancelling and after a node restart).
- **Earlier app state.** The simulator still had a node and config from an earlier association; the app was uninstalled first. Changing association after an identity exists requires removing the app data by hand (by design: the association is read-only once an identity exists).

## Fixes made in this verification

- `apps/app/src/screens/Identidade.js`: curly double quotes typed by iOS smart punctuation are read as `"` before `JSON.parse` of the certificate (section 4).
- `docs/development.md`: the web export's output directory is stated (`apps/app/dist`, "Exported: dist") instead of "confirm the output directory".
- This file.

## Security audit fixes (after this verification)

The security audit of the branch (Claude and GPT; Grok's account was out of credit) found four verified issues, each rated high after triage. They were fixed after the checks above:

- **Android release signing** (`apps/app/android/app/build.gradle`): release builds were signed with the committed public debug keystore, so anyone could sign an "update" that reads the node's data. Release signing now comes only from `VARANDA_RELEASE_*` Gradle properties kept outside the repository, and a release build fails without them; debug builds use the `app.varanda.debug` application ID. Not built here (no Java).
- **Android backups** (`AndroidManifest.xml`, `app.json`): `allowBackup` was true, so the node's key material went to cloud backups. It is now false. Not built here.
- **iOS backups** (`apps/app/ios/Varanda/AppDelegate.swift`): `Documents/varanda` is marked as excluded from iCloud and device backups at launch. Checked on the iPhone 17 Pro simulator after a rebuild: `xattr -l` on the container's `Documents/varanda` shows `com.apple.metadata:com_apple_backup_excludeItem: com.apple.MobileBackup`, and `varanda-config.json` (not secret) is still backed up.
- **varanda-serve token** (`apps/cli/lib/serve/args.js`): a fixed `VARANDA_SERVE_TOKEN` would keep a URL left in the browser history valid across restarts. The variable is now refused and the token is generated on every start (`apps/cli/test/serve.test.js` covers both); the README advises a private window. This changes the 4b "server stopped" recovery: after a restart the page must be reopened with the new URL.
