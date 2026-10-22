const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const HyperDHT = require('hyperdht')
const { testnet, tmpDir } = require('./helpers/net')

test('corestore persists a named core across reopen', async (t) => {
  t.timeout(60000)
  const dir = tmpDir(t)

  const store = new Corestore(dir)
  t.teardown(() => store.close(), { force: true })
  const core = store.get({ name: 'diary', valueEncoding: 'json' })
  await core.ready()
  const key = core.key
  await core.append([{ n: 1 }, { n: 2 }])
  await store.close()

  const store2 = new Corestore(dir)
  t.teardown(() => store2.close(), { force: true })
  const core2 = store2.get({ name: 'diary', valueEncoding: 'json' })
  await core2.ready()
  t.ok(b4a.equals(core2.key, key))
  t.is(core2.length, 2)
  t.alike(await core2.get(1, { wait: false }), { n: 2 })
})

test('testnet bootstrap and HyperDHT node', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  t.ok(bootstrap.length > 0)
  t.ok(bootstrap.every((b) => typeof b === 'string'))

  // Bind loopback only. HyperDHT turns port 0 into its public default
  // (49737), so pass the range [0, 0] to fall through to an ephemeral bind.
  const dht = new HyperDHT({ bootstrap, host: '127.0.0.1', port: [0, 0] })
  t.teardown(() => dht.destroy(), { force: true })
  await dht.ready()
  const addr = dht.io.serverSocket.address()
  t.is(addr.host, '127.0.0.1')
  t.ok(addr.port > 0)
  t.pass('dht ready')
})

test('hypercore protocol API surface', (t) => {
  t.is(typeof Hypercore.getProtocolMuxer, 'function')
  t.is(typeof Hypercore.createProtocolStream, 'function')
  t.is(typeof Hypercore.prototype.purge, 'function')
})
