'use strict'

const test = require('brittle')
const { createClient, createServerDispatcher, MAX_PENDING, MAX_REQUEST } = require('..')

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))
const KEY = 'cd'.repeat(32)

function setup (opts = {}) {
  const sent = []
  const c = createClient({ send: (m, text) => sent.push({ m, text }), ...opts })
  return { c, sent }
}

test('request/response by id', async (t) => {
  const { c, sent } = setup()
  const p = c.request('node.info')
  t.is(sent.length, 1)
  const m = sent[0].m
  t.alike(m, { v: 1, id: m.id, method: 'node.info', params: {} })
  t.is(sent[0].text, JSON.stringify(m))
  t.absent(c.receive({ v: 1, id: m.id + 1, ok: true, result: {} }), 'unknown id ignored')
  t.ok(c.receive({ v: 1, id: m.id, ok: true, result: { publicKey: null } }))
  t.alike(await p, { publicKey: null })
  t.absent(c.receive({ v: 1, id: m.id, ok: true, result: {} }), 'late duplicate ignored')
})

test('error response rejects with the code, uncertain false', async (t) => {
  const { c, sent } = setup()
  const p = c.request('post.create', { text: 'x' })
  c.receive({ v: 1, id: sent[0].m.id, ok: false, error: { code: 'LOCKED', message: 'diretório de dados em uso' } })
  const err = await p.catch((e) => e)
  t.is(err.code, 'LOCKED')
  t.is(err.message, 'diretório de dados em uso')
  t.is(err.uncertain, false)
})

test('local validation: nothing is sent', async (t) => {
  const { c, sent } = setup()
  for (const [method, params] of [
    ['nope', {}],
    ['follow.add', { key: 'x' }],
    ['post.create', {}],
    ['feed.read', { limit: 101 }],
    ['node.info', { dataDir: '/tmp' }],
    ['node.info', []]
  ]) {
    const err = await c.request(method, params).catch((e) => e)
    t.is(err.code, 'USAGE', method)
    t.is(err.uncertain, false)
  }
  t.is(sent.length, 0)
})

test('a certificate at the 4096-byte bound is sent, under MAX_REQUEST', async (t) => {
  const { c, sent } = setup()
  const cert = { pad: 'x'.repeat(4096 - 10) }
  t.is(JSON.stringify(cert).length, 4096)
  c.request('cert.add', { cert }).catch(() => {})
  t.is(sent.length, 1)
  t.ok(sent[0].text.length <= MAX_REQUEST)
  c.close()
})

test('pending cap: excess rejects USAGE without sending', async (t) => {
  const { c, sent } = setup()
  const ps = []
  for (let i = 0; i < MAX_PENDING; i++) ps.push(c.request('node.info').catch(() => {}))
  const err = await c.request('node.info').catch((e) => e)
  t.is(err.code, 'USAGE')
  t.is(sent.length, MAX_PENDING)
  c.receive({ v: 1, id: sent[0].m.id, ok: true, result: {} })
  c.request('node.info').catch(() => {})
  t.is(sent.length, MAX_PENDING + 1, 'a freed slot is usable')
  c.close()
  await Promise.all(ps)
})

test('timeout: TIMEOUT, uncertain for mutating only, never resent', async (t) => {
  const { c, sent } = setup({ timeoutMs: 20 })
  const read = c.request('feed.read').catch((e) => e)
  const write = c.request('post.create', { text: 'x' }).catch((e) => e)
  const r = await read
  const w = await write
  t.is(r.code, 'TIMEOUT')
  t.is(r.uncertain, false)
  t.is(w.code, 'TIMEOUT')
  t.is(w.uncertain, true)
  await flush()
  t.is(sent.length, 2, 'no resend')
  t.is(c.pending, 0)
  t.absent(c.receive({ v: 1, id: sent[1].m.id, ok: true, result: { seq: 1 } }), 'late response ignored')
})

test('close: CLOSED for every pending, uncertain for mutating', async (t) => {
  const { c, sent } = setup()
  const methods = [['sync.start', {}], ['follow.add', { key: KEY }], ['sync.status', {}], ['log.read', {}]]
  const ps = methods.map(([m, p]) => c.request(m, p).catch((e) => e))
  c.close()
  const errs = await Promise.all(ps)
  t.alike(errs.map((e) => [e.code, e.uncertain]), [['CLOSED', true], ['CLOSED', true], ['CLOSED', false], ['CLOSED', false]])
  const after = await c.request('node.info').catch((e) => e)
  t.is(after.code, 'CLOSED')
  t.is(after.uncertain, false, 'never sent')
  t.is(sent.length, 4)
})

test('throwing send: CLOSED with the uncertain rule', async (t) => {
  const c = createClient({ send () { throw new Error('gone') } })
  const e1 = await c.request('identity.create').catch((e) => e)
  const e2 = await c.request('identity.show').catch((e) => e)
  t.is(e1.code, 'CLOSED')
  t.is(e1.uncertain, true)
  t.is(e2.uncertain, false)
  t.is(c.pending, 0)
})

test('events route to listeners; invalid ones ignored', (t) => {
  const { c } = setup()
  const got = []
  const off = c.on('sync.event', (data, env) => got.push([data.line, env.seq]))
  c.on('sync.event', () => { throw new Error('listener bug') })
  t.ok(c.receive({ v: 1, event: 'sync.event', seq: 1, data: { runId: 1, line: 'sync ready' } }))
  t.absent(c.receive({ v: 1, event: 'sync.event', seq: 2, data: { runId: 1 } }))
  off()
  c.receive({ v: 1, event: 'sync.event', seq: 3, data: { runId: 1, line: 'x' } })
  t.alike(got, [['sync ready', 1]])
  t.absent(c.receive('junk'))
  t.absent(c.receive({ v: 1, id: 1, ok: true, result: {}, x: 1 }))
})

test('ids are unique among pending requests', (t) => {
  const { c, sent } = setup()
  for (let i = 0; i < MAX_PENDING; i++) c.request('node.info').catch(() => {})
  const ids = new Set(sent.map((s) => s.m.id))
  t.is(ids.size, MAX_PENDING)
  c.close()
})

test('client <-> dispatcher end to end', async (t) => {
  let client = null
  const server = createServerDispatcher({
    token: 'tok',
    handlers: {
      'follow.add': async ({ key }) => ({ follows: [key], changed: true }),
      'sync.start': async (p) => {
        setTimeout(() => server.emit('sync.event', { runId: 1, line: 'sync ready' }), 1)
        return { runId: 1, once: p.once }
      }
    },
    send: (m) => setTimeout(() => client.receive(JSON.parse(JSON.stringify(m))), 0)
  })
  client = createClient({ send: (m) => setTimeout(() => server.receive(JSON.parse(JSON.stringify(m))), 0) })
  t.alike(await client.request('session.open', { token: 'tok' }), { protocol: 1 })
  t.alike(await client.request('follow.add', { key: KEY }), { follows: [KEY], changed: true })
  const line = new Promise((resolve) => client.on('sync.event', (d) => resolve(d.line)))
  t.alike(await client.request('sync.start', {}), { runId: 1, once: false })
  t.is(await line, 'sync ready')
  const err = await client.request('sync.stop').catch((e) => e)
  t.is(err.code, 'INTERNAL', 'missing handler')
})
