'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const PUBLIC = path.join(__dirname, '..', 'public')
const WORKFLOW = path.join(__dirname, '..', '..', '..', '.github', 'workflows', 'site.yml')

const read = (...p) => fs.readFileSync(path.join(PUBLIC, ...p), 'utf8')
const size = (...p) => fs.statSync(path.join(PUBLIC, ...p)).size

function walk (dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const html = read('index.html')
const css = read('styles.css')

function attrs (tag) {
  const out = {}
  const re = /([a-zA-Z:_-]+)(?:\s*=\s*"([^"]*)")?/g
  const inner = tag.replace(/^<[a-zA-Z0-9]+/, '').replace(/\/?>$/, '')
  let m
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = m[2] === undefined ? '' : m[2]
  return out
}

function metas () {
  const out = {}
  for (const m of html.matchAll(/<meta\s[^>]*>/g)) {
    const a = attrs(m[0])
    const key = a.property || a.name || a['http-equiv']
    if (key) out[key.toLowerCase()] = a.content
  }
  return out
}

const meta = metas()

test('index.html: language and forbidden elements', (t) => {
  t.ok(/<html[^>]*\slang="pt-BR"/.test(html), 'lang="pt-BR"')
  for (const tag of ['script', 'form', 'iframe', 'object', 'embed', 'base']) {
    t.absent(new RegExp('<' + tag + '[\\s>/]', 'i').test(html), 'no <' + tag + '>')
  }
  t.absent(/\sstyle\s*=/i.test(html), 'no style attribute')
  t.absent(/\son[a-z]+\s*=/i.test(html), 'no inline event handler')
})

test('CSP meta is the declared policy, compared as a set of directives', (t) => {
  const expected = [
    "default-src 'none'",
    "img-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ]
  const csp = meta['content-security-policy']
  t.ok(csp, 'CSP meta present')
  const got = csp.split(';').map((d) => d.trim()).filter(Boolean).sort()
  t.alike(got, expected.slice().sort())
})

test('every img has dimensions and alt text (or is decorative)', (t) => {
  const imgs = [...html.matchAll(/<img\s[^>]*>/g)].map((m) => attrs(m[0]))
  t.ok(imgs.length > 0, 'there are images (' + imgs.length + ')')
  for (const a of imgs) {
    t.ok(a.width && a.height, 'width and height: ' + a.src)
    const decorative = a.alt === '' && a['aria-hidden'] === 'true'
    t.ok(decorative || (a.alt && a.alt.trim() !== ''), 'alt: ' + a.src)
  }
})

function urlsOf (source) {
  const urls = []
  for (const m of source.matchAll(/\s(?:href|src)="([^"]*)"/g)) urls.push(m[1])
  for (const m of source.matchAll(/\ssrcset="([^"]*)"/g)) {
    for (const part of m[1].split(',')) urls.push(part.trim().split(/\s+/)[0])
  }
  return urls
}

const isAbsolute = (u) => /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(u)

