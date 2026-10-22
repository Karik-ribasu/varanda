# Varanda logo concepts

Three original directions for the Varanda mark, all built from the same two
ideas the project chose: the *mar largo* wave of the Copacabana calçadão and the
warm *fim de tarde* light. Every file here is hand-written SVG (paths only, no
text, no images, no external references), uses a `viewBox` of `0 0 256 256` for
the marks, and comes with a one-colour version and a horizontal lockup. Palette:
green `#1d6b4f`, ink `#1f2a24`, cream `#fbf8f3`, warm `#fff4e0` from the app,
plus the sunset tones peach `#f7b267`, coral `#e8805a`, plum `#8a4e7a` and a
deeper sea green `#15503a`.

The wordmark (`wordmark.svg`, also embedded in each `*-lockup.svg`) is a set of
original monoline paths: five rounded letterforms (v, a, r, n, d) drawn on a
100-unit x-height with a 26-unit stroke. No font is used or outlined, so no
font licence is involved.

## A · ondas (`a-ondas.svg`)

The calçadão itself, distilled: alternating ink and cream wave bands with the
slightly leaning crests of the Burle Marx pavement, clipped to the icon square.
It is the most ownable of the three because it is a pattern people already
associate with Rio and with walking and talking by the sea. At 16 px it becomes
three clean wavy bars, which is still unmistakably "waves". The one-colour
version is the same thing with the cream dropped: ink bands on whatever sits
behind them, so it works on paper, on cream and as a stencil. As an app icon
the cream square carries the bands on iOS and the circle crop on Android still
shows two and a half waves; it also sits well on a dark home screen.

## B · grade (`b-grade.svg`)

The porch railing where the sea is the top rail: a thick peach wave band (the
afternoon light on the water) with three cream slats hanging from it to a
straight bottom rail, on the app green. It is the concept that says "varanda"
most literally, and the porch and the wave are one object. At 16 px it reads as
a wavy bar above three posts on a base, which survives better than the earlier
attempts with a thin wavy rail (those turned into a roller coaster). The
one-colour version keeps the whole icon square in one colour with the railing
cut out of it, so it reads at a glance even as a favicon. As an app icon the
composition is centred and low, which suits both the iOS squircle and the
Android circle; nothing important lives near the corners.

## C · sol (`c-sol.svg`)

Fim de tarde: a warm sun disc (cream to peach) half behind a green wave, with a
second, deeper wave below it echoing the calçadão stripes, on a plum-to-coral
sky. It is the warmest and most pictorial of the three. At 16 px it still reads
as a sun setting into waves because the shapes are large and the contrast
between sun, sky and sea is high. The one-colour version drops the sky: a solid
sun kept clear of the sea by a small gap, and the sea as two ink wave bands, so
it stays recognisable in a single ink. As an app icon it is the most "poster"
of the three and loses nothing to either launcher mask since the sun sits in
the middle of the square.

## Files

| concept | mark | one-colour | lockup |
| --- | --- | --- | --- |
| A ondas | `a-ondas.svg` | `a-ondas-mono.svg` | `a-ondas-lockup.svg` |
| B grade | `b-grade.svg` | `b-grade-mono.svg` | `b-grade-lockup.svg` |
| C sol | `c-sol.svg` | `c-sol-mono.svg` | `c-sol-lockup.svg` |

`wordmark.svg` is the standalone wordmark in ink. The mono files take their
colour from a single `fill`, so recolouring them is a one-line edit.

## Round 2: cadeira de praia

After seeing round 1 the direction changed: the mark is now the *cadeira de
praia*, the light folding beach chair with a seat and back of bold striped
straps that you rent on any Brazilian beach (it also names the app's group
conversations, "Cadeiras de Praia"). The reference the user gave was a casual
hand-drawn chair in black ink with hand-lettered capitals stacked under it, and
the chair had to sit on the diagonal so it looks three-dimensional. So all
three concepts are variations of one idea: a hand-drawn beach chair in
three-quarter view above a hand-lettered **VARANDA**.

