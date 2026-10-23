# @varanda/site

O site estático do Varanda (varanda.app). Pacote privado do monorepo, sem JavaScript na página, sem formulários, sem cookies e sem rastreadores.

- `public/`: a raiz publicável. Só esta pasta vai para a GitHub Pages.
- `artwork/`: as fontes do logotipo, `og.html` (a imagem de compartilhamento), `app-design.md` (o desenho do app) e `screens.md` (a receita das capturas do app que a página mostra). Nunca são publicadas.
- `scripts/`: `serve.js` (servidor local) e `render-assets.js` (gera ícones, abertura e favicons a partir do logotipo).

```sh
npm run dev -w apps/site
```

Abre em http://127.0.0.1:4173/. Para ver como ficará em https://varanda-org.github.io/varanda/, use `node apps/site/scripts/serve.js --prefix /varanda`.

Para regenerar os ícones: `node apps/site/scripts/render-assets.js` (precisa de `rsvg-convert`: `brew install librsvg`); com `--check` só verifica. O `cwebp` (`brew install webp`) só serve para a receita de capturas em `artwork/screens.md`.

## Prévia do app

As telas da página (o herói e a seção "O app por dentro") são capturas do app de verdade no simulador do iPhone, com conteúdo fictício: A Rua, Publicar e Diário, em `public/assets/screens/` (WebP de 603x1311, o herói repete A Rua). A receita, com os bytes e o sha256 de cada arquivo, está em [artwork/screens.md](artwork/screens.md); o teste do site confere os três arquivos e o limite de tamanho. O desenho do app está em [artwork/app-design.md](artwork/app-design.md).

## Imagem de compartilhamento

`public/assets/og-varanda.jpg` (1200x630) é a imagem que o WhatsApp, o Telegram, o X e o iMessage mostram quando alguém cola https://varanda.app. Ela sai de `artwork/og.html`, que não usa fonte nenhuma: o único lettering é o VARANDA desenhado do logotipo, e o telefone mostra um esqueleto do feed novo (avatares, barras no lugar do texto, as abas e o botão de publicar), sem letra. Para refazer (no macOS, com o Google Chrome instalado), a partir da raiz do repositório:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,630 --screenshot=/tmp/og-varanda.png file://$PWD/apps/site/artwork/og.html
sips -s format jpeg -s formatOptions 99 /tmp/og-varanda.png --out apps/site/public/assets/og-varanda.jpg
```

Confira com `sips -g pixelWidth -g pixelHeight` que o PNG saiu com 1200x630 (algumas versões do Chrome acrescentam uns pixels) e que o JPEG não passa de 200 KB; se passar, baixe a qualidade. A saída do Chrome varia entre versões, por isso o JPEG não é verificado por `render-assets.js --check`.

Documentação completa, inclusive os passos de domínio e DNS: [docs/site.md](../../docs/site.md).
