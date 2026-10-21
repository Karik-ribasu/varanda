'use strict'

const test = require('brittle')
const { buildFeed, shortKey, formatFeedItem, MAX_FUTURE_MS } = require('../lib/feed')
const { testnet } = require('./helpers/net')
const { displayWidth } = require('../lib/safe')
const { feedWidth } = require('../lib/commands/member')

const KA = 'a'.repeat(64)
const KB = 'b'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'
const NOW = Date.parse('2026-06-01T00:00:00.000Z')
const HOUR = 3600 * 1000

function cert (member) {
  return { type: 'member-cert', cert: { v: 1, member, ageBand: '18+', method: 'stub', date: AT, association: 'c'.repeat(64), signature: 'd'.repeat(128) } }
}
const post = (text, at, replyTo = null) => ({ type: 'post', text, at, replyTo })
const profile = (name, at = AT) => ({ type: 'profile', name, bio: '', at })
const iso = (ms) => new Date(ms).toISOString()

test('constants and shortKey', async (t) => {
  await testnet(t)
  t.is(MAX_FUTURE_MS, 86400000)
  t.is(shortKey(KA), 'aaaaaaaa')
})

test('merge two logs ordered by at, author, seq', async (t) => {
  await testnet(t)
  const logs = [
    {
      key: KB,
      entries: [
        { seq: 0, record: cert(KB) },
        { seq: 1, record: post('b1', '2026-01-02T00:00:00.000Z') },
        { seq: 2, record: post('b2', '2026-01-03T00:00:00.000Z') }
      ]
    },
    {
      key: KA,
      entries: [
        { seq: 0, record: cert(KA) },
        { seq: 1, record: post('a1', '2026-01-01T00:00:00.000Z') },
        { seq: 2, record: post('a2', '2026-01-02T00:00:00.000Z') },
        { seq: 3, record: post('a3', '2026-01-02T00:00:00.000Z') }
      ]
    }
  ]
  const { items, future } = buildFeed({ logs, now: NOW })
  t.alike(future, [])
  t.alike(items.map((i) => i.text), ['a1', 'a2', 'a3', 'b1', 'b2'])
  // tie on at: author ascending, then seq ascending
  t.alike(items.slice(1, 4).map((i) => [i.author === KA ? 'A' : 'B', i.seq]), [['A', 2], ['A', 3], ['B', 1]])
})

test('limit keeps the last n', async (t) => {
  await testnet(t)
  const entries = [{ seq: 0, record: cert(KA) }]
  for (let i = 1; i <= 5; i++) entries.push({ seq: i, record: post('p' + i, iso(NOW - (10 - i) * HOUR)) })
  const logs = [{ key: KA, entries }]
  t.alike(buildFeed({ logs, limit: 2, now: NOW }).items.map((i) => i.text), ['p4', 'p5'])
  t.is(buildFeed({ logs, limit: 1, now: NOW }).items.length, 1)
  t.is(buildFeed({ logs, limit: 99, now: NOW }).items.length, 5)
  t.is(buildFeed({ logs, now: NOW }).items.length, 5)
})

test('limit must be Infinity or an integer >= 1', async (t) => {
  await testnet(t)
  const logs = [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('p', AT) }] }]
  for (const limit of [NaN, -1, 1.9, 0, -Infinity, '2', null]) {
    try {
      buildFeed({ logs, limit, now: NOW })
      t.fail('accepted ' + String(limit))
    } catch (err) {
      t.ok(err instanceof TypeError && err.message === 'limit inválido', 'rejects ' + String(limit))
    }
  }
  t.is(buildFeed({ logs, limit: Infinity, now: NOW }).items.length, 1)
})

