'use strict'

// The Conectar / Conexão form rules (src/config.js). src/config.js is an ES
// module bundled by Metro; import() loads it here through Node's module
// syntax detection (Node 20.19 and newer).
const test = require('brittle')
const core = require('@varanda/core/lib/config')

const ASSOC = 'ab'.repeat(32)
const load = () => import('../src/config.js')
const publicForm = (dhtHost) => ({ association: ASSOC, bootstrapText: '', publicDht: true, dhtHost })

test('public DHT: a loopback DHT host is refused (issue #10)', async (t) => {
  const { checkForm } = await load()
  for (const host of ['127.0.0.1', ' 127.0.0.1 ', '127.8.9.10', 'localhost', 'LocalHost', '::1', '[::1]']) {
    const r = checkForm(publicForm(host))
    t.is(r.config, undefined, JSON.stringify(host) + ': no config')
    t.is(r.error, 'com a DHT pública, apague o endereço local da DHT: ' + host.trim() + ' só alcança este aparelho')
  }
})

test('public DHT: no host, or a host that is not loopback, is accepted', async (t) => {
  const { checkForm } = await load()
  t.alike(checkForm(publicForm('')).config, { association: ASSOC, bootstrap: null, dhtHost: null, allowPublicDht: true })
  t.alike(checkForm(publicForm('   ')).config, { association: ASSOC, bootstrap: null, dhtHost: null, allowPublicDht: true })
  for (const host of ['0.0.0.0', '192.168.1.5', '10.0.0.2', '128.0.0.1']) {
    t.is(checkForm(publicForm(host)).config.dhtHost, host, host)
  }
  // The bootstrap text is ignored by the screen when the switch is on, and
  // still refused here when both are given.
  t.is(checkForm({ ...publicForm(''), bootstrapText: '127.0.0.1:49737' }).error, 'bootstrap e DHT pública são exclusivos')
})

test('private bootstrap: a loopback DHT host is still accepted', async (t) => {
  const { checkForm } = await load()
  t.alike(checkForm({ association: ASSOC, bootstrapText: '127.0.0.1:49737', publicDht: false, dhtHost: '127.0.0.1' }).config, {
    association: ASSOC,
    bootstrap: ['127.0.0.1:49737'],
    dhtHost: '127.0.0.1',
    allowPublicDht: false
  })
})

test('revive: a loopback host saved with the public DHT is dropped, the rest kept', async (t) => {
  const { revive } = await load()
  t.alike(revive({ association: ASSOC, bootstrap: null, dhtHost: '127.0.0.1', allowPublicDht: true }), {
    association: ASSOC,
    bootstrap: null,
    dhtHost: null,
    allowPublicDht: true
  })
  t.is(revive({ association: ASSOC, bootstrap: null, dhtHost: '192.168.1.5', allowPublicDht: true }).dhtHost, '192.168.1.5')
  t.is(revive({ association: ASSOC, bootstrap: ['127.0.0.1:49737'], dhtHost: '127.0.0.1', allowPublicDht: false }).dhtHost, '127.0.0.1')
})

test('isLoopbackAddress matches packages/core', async (t) => {
  const { isLoopbackAddress } = await load()
  const cases = ['127.0.0.1', '127.255.255.255', '127.0.0.256', '127.1', 'localhost', 'LOCALHOST', 'localhost.example', '::1', '[::1]', '::2', '0.0.0.0', '128.0.0.1', '10.0.0.1', '']
  for (const host of cases) t.is(isLoopbackAddress(host), core.isLoopbackAddress(host), JSON.stringify(host))
  t.ok(isLoopbackAddress('127.0.0.1'))
  t.absent(isLoopbackAddress('127.0.0.256'))
})