How it is built. The chair is modelled as a small 3D object (seat, back, the
two tubes of each side that cross in an X under the seat, armrests) and drawn
through a pinhole camera turned about 36 degrees and tilted 25 degrees down,
so back, seat and crossed legs are visible at once and the depth is real: the
far side is a little smaller and thinner than the near side, the near frame
overlaps the far frame where they cross, the seat and back are foreshortened
planes, and the straps converge towards the far side and bend with the sag of
the sling. The fabric shows its thickness as a darker strip where it wraps
the front rail of the seat and the top rail of the back, and a flat ground
shadow (one ink shape at 13% opacity) anchors the chair. Every ink line is a
filled outline generated from a hand-placed centreline with a small
deterministic wobble and a marker-like varying width; the letters V, A, R, N,
D are our own strokes, not an outlined typeface. No text, images, gradients or
filters anywhere. The stripes are a set that never lines up like the flag:
sea blue `#2a7fb8`, coral `#e8805a`, yellow `#f2b705`, red-orange `#e94e3c`,
green `#1d6b4f`. Hand-drawn files are larger than round 1 (marks 6-8 KB,
stacked lockups 14-15 KB).

Every concept ships six files: the mark on a cream tile (`*.svg`), the same
chair on a colour tile (`*-tile.svg`), a one-colour version with no tile
(`*-mono.svg`: ink frame and ink bars with gaps for the straps, no shadow, so
it works on paper, as a stencil, or recoloured to cream on the site's sunset
gradient), the stacked lockup in ink for cream backgrounds (`*-lockup.svg`)
and in cream for ink backgrounds (`*-lockup-dark.svg`), and a 16 px favicon
(`*-favicon.svg`). At 16 px a hand-drawn chair in perspective is a smudge, so
the favicon is a deliberate simplification drawn as plain geometry: the
striped panel inside a thin ink frame, with no depth.

### D · cadeira (`d-cadeira.svg`)

The classic folding beach chair on the diagonal: upright back, flat seat,
horizontal straps across both, armrests, the X of the legs and the ground
shadow. It is the plainest statement of the idea and the one that most says
*a chair someone left on the calçadão*. At 180 px every depth cue is there; at
64 px it is still clearly a striped chair seen from the corner with crossed
legs; at 32 px a striped seat on legs; at 16 px the favicon is a slightly
skewed ink frame around five stripes. As an app icon the chair sits in the
middle of the tile and survives the iOS squircle and the Android circle; the
colour tile is peach `#f7b267`.

### E · reclinada (`e-reclinada.svg`)

The same view, but the low, reclined beach chair: the seat is near the ground
and tilts back, the back leans far back, and the sling sags, so every strap
curves, which is the strongest depth cue of the three. Under its feet a short
calçadão wave line is the ground instead of a shadow, which puts the chair on
the beach. At 64 px the curved straps and the leaning back keep it a lounger;
at 32 px a leaning striped shape with a wave; the favicon is five sagging
straps over the wave. The colour tile is warm `#fff4e0`, so the stripes stay
the loudest thing on it.

### F · gráfica (`f-grafica.svg`)

The boldest of the three: a thicker ink frame, wider straps (fewer, so each
colour is a shape), a slightly stronger turn of the camera, and lettering with
more personality (heavier strokes, more bounce and tilt in the letters). It
reads first as a poster and then as a chair, and holds up best from across
the room. At 64 px it is the most legible of the three because the straps are
wide; the favicon is a thick ink frame around three wide stripes. The colour
tile is sea blue `#2a7fb8`.

### Round-2 files

| concept | cream tile | colour tile | one-colour | lockup (ink) | lockup (cream) | favicon |
| --- | --- | --- | --- | --- | --- | --- |
| D cadeira | `d-cadeira.svg` | `d-cadeira-tile.svg` | `d-cadeira-mono.svg` | `d-cadeira-lockup.svg` | `d-cadeira-lockup-dark.svg` | `d-cadeira-favicon.svg` |
| E reclinada | `e-reclinada.svg` | `e-reclinada-tile.svg` | `e-reclinada-mono.svg` | `e-reclinada-lockup.svg` | `e-reclinada-lockup-dark.svg` | `e-reclinada-favicon.svg` |
| F gráfica | `f-grafica.svg` | `f-grafica-tile.svg` | `f-grafica-mono.svg` | `f-grafica-lockup.svg` | `f-grafica-lockup-dark.svg` | `f-grafica-favicon.svg` |

The round-1 `wordmark.svg` (lower-case monoline) is unchanged and is not used
by the round-2 lockups, which carry their own hand-lettered capitals.