test('returned items do not alias the input', async (t) => {
  await testnet(t)
  const replyTo = { author: KB, seq: 1 }
  const logs = [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('r', AT, replyTo) }] }]
  const { items } = buildFeed({ logs, now: NOW })
  t.not(items[0].replyTo, replyTo)
  items[0].replyTo.seq = 99
  items[0].replyTo.author = KA
  t.alike(logs[0].entries[1].record.replyTo, { author: KB, seq: 1 })

  // a post whose text turns invalid after it is copied: the feed shows the
  // value that was validated (latestProfile and buildFeed each copy once)
  let reads = 0
  const shifty = { type: 'post', get text () { return reads++ < 2 ? 'ok' : '' }, at: AT, replyTo: null }
  const r = buildFeed({ logs: [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: shifty }] }], now: NOW })
  t.is(r.items.length, 1)
  t.is(r.items[0].text, 'ok')
  t.is(reads, 2)
})

test('reply annotation and name resolution', async (t) => {
  await testnet(t)
  const logs = [
    {
      key: KA,
      entries: [
        { seq: 0, record: cert(KA) },
        { seq: 1, record: profile('Ana') },
        { seq: 2, record: post('oi', '2026-01-01T00:00:00.000Z') },
        { seq: 3, record: profile('Ana Maria') }
      ]
    },
    {
      key: KB,
      entries: [
        { seq: 0, record: cert(KB) },
        { seq: 1, record: post('concordo\nmesmo', '2026-01-02T00:00:00.000Z', { author: KA, seq: 2 }) }
      ]
    }
  ]
  const { items } = buildFeed({ logs, now: NOW })
  t.is(items[0].name, 'Ana Maria')
  t.is(items[1].name, null)
  t.alike(items[1].replyTo, { author: KA, seq: 2 })
  t.is(formatFeedItem(items[0]), '[2026-01-01T00:00:00.000Z] Ana Maria (aaaaaaaa) #2\n  oi')
  // Every line of the text is indented (S5): no line can pass for a header.
  t.is(formatFeedItem(items[1]), '[2026-01-02T00:00:00.000Z] anônimo (bbbbbbbb) #1 ↳ aaaaaaaa#2\n  concordo\n  mesmo')
})

test('formatFeedItem indents every line of a multi-line text', async (t) => {
  await testnet(t)
  const forged = 'primeira\n[2026-01-01T00:00:00.000Z] Falsa (cccccccc) #9\n\núltima'
  const out = formatFeedItem({ author: KA, name: 'Ana', seq: 1, at: AT, text: forged, replyTo: null })
  const lines = out.split('\n')
  t.is(lines[0], '[' + AT + '] Ana (aaaaaaaa) #1')
  t.alike(lines.slice(1), ['  primeira', '  [2026-01-01T00:00:00.000Z] Falsa (cccccccc) #9', '  ', '  última'])
  t.ok(lines.slice(1).every((l) => l.startsWith('  ')), 'no text line starts at column 0')
})

test('formatFeedItem hard-wraps to width and indents every segment (L1)', async (t) => {
  await testnet(t)
  const text = ' '.repeat(70) + '[2026-01-01T00:00:00.000Z] Falsa (cccccccc) #9'
  const out = formatFeedItem({ author: KA, name: 'Ana', seq: 1, at: AT, text, replyTo: null }, { width: 80 })
  const lines = out.split('\n').slice(1)
  t.ok(lines.length >= 2, 'the long line was wrapped')
  t.ok(lines.every((l) => l.startsWith('  ')), 'every segment is indented')
  t.ok(lines.every((l) => Array.from(l).length <= 80), 'no line exceeds the width')
  t.is(lines.map((l) => l.slice(2)).join(''), text, 'nothing is lost')
  t.is(formatFeedItem({ author: KA, name: 'Ana', seq: 1, at: AT, text, replyTo: null }).split('\n')[1], '  ' + text, 'no width, no wrap')
})