test('local URLs resolve under public/, relative, and fragments hit an id', (t) => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
  const urls = urlsOf(html)
  for (const u of urls) {
    if (isAbsolute(u)) continue
    t.absent(u.startsWith('/'), 'not root-relative: ' + u)
    if (u.startsWith('#')) {
      t.ok(ids.has(u.slice(1)), 'id exists for ' + u)
      continue
    }
    const file = path.join(PUBLIC, u.split(/[#?]/)[0])
    t.ok(file.startsWith(PUBLIC + path.sep) && fs.existsSync(file), 'file exists: ' + u)
  }
})

test('styles.css local url() references resolve', (t) => {
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    t.absent(isAbsolute(m[1]) || m[1].startsWith('/'), 'local: ' + m[1])
    t.ok(fs.existsSync(path.join(PUBLIC, m[1])), 'file exists: ' + m[1])
  }
})

test('absolute URLs are https and on the allowlist', (t) => {
  const found = new Set(html.match(/(?:https?:)?\/\/[^\s"'<>]+/g) || [])
  t.ok(found.size > 0, 'absolute URLs found (' + found.size + ')')
  for (const u of found) {
    const url = new URL(u, 'http://invalid.example')
    t.is(url.protocol, 'https:', 'https: ' + u)
    const ok = url.host === 'varanda.app' ||
      (url.host === 'github.com' &&
        (url.pathname === '/Varanda-org/varanda' || url.pathname.startsWith('/Varanda-org/varanda/')))
    t.ok(ok, 'allowed: ' + u)
  }
})

test('Open Graph and Twitter tags', (t) => {
  const image = 'https://varanda.app/assets/og-varanda.jpg'
  t.ok(meta['og:title'], 'og:title')
  t.ok(meta['og:description'], 'og:description')
  t.is(meta['og:url'], 'https://varanda.app/')
  t.is(meta['og:image'], image)
  t.ok(meta['og:image:alt'], 'og:image:alt')
  t.is(meta['og:locale'], 'pt_BR')
  t.is(meta['og:type'], 'website')
  t.is(meta['og:site_name'], 'Varanda')
  t.is(meta['og:image:width'], '1200')
  t.is(meta['og:image:height'], '630')
  t.is(meta['twitter:card'], 'summary_large_image')
  t.is(meta['twitter:image'], meta['og:image'], 'twitter:image equals og:image')
  t.ok(meta['twitter:title'], 'twitter:title')
  t.ok(meta['twitter:description'], 'twitter:description')
  t.is(/<link rel="canonical" href="([^"]+)"/.exec(html)[1], 'https://varanda.app/', 'canonical')
  t.ok(fs.existsSync(path.join(PUBLIC, 'assets', 'og-varanda.jpg')), 'og-varanda.jpg exists in public/assets')
})

test('styles.css: no imports, no remote url(), reduced motion, pause control', (t) => {
  t.absent(/@import/i.test(css), 'no @import')
  t.absent(/url\(\s*["']?[a-z][a-z0-9+.-]*:/i.test(css), 'no url() with a scheme')
  t.absent(/url\(\s*["']?\/\//.test(css), 'no protocol-relative url()')
  t.ok(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/.test(css), 'prefers-reduced-motion: reduce block')
  t.ok(/<input[^>]*type="checkbox"[^>]*id="pausar"|<input[^>]*id="pausar"[^>]*type="checkbox"/.test(html), '#pausar checkbox')
  t.ok(/<label[^>]*for="pausar"/.test(html), 'label for #pausar')
  t.ok(/\.pausar:checked[^{]*\{[^}]*animation-play-state:\s*paused/.test(css), 'checked pauses the animation')
})

test('every SVG under public/ is inert', (t) => {
  const svgs = walk(PUBLIC).filter((f) => f.endsWith('.svg'))
  t.ok(svgs.length > 0, 'svgs found (' + svgs.length + ')')
  for (const f of svgs) {
    const s = fs.readFileSync(f, 'utf8')
    const name = path.relative(PUBLIC, f)
    t.absent(/<script/i.test(s), name + ': no <script')
    t.absent(/<foreignObject/i.test(s), name + ': no <foreignObject')
    t.absent(/\son[a-z]+\s*=/i.test(s), name + ': no on...= attribute')
    for (const m of s.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
      t.ok(m[1].startsWith('#'), name + ': only local href, got ' + m[1])
    }
  }
})

// Budgets (bytes). Measured on 2026-10-22, each set about 25% above:
//   index.html 22256 + styles.css 23381 = 45637  -> 57000
//   all of public/ = 278493 with og-varanda.jpg    -> 348000
// 2026-10-23: the app preview became ~96 KB of WebP screenshots,
//   all of public/ = 350910                        -> 360000
const BUDGET_PAGE = 57000
const BUDGET_TOTAL = 360000
const BUDGET_OG = 200 * 1024

test('size budgets', (t) => {
  const page = size('index.html') + size('styles.css')
  t.ok(page <= BUDGET_PAGE, 'index.html + styles.css ' + page + ' <= ' + BUDGET_PAGE)
  const total = walk(PUBLIC).reduce((n, f) => n + fs.statSync(f).size, 0)
  t.ok(total <= BUDGET_TOTAL, 'public/ total ' + total + ' <= ' + BUDGET_TOTAL)
  const og = path.join(PUBLIC, 'assets', 'og-varanda.jpg')
  if (fs.existsSync(og)) {
    const n = fs.statSync(og).size
    t.ok(n <= BUDGET_OG, 'og-varanda.jpg ' + n + ' <= ' + BUDGET_OG)
  } else {
    t.fail('og-varanda.jpg missing')
  }
})

// WebP pixel size from the file header: lossy (VP8 ), lossless (VP8L) or extended (VP8X).
function webpSize (buf) {
  const kind = buf.toString('latin1', 12, 16)
  if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
  if (kind === 'VP8L') {
    const bits = buf.readUInt32LE(21)
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (kind === 'VP8X') return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 }
  return { w: 0, h: 0 }
}

test('app screenshots: three WebP captures, referenced with their size, within budget', (t) => {
  const names = ['a-rua', 'publicar', 'diario']
  const dir = path.join(PUBLIC, 'assets', 'screens')
  const imgs = [...html.matchAll(/<img\s[^>]*>/g)].map((m) => attrs(m[0]))
  let total = 0
  for (const name of names) {
    const rel = 'assets/screens/' + name + '.webp'
    const file = path.join(PUBLIC, rel)
    t.ok(fs.existsSync(file), rel + ' exists')
    if (!fs.existsSync(file)) continue
    const tag = imgs.find((a) => a.src === rel)
    t.ok(tag && tag.width === '603' && tag.height === '1311', 'index.html references ' + rel + ' with width 603 and height 1311')
    const buf = fs.readFileSync(file)
    t.ok(buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP', rel + ' is a WebP file')
    const px = webpSize(buf)
    t.is(px.w + 'x' + px.h, '603x1311', rel + ' is 603 x 1311 px')
    t.ok(buf.length <= 50000, rel + ' ' + buf.length + ' <= 50000')
    total += buf.length
  }
  t.ok(total <= 100000, 'the three together ' + total + ' <= 100000')
  t.alike(fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [], names.map((n) => n + '.webp').sort(), 'no other file in public/assets/screens/')
})

test('robots.txt exists and there is no CNAME in public/', (t) => {
  t.ok(fs.existsSync(path.join(PUBLIC, 'robots.txt')), 'robots.txt')
  t.absent(fs.existsSync(path.join(PUBLIC, 'CNAME')), 'no CNAME (the domain lives in the Pages settings, docs/site.md)')
})

// site.yml, checked with line and regex rules (no YAML parser available).
const yml = fs.readFileSync(WORKFLOW, 'utf8')
const lines = yml.split('\n').filter((l) => !/^\s*#/.test(l))
const code = lines.join('\n')

function block (startRe, endRe) {
  const start = lines.findIndex((l) => startRe.test(l))
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (endRe.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

test('site.yml: actions pinned to the expected commits', (t) => {
  const pins = {
    'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/upload-pages-artifact': 'fc324d3547104276b827a68afc52ff2a11cc49c9',
    'actions/deploy-pages': '368f82528645a54fb793d4d04e342629a3f51346'
  }
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1])
  t.is(uses.length, 3, 'three uses: lines')
  for (const u of uses) {
    const [name, ref] = u.split('@')
    t.ok(/^[0-9a-f]{40}$/.test(ref), 'pinned to a 40-hex SHA: ' + u)
    t.is(ref, pins[name], 'expected pin for ' + name)
  }
  t.alike(uses.map((u) => u.split('@')[0]).sort(), Object.keys(pins).sort())
})

test('site.yml: permissions, triggers, checkout, path and branch guard', (t) => {
  const top = block(/^permissions:/, /^\S/)
  const topLines = top.split('\n').slice(1).filter((l) => l.trim() !== '').map((l) => l.trim())
  t.alike(topLines, ['contents: read'], 'top-level permissions are contents: read only')
  const deploy = block(/^ {2}deploy:/, /^ {2}\S/)
  const build = block(/^ {2}build:/, /^ {2}\S/)
  t.ok(deploy && build, 'both jobs found')
  const count = (s, re) => (s.match(re) || []).length
  for (const re of [/pages:\s*write/g, /id-token:\s*write/g]) {
    t.is(count(deploy, re), 1, 'in the deploy job: ' + re)
    t.is(count(code, re), count(deploy, re), 'nowhere else: ' + re)
  }
  t.absent(/pull_request/.test(code), 'no pull_request or pull_request_target trigger')
  t.ok(/uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\s*\n\s+persist-credentials:\s*false/.test(code), 'checkout has persist-credentials: false')
  t.ok(/path:\s*apps\/site\/public\s*$/m.test(code), 'upload path is apps/site/public')
  const guard = /^\s+if:\s*github\.ref == 'refs\/heads\/main'\s*$/m
  t.ok(guard.test(build), 'build job is guarded')
  t.ok(guard.test(deploy), 'deploy job is guarded')
})
