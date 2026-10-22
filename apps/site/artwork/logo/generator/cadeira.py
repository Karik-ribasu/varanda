#!/usr/bin/env python3
"""The Varanda logo, concept D "cadeira": a hand-drawn Brazilian folding beach
chair on the diagonal (three-quarter view) above hand-lettered VARANDA.

Every stroke is a filled outline built from a hand-placed centreline, a slight
deterministic wobble and a varying marker width, so nothing here is text or an
outlined font. The chair is a small 3D model drawn through a pinhole camera.
Python 3 standard library only; every random choice is seeded, so a second run
writes byte-identical SVGs.

usage: cadeira.py [OUT_DIR]   (default: apps/site/artwork/logo, this folder's parent)
Then render the PNGs with: node apps/site/scripts/render-assets.js"""
import math
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(HERE)

INK = "#1f2a24"
CREAM = "#fbf8f3"
# stripe set (never green-yellow-blue in flag order): sea blue, coral, yellow, red-orange, green
STRIPES = ["#2a7fb8", "#e8805a", "#f2b705", "#e94e3c", "#1d6b4f"]


def svg(vb, body): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}">\n{body}\n</svg>\n'


def write(name, s):
    p = os.path.join(OUT, name)
    with open(p, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(s)
    print(f"{name:34s} {os.path.getsize(p):6d} B")


def f1(v): return f"{v:.1f}".rstrip("0").rstrip(".")


def f3(v): return f"{v:.3f}".rstrip("0").rstrip(".")


# ------------------------------------------------------------ the marker
def resample(pts, step):
    """Uniform points along a polyline."""
    out = [pts[0]]; acc = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        d = math.hypot(x1 - x0, y1 - y0)
        if d == 0: continue
        t = step - acc
        while t <= d:
            out.append((x0 + (x1 - x0) * t / d, y0 + (y1 - y0) * t / d)); t += step
        acc = d - (t - step)
    if out[-1] != pts[-1]: out.append(pts[-1])
    return out


def smooth_path(pts):
    """Closed path through the midpoints with the points as controls (quadratic)."""
    n = len(pts); m = lambda i: ((pts[i][0] + pts[(i + 1) % n][0]) / 2, (pts[i][1] + pts[(i + 1) % n][1]) / 2)
    d = f"M{f1(m(0)[0])} {f1(m(0)[1])}"
    for i in range(1, n + 1):
        p = pts[i % n]; q = m(i % n)
        d += f"Q{f1(p[0])} {f1(p[1])} {f1(q[0])} {f1(q[1])}"
    return d + "Z"


def brush(pts, width, seed, wobble=1.0, step=15, var=0.16, taper=0.0):
    """A filled marker stroke along the polyline pts."""
    rnd = random.Random(seed)
    ph = [rnd.uniform(0, 6.28) for _ in range(4)]; fr = [rnd.uniform(0.05, 0.12) for _ in range(4)]
    P = resample(pts, step)
    T = []
    for i, p in enumerate(P):
        a = P[max(i - 1, 0)]; b = P[min(i + 1, len(P) - 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]; l = math.hypot(dx, dy) or 1
        T.append((dx / l, dy / l))
    L = []; R = []; dist = [0.0]
    for i in range(1, len(P)): dist.append(dist[-1] + math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]))
    total = dist[-1] or 1
    for i, p in enumerate(P):
        t = dist[i]
        w = width * (1 + var * math.sin(fr[0] * t + ph[0]) + var * 0.5 * math.sin(fr[1] * 2.3 * t + ph[1]))
        if taper: w *= 1 - taper * (t / total) ** 2
        off = wobble * (math.sin(fr[2] * t + ph[2]) + 0.6 * math.sin(fr[3] * 2.1 * t + ph[3]))
        nx, ny = -T[i][1], T[i][0]
        cx, cy = p[0] + nx * off, p[1] + ny * off
        L.append((cx + nx * w / 2, cy + ny * w / 2)); R.append((cx - nx * w / 2, cy - ny * w / 2))

    # round caps: three points on a semicircle past each end (from the L side to the R side)
    def cap(p, t, w, sign):
        r = w / 2
        n = (-t[1], t[0])
        return [(p[0] + sign * t[0] * r * math.cos(a) + n[0] * r * math.sin(a) * sign, p[1] + sign * t[1] * r * math.cos(a) + n[1] * r * math.sin(a) * sign)
                for a in (math.radians(55), 0, math.radians(-55))]
    we = math.hypot(L[-1][0] - R[-1][0], L[-1][1] - R[-1][1]); ws = math.hypot(L[0][0] - R[0][0], L[0][1] - R[0][1])
    poly = L + cap(P[-1], T[-1], we, 1) + R[::-1] + cap(P[0], T[0], ws, -1)
    return smooth_path(poly)