test('formatFeedItem measures display columns and wraps the header too (L1)', async (t) => {
  await testnet(t)
  const forged = '[2026-01-01T00:00:00.000Z] Falsa (cccccccc) #9'
  const cases = [
    { name: 'Ana', text: '界'.repeat(49) + forged, width: 100 },
    { name: 'Ana', text: '\u{1B000}'.repeat(49) + forged, width: 100 },
    { name: 'Ana', text: '\u{17000}'.repeat(49) + forged, width: 100 },
    { name: 'N'.repeat(80), text: 'oi', width: 80 },
    { name: 'Ana', text: 'x'.repeat(30) + forged, width: 1 },
    { name: '界'.repeat(40), text: 'oi', width: 80 }
  ]
  for (const c of cases) {
    const out = formatFeedItem({ author: KA, name: c.name, seq: 1, at: AT, text: c.text, replyTo: null }, { width: c.width })
    const rows = out.split('\n')
    const eff = Math.max(20, c.width)
    t.ok(rows.length >= 2, 'header plus text rows (long names are truncated, not wrapped)')
    t.ok(rows.slice(1).every((l) => l.startsWith('  ')), 'every row after the first is indented')
    t.ok(rows.every((l) => displayWidth(l) <= eff), 'no row wider than ' + eff)
    t.ok(rows[0].startsWith('['), 'first row is the header')
  }
})

test('feedWidth: TTY columns, 80 when not a TTY, floor of 20', async (t) => {
  t.is(feedWidth({ isTTY: true, columns: 120 }), 120)
  t.is(feedWidth({ isTTY: false, columns: 120 }), 80)
  t.is(feedWidth({}), 80)
  t.is(feedWidth({ isTTY: true }), 80)
  t.is(feedWidth({ isTTY: true, columns: 5 }), 20)
})

test('header keeps the authenticated suffix on row 1 and truncates the name (L1)', async (t) => {
  await testnet(t)
  const item = (name) => ({ author: KA, name, seq: 7, at: AT, text: 'oi', replyTo: null })
  const real = ' (aaaaaaaa) #7'
  const fake = 'Alice (abcd1234) #5' + ' '.repeat(60)
  const rows = formatFeedItem(item(fake), { width: 80 }).split('\n')
  t.is(rows.length, 2, 'header is a single row plus the text')
  t.ok(rows[0].endsWith('...' + real), 'name truncated, real key8 and seq on row 1')
  t.ok(displayWidth(rows[0]) <= 80)
  t.ok(rows[0].endsWith(real) && rows[0].includes('...'), 'ASCII ellipsis, real suffix kept')
  t.absent(rows[0].includes('\u2026'), 'no ambiguous-width ellipsis')
  t.is(formatFeedItem(item('Ana'), { width: 80 }).split('\n')[0], '[' + AT + '] Ana' + real, 'short name unchanged')
  const wide = formatFeedItem(item('　'.repeat(40)), { width: 80 }).split('\n')
  t.is(wide.length, 2)
  t.ok(wide[0].endsWith('...' + real) && displayWidth(wide[0]) <= 80, 'wide name truncated by display width')
  const narrow = formatFeedItem(item('Ana'), { width: 20 }).split('\n')
  t.ok(narrow[0].startsWith('['), 'narrow: header without name first')
  t.absent(narrow[0].includes('Ana'))
  t.ok(narrow.includes('  Ana'), 'name on its own indented row')
})

test('name room of 1 and 2 columns uses a short ASCII mark and keeps the real suffix (L1)', async (t) => {
  await testnet(t)
  const head = '[' + AT + '] '
  const tail = ' (' + shortKey(KA) + ') #7'
  const fixed = displayWidth(head) + displayWidth(tail)
  const item = { author: KA, name: 'N'.repeat(60), seq: 7, at: AT, text: 'oi', replyTo: null }
  for (const [room, mark] of [[1, '.'], [2, '..'], [3, '...']]) {
    const width = fixed + room
    const rows = formatFeedItem(item, { width }).split('\n')
    t.is(rows.length, 2, 'room ' + room + ': single header row plus the text')
    t.ok(rows[0].endsWith(tail), 'room ' + room + ': row 1 ends with the real key8 and seq')
    t.is(rows[0], head + mark + tail, 'room ' + room + ': mark is ' + JSON.stringify(mark))
    t.ok(displayWidth(rows[0]) <= width, 'room ' + room + ': row 1 fits width ' + width)
  }
})

