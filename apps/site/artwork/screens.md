# App screenshots for varanda.app

> **Note (2026-10-23).** The page shows captures of the real app again. From 2026-10-22 it showed a design preview drawn in HTML and CSS; the app now has that design, so the preview was replaced by these three screenshots. The first screenshots (2026-10-22, six files of the old interface) are not in the repository: they were removed before the page was first committed.

The hero phone and the three phones in "O app por dentro" are screenshots of the real Varanda app: the iOS member UI on the iPhone 17 Pro simulator. They are not mockups and nothing was repainted. The people and the posts are fictional.

## Files

All three are in `apps/site/public/assets/screens/`, at one width: 603x1311 (1.5 times the 402x874 pt screen), WebP at `-q 70`. Each comes from one full-size simulator capture (1206x2622 PNG, kept out of the repository). The hero uses `a-rua.webp` too.

| File | Size | Bytes | sha256 |
|---|---|---|---|
| `a-rua.webp` | 603x1311 | 45 044 | `061dba72559788b1c2b08897affa89ea032eb10bff68bd168466248d3ec1f5ef` |
| `publicar.webp` | 603x1311 | 18 900 | `6be843535a1dbaa593dca7dd30b3b8fe66a6db95a062456f800e7c6192cb8840` |
| `diario.webp` | 603x1311 | 31 976 | `53d5931421bc178e3dfa1dac7ab411ef6a056a1d21b1421a7a8ea1b2f96e06ed` |

Together 95 920 bytes. `apps/site/test/site.test.js` checks the three files (WebP, 603x1311, referenced with `width="603" height="1311"`), caps each at 50 000 bytes and the three at 100 000, and allows no other file in the folder. `-q 70` is the highest quality that stayed near the old page budget: `-q 80` gave 112 624 bytes for the three, `-q 75` 99 634; `-sharp_yuv` and the `text` and `drawing` presets came out larger at the same quality.

What each one shows:

- **A Rua**: the top of the feed, newest first: Marília Prado ("agora"), Bia Carvalho, Seu Nelson, Helena Dias's post, Helena's reply ("respondendo a Bia Carvalho"), Marília's reply ("respondendo a Seu Nelson"), and one more card of Marília's cut off under the tab bar, the way a feed looks while you scroll. The sync chip says "sincronizado agora"; the green publish button and the three tabs are on screen.
- **Publicar**: the sheet over A Rua with the unsent draft "Tem um livro parado na estante? Que tal uma troca no fim de semana?", the caret at the end, the counter at 67/1000, the Publicar pill enabled, and the Portuguese (Brazil) keyboard up: suggestions "Você / Eu / Se", "PT" on the space bar.
- **Diário**: Helena's header (the sunset band, the gear, the yellow avatar, Editar perfil, the name, `@b6b326`, the bio, "3 seguindo"), then under "PUBLICAÇÕES" her post and her reply, then the "#1 · perfil" and "#0 · certificado de membro" rows.

The status bar is set to 9:41, full battery (charged), 4 cellular bars and 3 Wi-Fi bars. No dev overlay, LogBox or Metro banner is on screen.

## Environment

- App: branch `feat/app-new-design` at `28ac4f8`, the Debug build `apps/app/ios/build/Build/Products/Debug-iphonesimulator/Varanda.app` of that tree. JS was served by Metro from `apps/app` of the same tree, started without `EXPO_PUBLIC_VARANDA_GATE_URL` and without `CI=1`.
- Simulator: iPhone 17 Pro, iOS 26.2 (UDID `8802DF5C-6A82-406C-8D4D-29618AEEA2BC`).
- Network: loopback only. There was a local DHT on `127.0.0.1:49800` and one certified seeder, and nothing joined the public DHT.
- **The app was uninstalled first** (`xcrun simctl uninstall booted app.varanda`), which erases whatever demo data the simulator had. The app stays installed afterwards with the Helena Dias data.
- Test data lived in a session scratchpad directory (`<scratch>` below), outside the repository.
- Captured on 2026-10-23: A Rua and Diário first, Publicar again later the same morning with the Portuguese keyboard (the first Publicar capture had the English one). The simulator clock was not changed; only the status bar was overridden.

## Fictional content

People (CLI members unless noted), with the avatar colour each one got. The colour is the first byte of the public key mod 5 (0 azul, 1 laranja, 2 amarelo, 3 vermelho, 4 verde); the CLI keys were picked for it, Helena's is the one the app generated.