def ink(d, color): return f'<path d="{d}" fill="{color}"/>'


def strokes(lst, color): return ink("".join(lst), color)


def arc(cx, cy, rx, ry, a0, a1, n=10):
    return [(cx + rx * math.cos(math.radians(a0 + (a1 - a0) * i / n)), cy + ry * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def poly(pts): return "M" + "L".join(f"{f1(x)} {f1(y)}" for x, y in pts) + "Z"


# ------------------------------------------------------------ lettering
# VARANDA in hand-drawn capitals, cap height 100, built from strokes.
def letter_strokes(ch):
    if ch == "V": return [[(0, 0), (30, 100), (62, 0)]]
    if ch == "A": return [[(0, 100), (32, 0), (64, 100)], [(13, 64), (52, 64)]]
    # R: the bowl is a little wider and taller than the concept's (16, 25, 34, 25 ending at y 50),
    # so its counter stays open at header sizes
    if ch == "R": return [[(0, 100), (0, 0)], [(0, 2)] + arc(18, 27, 36, 26, -90, 90, 8) + [(0, 53)], [(26, 53), (58, 100)]]
    if ch == "N": return [[(0, 100), (0, 0), (60, 100), (60, 0)]]
    if ch == "D": return [[(0, 100), (0, 0)], [(0, 2)] + arc(8, 50, 50, 50, -90, 90, 10) + [(0, 98)]]
    raise ValueError(ch)


WIDTHS = {"V": 62, "A": 64, "R": 58, "N": 60, "D": 60}


def lettering(word, x, y, color, width=13, gap=14, seed=100, wob=1.0, rot=4, bounce=3, size=0.05):
    rnd = random.Random(seed); out = []; cx = x
    for i, ch in enumerate(word):
        ro = math.radians(rnd.uniform(-rot, rot)); dy = rnd.uniform(-bounce, bounce); sc = rnd.uniform(1 - size, 1 + size)
        for j, st in enumerate(letter_strokes(ch)):
            pts = []
            for (px, py) in st:
                px *= sc; py *= sc
                qx = cx + px * math.cos(ro) - (py - 50) * math.sin(ro)
                qy = y + dy + (py - 50) * math.cos(ro) + px * math.sin(ro) + 50
                pts.append((qx, qy))
            out.append(brush(pts, width, seed * 7 + i * 13 + j, wobble=wob, step=16, var=0.14))
        cx += WIDTHS[ch] * sc + gap
    return strokes(out, color), cx - gap - x


# ------------------------------------------------------------ the chair (3D)
# The chair is modelled in 3D (x right, y up, z towards the viewer; units are
# roughly cm) and drawn through a pinhole camera turned ~36 degrees and tilted
# 25 degrees down, so the back, the seat and the crossed legs are visible at
# once, the far side is smaller and thinner, and the straps converge.
def darker(c, k=0.72):
    r, g, b = (int(c[i:i + 2], 16) for i in (1, 3, 5))
    return "#%02x%02x%02x" % (int(r * k), int(g * k), int(b * k))


class Cam:
    def __init__(self, theta, phi, D, scale, cx=0, cy=0):
        self.th = math.radians(theta); self.ph = math.radians(phi); self.D = D; self.f = scale * D; self.cx = cx; self.cy = cy

    def depth(self, p):
        x, y, z = p; x1 = x * math.cos(self.th) + z * math.sin(self.th); z1 = -x * math.sin(self.th) + z * math.cos(self.th)
        y2 = y * math.cos(self.ph) - z1 * math.sin(self.ph); z2 = y * math.sin(self.ph) + z1 * math.cos(self.ph)
        return x1, y2, z2

    def __call__(self, p):
        x1, y2, z2 = self.depth(p); k = self.f / (self.D - z2)
        return (self.cx + x1 * k, self.cy - y2 * k)

    def k(self, p): return self.D / (self.D - self.depth(p)[2])


def add(a, b): return tuple(i + j for i, j in zip(a, b))


def mul(a, k): return tuple(i * k for i in a)


def chair(colors, mono=None, line=INK, c=None):
    """The chair in a 256 x 256 box. mono: one colour, no shadow, gaps between the straps."""
    half = c["width"] / 2; hx = half + 2
    t = math.radians(c["seat_tilt"]); a = math.radians(c["back_lean"])
    v_seat = (0, math.sin(t), math.cos(t)); n_seat = (0, -math.cos(t), math.sin(t))        # along the seat (rear->front), and down
    v_back = (0, math.cos(a), -math.sin(a)); n_back = (0, -math.sin(a), -math.cos(a))      # up the back, and backwards
    R = (0, c["seat_y"], -c["seat_len"] / 2)                                               # hinge (rear centre of the seat)
    F = add(R, mul(v_seat, c["seat_len"])); T = add(R, mul(v_back, c["back_len"]))
    arm_y = F[1] + c["arm_h"]

    def on_back(y):   # point on the back tube at height y (centre line)
        u = (y - R[1]) / (T[1] - R[1]); return add(R, mul(v_back, u * c["back_len"]))
    AB = on_back(arm_y)
    cam = Cam(c["theta"], c["phi"], c["D"], c["scale"])
    keys = []
    for sgn in (-1, 1):
        for p in ((sgn * hx, 0, c["spread"]), (sgn * hx, 0, -c["spread"]), (sgn * hx, T[1], T[2]), (sgn * hx, F[1], F[2]), (sgn * hx, arm_y, F[2] - 4)):
            keys.append(cam(p))
    xs = [q[0] for q in keys]; ys = [q[1] for q in keys]
    cam.cx = 128 - (min(xs) + max(xs)) / 2 + c.get("dx", 0); cam.cy = 128 - (min(ys) + max(ys)) / 2 + c.get("dy", 0)
    near = 1 if cam.depth((hx, 0, 0))[2] > cam.depth((-hx, 0, 0))[2] else -1
    rnd = random.Random(c["seed"]); jit = lambda: rnd.uniform(-0.8, 0.8)

    def panel(origin, v, n, L, sag, start, underside):
        """Straps across a panel, in perspective, bending with the sag."""
        out = ""; pitch = c["pitch"]; k = 0; v0 = 0.0

        def edge(vv, lo, hi, m):
            pts = []
            for i in range(m):
                x = lo + (hi - lo) * i / (m - 1)
                p = add(add(origin, mul(v, vv)), mul(n, sag * (1 - (x / half) ** 2))); p = add(p, (x, 0, 0))
                q = cam(p); pts.append((q[0] + jit(), q[1] + jit()))
            return pts
        while v0 < L - 0.5:
            v1 = min(v0 + pitch, L)
            if mono is None: top = edge(v1 + 0.9, -half, half, 5); bot = edge(v0 - 0.3, half, -half, 5)
            else: top = edge(v1 - pitch * 0.36, -half, half, 5); bot = edge(v0, half, -half, 5)
            col = colors[(start + k) % len(colors)] if mono is None else mono
            out += ink(poly(top + bot), col); k += 1; v0 += pitch
        if underside and mono is None:
            m = 5; e0 = []; e1 = []
            for i in range(m):
                x = -half + 2 * half * i / (m - 1)
                p = add(add(origin, mul(v, L)), mul(n, sag * (1 - (x / half) ** 2))); p = add(p, (x, 0, 0))
                e0.append(cam(p)); e1.append(cam(add(p, underside)))
            out += ink(poly(e0 + e1[::-1]), darker(colors[(start + k - 1) % len(colors)]))
        return out

    def tube(pts3, w, seed, **kw):
        pts = [cam(p) for p in pts3]; kk = sum(cam.k(p) for p in pts3) / len(pts3)
        return brush(pts, w * kk, seed, **kw)

    def side(sgn, seed):
        x = sgn * hx; far = (sgn != near)
        w = c["fw"] * (0.82 if far else 1.0)
        A = [(x, 0, c["spread"]), (x, R[1], R[2]), (x, T[1], T[2])]
        B = [(x, 0, -c["spread"]), (x, F[1], F[2]), (x, arm_y, F[2] - 4), (x, AB[1], AB[2])]
        return [tube(A, w, seed), tube(B, w, seed + 1)]

    out = ""
    if c.get("shadow") and mono is None:
        sh = [cam((math.cos(math.radians(d)) * (half + 14), 0, math.sin(math.radians(d)) * (c["spread"] + 12))) for d in range(0, 360, 30)]
        out += f'<path d="{smooth_path([(q[0] + jit() * 2, q[1] + jit()) for q in sh])}" fill="{line}" fill-opacity="0.13"/>'
    far_side = strokes(side(-near, c["seed"] + 20), line)
    sagb = c["sag_back"]; sags = c["sag_seat"]
    top_rail = [cam(add(add(T, (x, 0, 0)), mul(n_back, sagb * (1 - (x / half) ** 2)))) for x in (-hx, -half / 2, 0, half / 2, hx)]
    front_rail = [cam(add(add(F, (x, 0, 0)), mul(n_seat, sags * (1 - (x / half) ** 2)))) for x in (-hx, -half / 2, 0, half / 2, hx)]
    rails = [brush(top_rail, c["fw"] * 0.95, c["seed"] + 30, wobble=0.6, step=10),
             brush(front_rail, c["fw"] * 0.9, c["seed"] + 31, wobble=0.6, step=10)]
    back_panel = panel(R, v_back, n_back, c["back_len"], sagb, 0, mul(n_back, -3.2))
    seat_panel = panel(R, v_seat, n_seat, c["seat_len"], sags, 2, (0, -3.2, 0))
    near_side = strokes(side(near, c["seed"] + 40), line)
    return out + far_side + back_panel + seat_panel + strokes(rails, line) + near_side


CADEIRA = dict(theta=36, phi=25, D=300, scale=1.55, width=58, seat_y=42, seat_tilt=5, seat_len=50, back_len=62, back_lean=20,
               arm_h=22, spread=26, pitch=8, fw=9.5, sag_seat=2.5, sag_back=2.5, shadow=True, seed=1)
LETTERS = dict(seed=100, width=13, wob=1.0, rot=4, bounce=3, size=0.05)


def cadeira(colors=STRIPES, mono=None, line=INK): return chair(colors, mono, line, CADEIRA)


def varanda(color): return lettering("VARANDA", 0, 0, color, **LETTERS)


# ------------------------------------------------------------ geometry helpers
def bbox(body):
    """Bounding box of every path point in body (quadratic controls bound their curves)."""
    pts = points(body)
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def points(body):
    """Every coordinate pair in body's path data (all absolute M, L and Q points)."""
    out = []
    for d in re.findall(r' d="([^"]*)"', body):
        nums = [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?", d)]
        out += list(zip(nums[0::2], nums[1::2]))
    return out


def place(body, cx, cy, s, ref=None):
    """Scale body by s about the centre of ref's bounding box (default body's) and put that centre on (cx, cy)."""
    x0, y0, x1, y1 = bbox(ref or body)
    tx = cx - s * (x0 + x1) / 2; ty = cy - s * (y0 + y1) / 2
    return f'<g transform="translate({f3(tx)} {f3(ty)}) scale({f3(s)})">{body}</g>'


def fit_square(body, size):
    """The scale that makes body's bounding box size units on its longer side."""
    x0, y0, x1, y1 = bbox(body)
    return size / max(x1 - x0, y1 - y0)


def fit_circle(body, r):
    """The scale that keeps every point of body within r of its bounding-box centre."""
    x0, y0, x1, y1 = bbox(body); mx = (x0 + x1) / 2; my = (y0 + y1) / 2
    return r / max(math.hypot(x - mx, y - my) for x, y in points(body))


# ------------------------------------------------------------ the files
def mark(): return svg("0 0 256 256", f'<rect width="256" height="256" rx="58" fill="{CREAM}"/>' + cadeira())


def mark_mono(color=INK): return svg("0 0 256 256", cadeira(mono=color, line=color))


def chair_only(): return svg("0 0 256 256", cadeira())


def lockup(line):
    """Stacked: the chair above VARANDA, 520 x 470."""
    word, ww = varanda(line)
    LW = 520; chair_s = 1.25
    word_s = 0.84; wx = (LW - ww * word_s) / 2
    body = (f'<g transform="translate({(LW - 256 * chair_s) / 2:.1f} 0) scale({chair_s})">{cadeira(line=line)}</g>'
            f'<g transform="translate({wx:.1f} 352) scale({word_s})">{word}</g>')
    return svg(f"0 0 {LW} 470", body)


def lockup_horizontal(line, ratio=0.62, pad=6, gap=22, bg=None):
    """The chair at the left and VARANDA on one line to its right. The word's
    ink is ratio x the chair's height, and the letters' baseline (y 107 of
    the 100-unit capitals, the middle of the marker at the foot) sits on the
    line of the chair's feet."""
    ch = cadeira(line=line); x0, y0, x1, y1 = bbox(ch)
    word, _ = varanda(line); wx0, wy0, wx1, wy1 = bbox(word)
    ws = ratio * (y1 - y0) / (wy1 - wy0)
    W = math.ceil(2 * pad + (x1 - x0) + gap + (wx1 - wx0) * ws); H = math.ceil(2 * pad + (y1 - y0))
    base = pad + (y1 - y0)
    body = ((f'<rect width="{W}" height="{H}" fill="{bg}"/>' if bg else "") +
            f'<g transform="translate({f3(pad - x0)} {f3(pad - y0)})">{ch}</g>'
            f'<g transform="translate({f3(pad + (x1 - x0) + gap - wx0 * ws)} {f3(base - 107 * ws)}) scale({f3(ws)})">{word}</g>')
    return svg(f"0 0 {W} {H}", body)


def favicon():
    """16 px simplification: a striped panel in a thin ink frame, skewed a
    little so even the favicon leans on the diagonal. Shifted down so the
    raised right-hand corner stays inside the 16 x 16 box."""
    bars = "".join(f'<rect x="3" y="{3 + i * 2.1:.1f}" width="10" height="2.1" fill="{STRIPES[i % 5]}"/>' for i in range(5))
    return svg("0 0 16 16", f'<g transform="translate(0 1) skewY(-7)"><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="{INK}"/>{bars}</g>')


def icon_ios():
    """1024, full-bleed cream (iOS applies its own mask), the chair as in the mark."""
    return svg("0 0 1024 1024", f'<rect width="1024" height="1024" fill="{CREAM}"/><g transform="scale(4)">{cadeira()}</g>')


# Android adaptive icons: a 108-unit canvas whose central circle of diameter 66
# is always visible; the chair stays inside a circle of radius 32 around the centre.
A_SAFE_R = 32


def android_chair(mono=None):
    colour = cadeira()
    body = colour if mono is None else cadeira(mono=mono, line=mono)
    return place(body, 54, 54, fit_circle(colour, A_SAFE_R), ref=colour)


def android_background(): return f'<rect width="108" height="108" fill="{CREAM}"/>'


def icon_android_foreground(): return svg("0 0 108 108", android_chair())


def icon_android_background(): return svg("0 0 108 108", android_background())


def icon_android_monochrome(): return svg("0 0 108 108", android_chair(mono=INK))


def icon_android_legacy(): return svg("0 0 108 108", android_background() + android_chair())


def icon_android_legacy_round():
    return svg("0 0 108 108", '<clipPath id="r"><circle cx="54" cy="54" r="54"/></clipPath>'
               f'<g clip-path="url(#r)">{android_background()}{android_chair()}</g>')


def splash():
    """1024, transparent, the chair centred in the middle 40% (30% margin or more on every side)."""
    ch = cadeira()
    return svg("0 0 1024 1024", place(ch, 512, 512, fit_square(ch, 400)))


def main():
    os.makedirs(OUT, exist_ok=True)
    write("mark.svg", mark())
    write("mark-mono.svg", mark_mono())
    write("chair.svg", chair_only())
    write("lockup.svg", lockup(INK))
    write("lockup-dark.svg", lockup(CREAM))
    write("lockup-horizontal.svg", lockup_horizontal(INK))
    write("favicon.svg", favicon())
    write("icon-ios.svg", icon_ios())
    write("icon-android-foreground.svg", icon_android_foreground())
    write("icon-android-background.svg", icon_android_background())
    write("icon-android-monochrome.svg", icon_android_monochrome())
    write("icon-android-legacy.svg", icon_android_legacy())
    write("icon-android-legacy-round.svg", icon_android_legacy_round())
    write("splash.svg", splash())


if __name__ == "__main__":
    main()