test('invalid blocks are skipped', async (t) => {
  await testnet(t)
  const logs = [
    {
      key: KA,
      entries: [
        { seq: 0, record: cert(KA) },
        { seq: 1, record: null },
        { seq: 2, record: post('', AT) },
        { seq: 3, record: post('ok', AT) },
        { seq: 4, record: post('data ruim', '2026-13-01T00:00:00.000Z') },
        { seq: 5, record: { type: 'post', text: 'sem replyTo', at: AT } },
        { seq: 6, record: cert(KA) }
      ]
    },
    { key: KB, entries: [{ seq: 0, record: post('sem gênese', AT) }, { seq: 1, record: post('depois', AT) }] }
  ]
  const { items } = buildFeed({ logs, now: NOW })
  t.alike(items.map((i) => i.text), ['ok', 'depois'])
})

test('future-dated posts are excluded and reported', async (t) => {
  await testnet(t)
  const logs = [
    {
      key: KB,
      entries: [
        { seq: 0, record: cert(KB) },
        { seq: 1, record: post('b futuro', iso(NOW + 25 * HOUR)) }
      ]
    },
    {
      key: KA,
      entries: [
        { seq: 0, record: cert(KA) },
        { seq: 1, record: post('a ok', iso(NOW + 23 * HOUR)) },
        { seq: 2, record: post('a futuro 2', iso(NOW + 30 * HOUR)) },
        { seq: 3, record: post('a futuro 1', iso(NOW + 26 * HOUR)) },
        { seq: 4, record: post('a passado', iso(NOW - HOUR)) }
      ]
    }
  ]
  const { items, future } = buildFeed({ logs, now: NOW })
  t.alike(items.map((i) => i.text), ['a passado', 'a ok'])
  t.alike(future, [KA + ':2', KA + ':3', KB + ':1'])

  // exactly at the margin is kept
  const edge = buildFeed({ logs: [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('edge', iso(NOW + MAX_FUTURE_MS)) }] }], now: NOW })
  t.is(edge.items.length, 1)
  t.alike(edge.future, [])

  // limit applies after the exclusion
  const limited = buildFeed({ logs, limit: 1, now: NOW })
  t.alike(limited.items.map((i) => i.text), ['a ok'])
  t.is(limited.future.length, 3)

  // default now is the real clock
  const real = buildFeed({ logs: [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('antigo', AT) }] }] })
  t.is(real.items.length, 1)
})

test('buildFeed does not mutate its input', async (t) => {
  await testnet(t)
  const logs = [{ key: KA, entries: [{ seq: 0, record: cert(KA) }, { seq: 1, record: post('b', '2026-01-02T00:00:00.000Z') }, { seq: 2, record: post('a', AT) }] }]
  const before = JSON.stringify(logs)
  buildFeed({ logs, now: NOW })
  t.is(JSON.stringify(logs), before)
})

test('negative-year posts sort by time, not by string', async (t) => {
  await testnet(t)
  // String order puts -000001 before -000002; time order is the reverse.
  const older = '-000002-01-01T00:00:00.000Z'
  const newer = '-000001-01-01T00:00:00.000Z'
  const logs = [{
    key: KA,
    entries: [
      { seq: 0, record: cert(KA) },
      { seq: 1, record: post('newer', newer) },
      { seq: 2, record: post('older', older) }
    ]
  }]
  const { items } = buildFeed({ logs, now: NOW })
  t.alike(items.map((i) => i.text), ['older', 'newer'])
})
