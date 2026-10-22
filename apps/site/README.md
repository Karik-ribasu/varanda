# @varanda/site

O site estático do Varanda (varanda.app). Pacote privado do monorepo, sem JavaScript na página, sem formulários, sem cookies e sem rastreadores.

- `public/`: a raiz publicável. Só esta pasta vai para a GitHub Pages.
- `artwork/`: as fontes do logotipo, `og.html` (a imagem de compartilhamento), `app-design.md` (o desenho novo do app, que a página mostra em prévia) e `screens.md` (a receita para capturar o app de verdade quando ele tiver esse desenho). Nunca são publicadas.
- `scripts/`: `serve.js` (servidor local) e `render-assets.js` (gera ícones, abertura e favicons a partir do logotipo).

```sh
npm run dev -w apps/site
```

Abre em http://127.0.0.1:4173/. Para ver como ficará em https://varanda-org.github.io/varanda/, use `node apps/site/scripts/serve.js --prefix /varanda`.

Para regenerar os ícones: `node apps/site/scripts/render-assets.js` (precisa de `rsvg-convert`: `brew install librsvg`); com `--check` só verifica. O `cwebp` (`brew install webp`) só serve para a receita de capturas em `artwork/screens.md`.

## Prévia do app

As três telas da página (o herói e a seção "O app novo, em prévia") não são capturas: são HTML e CSS dentro da moldura do telefone, com conteúdo fictício, mostrando o desenho que o app vai ganhar. O desenho está em [artwork/app-design.md](artwork/app-design.md); as classes `.app`, `.post`, `.avatar`, `.folha` e `.perfil` em `public/styles.css` são a referência visual.

## Imagem de compartilhamento

`public/assets/og-varanda.jpg` (1200x630) é a imagem que o WhatsApp, o Telegram, o X e o iMessage mostram quando alguém cola https://varanda.app. Ela sai de `artwork/og.html`, que não usa fonte nenhuma: o único lettering é o VARANDA desenhado do logotipo, e o telefone mostra um esqueleto do feed novo (avatares, barras no lugar do texto, as abas e o botão de publicar), sem letra. Para refazer (no macOS, com o Google Chrome instalado), a partir da raiz do repositório:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,630 --screenshot=/tmp/og-varanda.png file://$PWD/apps/site/artwork/og.html
sips -s format jpeg -s formatOptions 99 /tmp/og-varanda.png --out apps/site/public/assets/og-varanda.jpg
```

Confira com `sips -g pixelWidth -g pixelHeight` que o PNG saiu com 1200x630 (algumas versões do Chrome acrescentam uns pixels) e que o JPEG não passa de 200 KB; se passar, baixe a qualidade. A saída do Chrome varia entre versões, por isso o JPEG não é verificado por `render-assets.js --check`.

Documentação completa, inclusive os passos de domínio e DNS: [docs/site.md](../../docs/site.md).