| Name | Bio | Key starts | Colour |
|---|---|---|---|
| Marília Prado | café passado na hora e conversa boa | `a84886` | vermelho |
| Bia Carvalho | professora, corre no calçadão | `112fd7` | amarelo |
| Seu Nelson | aposentado, feirante de coração | `37ec7b` | azul |
| Helena Dias (the iOS app) | converso de varanda, de frente pro mar | `b6b326` | amarelo |

Posts (the numbers are the ones the recipe uses; Helena published 6 before 5, so in A Rua her post sits above her reply):

1. Seu Nelson: "Alguém sabe se a feira de sábado muda de rua? A barraca da manga é a melhor."
2. Bia Carvalho: "Fim de tarde no calçadão, vento bom, o mar de um azul que não cabe na foto."
3. Marília Prado: "Choveu de tarde e a varanda encheu: café, bolo de fubá e conversa até escurecer."
4. Marília Prado, reply to Nelson's post: "Mudou sim, duas quadras pra cima. A manga continua lá."
5. Helena Dias (app): "Terminei de pintar a grade da varanda. Amanhã tem café pra quem passar."
6. Helena Dias (app), reply to Bia's post: "Esse azul eu conheço. Guarda um pouco de vento pra mim."
7. Seu Nelson: "Obrigado, Marília. Sábado cedo eu passo."
8. Bia Carvalho: "Amanhã tem corrida cedo. Quem vem junto?"
9. Marília Prado: "Helena, guarda uma xícara pra mim!"

There is also the unsent draft in Publicar: "Tem um livro parado na estante? Que tal uma troca no fim de semana?"

Posts 7 to 9 are there so the top of A Rua shows four different authors. Without them, Helena's two entries sit next to each other and so do Marília's two, and no screen-sized window shows four authors.

## Commands

Run from the repository root. `<scratch>` is a fresh empty directory.

```sh
node apps/cli/scripts/local-dht.js --port 49800 &            # background; note the PID
B="--bootstrap 127.0.0.1:49800 --dht-host 127.0.0.1"

# association and seeder
line=$(node bin/varanda.js assoc init --data <scratch>/assoc); ASSOC=${line##* }
line=$(node bin/varanda.js seed key --data <scratch>/seeder --association $ASSOC); SEEDER=${line##* }
node bin/varanda.js assoc certify-seeder --data <scratch>/assoc --seeder $SEEDER --out <scratch>/certs/seeder.json
node bin/varanda.js seed cert add --data <scratch>/seeder --association $ASSOC --cert-file <scratch>/certs/seeder.json
node bin/varanda.js seed --data <scratch>/seeder --association $ASSOC $B &   # background; note the PID

# each CLI member (marilia 3, bia 2, nelson 0): create keys in fresh dirs until the colour matches
line=$(node bin/varanda.js id create --data <scratch>/try --association $ASSOC); KEY=${line##* }
echo $(( 16#${KEY:0:2} % 5 ))                                # the colour; not the target: rm -rf <scratch>/try and retry
mv <scratch>/try <scratch>/<m>
node bin/varanda.js assoc certify --data <scratch>/assoc --member $KEY --age-band 18+ --method stub --out <scratch>/certs/<m>.json
node bin/varanda.js cert add --data <scratch>/<m> --cert-file <scratch>/certs/<m>.json
node bin/varanda.js profile set --data <scratch>/<m> --name '<name>' --bio '<bio>'

# posts 1-4 about a minute apart (so the times differ), the reply with --to <nelson key>:<seq>
node bin/varanda.js post  --data <scratch>/nelson  --text '...'
node bin/varanda.js reply --data <scratch>/marilia --to <nelson key>:2 --text '...'
# then each member, so the seeder admits them:
node bin/varanda.js sync --data <scratch>/<m> --once --timeout-ms 30000 $B
```

iOS app:

```sh
xcrun simctl uninstall booted app.varanda
xcrun simctl install booted apps/app/ios/build/Build/Products/Debug-iphonesimulator/Varanda.app
(cd apps/app && npx expo start --port 8081 --clear) &        # background; no gate URL, no CI=1
xcrun simctl launch booted app.varanda
```

In the app, which opens on the first-time setup before the tabs appear: **Conectar** (association key, bootstrap `127.0.0.1:49800`, DHT host `127.0.0.1`). Then **Identidade**: "criar identidade", then `assoc certify --member <app key> ...` and paste the JSON into the certificate field, then "gravar certificado". Then the tabs:

