# The Varanda logo

**Concept D, "cadeira"**, chosen by the user on 2026-10-22 after three rounds of
steering (hand-drawn like their reference, on the diagonal, with real 3D depth).
It is a hand-drawn Brazilian folding beach chair seen in three-quarter view,
with horizontal straps in five colours, an ink frame, crossed legs and a soft
ground shadow, above hand-lettered capitals **VARANDA**. The other concepts and
how D is built are in [`concepts/README.md`](concepts/README.md), which is the
design record and is not changed.

The chair and the lettering are original drawings: every stroke is a filled
outline generated from hand-placed centrelines (a small 3D model of the chair
seen through a pinhole camera, and our own V, A, R, N, D strokes). No typeface,
no stock art, no `<text>`, images, external references, filters or gradients.

## Colours

| use | hex |
| --- | --- |
| ink (frame, lettering) | `#1f2a24` |
| cream (tile, icon and splash background) | `#fbf8f3` |
| stripes | `#2a7fb8` `#e8805a` `#f2b705` `#e94e3c` `#1d6b4f` |
| brand green | `#1d6b4f` |
| warm | `#fff4e0` |
| peach | `#f7b267` |

Cream `#fbf8f3` is the one background colour of the app icon and the splash:
`apps/app/app.json` (splash and adaptive icon), `colors.xml`
(`splashscreen_background`, `iconBackground`), the iOS `SplashScreenBackground`
colour set and the storyboard's copy of it.

## Files

All SVGs here are written by `generator/cadeira.py`.

| file | what it is for |
| --- | --- |
| `mark.svg` | the chair on the cream tile (256, rx 58): the symbol, the site footer |
| `mark-mono.svg` | one colour, no tile, no shadow: print, stencil, recolouring |
| `chair.svg` | the colour chair with its shadow on a transparent background (256): the site hero |
| `lockup.svg` | stacked: chair above VARANDA, ink lettering, transparent (520 x 470) |
| `lockup-dark.svg` | the same in cream for ink backgrounds |
| `lockup-horizontal.svg` | chair at the left, VARANDA on one line on the same baseline (785 x 224): the site header |
| `favicon.svg` | 16 px simplification: five stripes in a slightly skewed ink frame, inside the box |
| `icon-ios.svg` | 1024, full-bleed cream, the chair as in the mark (iOS applies the mask) |
| `icon-android-foreground.svg` | 108 canvas, the chair inside the central 66-unit safe circle, transparent outside |
| `icon-android-background.svg` | flat cream, 108 |
| `icon-android-monochrome.svg` | the one-colour chair, same place, for themed icons |
| `icon-android-legacy.svg` | background plus foreground, square, as Expo composes `ic_launcher` |
| `icon-android-legacy-round.svg` | the same in a circle, as `ic_launcher_round` |
| `splash.svg` | 1024, transparent, the chair in the middle 40% (at least 30% margin on each side) |
| `asset-manifest.json` | written by `render-assets.js`: every rendered file with size, bytes and sha256 |
| `generator/cadeira.py` | the drawing itself (Python 3 standard library, deterministic) |

`render-assets.js` turns these into the app icons (`apps/app/assets`, the iOS
`AppIcon` and `SplashScreenLegacy`, the Android mipmaps and
`splashscreen_logo`) and the site's `favicon.svg`, `favicon-32.png`,
`apple-touch-icon.png` and `assets/logo-*.svg`, `assets/cadeira.svg`. The
Android mipmaps are PNG bytes in `.webp` files, as Expo writes them.

## Regenerate

```sh
/opt/homebrew/bin/python3.14 apps/site/artwork/logo/generator/cadeira.py   # or any Python 3
node apps/site/scripts/render-assets.js                                    # needs rsvg-convert (brew install librsvg)
node apps/site/scripts/render-assets.js --check                            # verifies, writes nothing
```

Both steps are deterministic: a second run writes byte-identical files.
`cadeira.py` reproduces the approved concept files (`concepts/d-cadeira.svg`,
`d-cadeira-mono.svg`) unchanged; the only refinement since the concept is a
slightly wider R bowl in the lettering, so its counter stays open at header
sizes.