1. **Diário › Editar perfil**: Helena Dias and the bio (pasted).
2. **Seguindo**: paste each CLI key into the field at the top and tap **Seguir**.
3. Sync once: tap the sync chip on A Rua (or Ajustes › Sincronizar, from the gear on Diário) and "sincronizar uma vez".
4. Post 6: in **A Rua**, the reply balloon on Bia's post 2 opens the sheet with "respondendo a Bia Carvalho"; paste the text, **Publicar**.
5. Post 5: the green publish button, paste, **Publicar**. Sync again.
6. The CLI posts 7 to 9, each followed by `sync --once` for that member, about 45 s apart. Then a third app sync.

Then, for each capture:

```sh
xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100 --cellularMode active --cellularBars 4 --wifiMode active --wifiBars 3 --dataNetwork wifi
xcrun simctl io booted screenshot --type png <scratch>/<name>.png      # a-rua, publicar, diario
sips -Z 1311 <scratch>/<name>.png --out <scratch>/<name>-603.png
cwebp -q 70 -m 6 -metadata none <scratch>/<name>-603.png -o apps/site/public/assets/screens/<name>.webp
```

- **A Rua**: the A Rua tab, scrolled to the top, after the last sync.
- **Publicar**: first the keyboard (below), then the green publish button, paste the draft, leave the keyboard up and the caret at the end.
- **Diário**: the Diário tab, scrolled to the top.

Finally `xcrun simctl status_bar booted clear`, and stop Metro, the seeder and the DHT by their PIDs. A process started in the background of a non-interactive shell ignores SIGINT, so use SIGTERM.

### The Portuguese keyboard (Publicar)

The page is in Portuguese, so the keyboard in Publicar is the Portuguese (Brazil) one. Record the simulator's settings first, so you can put them back:

```sh
xcrun simctl spawn booted defaults read -g AppleLanguages
xcrun simctl spawn booted defaults read -g AppleLocale
xcrun simctl spawn booted defaults read -g AppleKeyboards
```

Then set pt-BR and reboot the simulator:

```sh
xcrun simctl spawn booted defaults write -g AppleLanguages -array pt-BR
xcrun simctl spawn booted defaults write -g AppleLocale -string pt_BR
xcrun simctl spawn booted defaults write -g AppleKeyboards -array 'pt_BR@sw=QWERTY;hw=Automatic' 'emoji@sw=Emoji'
xcrun simctl shutdown booted; xcrun simctl boot <udid>; xcrun simctl bootstatus <udid> -b
```

On boot iOS may add an English keyboard back and open on it. If the space bar says "EN", tap the globe key until it says "PT". The first time the keyboard opens it may show the "slide to type" tip; tap "Continue". Check that the suggestions are Portuguese ("Você / Eu / Se") before you capture. Afterwards write the recorded values back with the same `defaults write` commands and reboot again.

## How to redo it, and the pitfalls

- **Accented text.** Use the simulator's paste, not typed input. With simulated typing or the tool's text paste, "ã" and "é" arrived as MacRoman mojibake ("Amanh√£"). What worked: `printf '%s' '<text>' | LC_ALL=en_US.UTF-8 xcrun simctl pbcopy booted`, then long-press the field and choose "Paste". The edit menu says "Paste" in English even in pt-BR, because the app bundle declares only English (`CFBundleDevelopmentRegion` `en`, no `.lproj`); the menu is gone before the capture. ASCII text (keys, certificate JSON, the name) types fine. Smart quotes in the certificate JSON are handled by the app.
- **Swallowed taps.** The first tap after typing into a field is sometimes swallowed (see docs/verification.md), and right after a simulator boot input can fail for a few seconds. Wait about a second before tapping the button, then check that it took effect. If it didn't, tap again.
- **Navigation.** There are three tabs (A Rua, Seguindo, Diário) and the bar does not scroll. Sincronizar, Conexão and Identidade are in Ajustes (the gear on the Diário header); the sync chip on the top bar opens Sincronizar too.
- **Simulator screenshots.** The iOS Simulator tool's own screenshot can lag a step behind. Check every state with `xcrun simctl io booted screenshot`.
- **Before you encode.** Look at each PNG: right tab, no overlay, 9:41 in the status bar, the Portuguese keyboard in Publicar and no keyboard on the other two, and none of the old test strings.
