// End-to-end phase 0 flow, all in-process (no child processes, no public DHT):
// association -> members A and B -> seeder (key, certificate, start) ->
// A publishes and goes offline -> B receives A's post through the seeder ->
// B replies, A reads the reply -> rejections and third-peer isolation ->
// withdrawal between trust roots -> seeder restart from disk -> a fork
// un-admits the author everywhere.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const Corestore = require('corestore')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { runSync } = require('@varanda/core/lib/sync')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSwarm, joinAndFlush, topicFor, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, profileRecord, postRecord } = require('@varanda/core/lib/records')
const { buildFeed } = require('@varanda/core/lib/feed')
const {
  openStore,
  openDiary,
  openReplica,
  readAll,
  appendRecord,
  writeConfig,
  writeFollows
} = require('@varanda/core/lib/store')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function post (text) {
  return { type: 'post', text, at: new Date().toISOString(), replyTo: null }
}

function readAdmitted (dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'admitted.json'), 'utf8')).admitted
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
}

// The seeder setup of the CLI, in-process: seed key, assoc certify-seeder,
// seed cert add (Seeder.ensureConfig fixes the trust root on the first one).
function prepareSeederDir (t, kp) {
  const dataDir = tmpDir(t, 'varanda-e2e-seed-')
  const association = hex(kp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-e2e-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, kp), null, 2) + '\n')
  Seeder.addCert(dataDir, certFile, association)
  return { dataDir, publicKey }
}

async function startSeeder (t, bootstrap, dataDir, opts = {}) {
  const events = []
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: (e) => events.push(e), ...opts })
  t.teardown(() => seeder.close(), { force: true })
  const ready = await seeder.start()
  return { seeder, events, ready }
}

// A member data dir: config.json (trust root = trustKp), block 0 = member
// certificate signed by certKp, then `records`. The store is closed on return.
async function makeMember (t, kp, records = [], { certKp = kp } = {}) {
  const dir = tmpDir(t, 'varanda-e2e-member-')
  writeConfig(dir, { v: 1, role: 'member', association: hex(kp.publicKey) })
  const store = await openStore(dir)
  try {
    const diary = await openDiary(store)
    const key = hex(diary.key)
    await appendRecord(diary, memberCertRecord(createCert({ member: key }, certKp)))
    for (const r of records) await appendRecord(diary, r)
    return { dir, key, length: diary.length }
  } finally {
    await store.close()
  }
}

// Opens a member store, runs fn({ store, diary }) and always closes it.
async function withMember (dir, fn) {
  const store = await openStore(dir)
  try {
    const diary = await openDiary(store)
    return await fn({ store, diary })
  } finally {
    await store.close()
  }
}

async function replicaEntries (dir, key) {
  return withMember(dir, async ({ store }) => readAll(await openReplica(store, key)))
}

async function feedOf (dir, follows) {
  return withMember(dir, async ({ store, diary }) => {
    const logs = [{ key: hex(diary.key), entries: await readAll(diary) }]
    for (const key of follows) logs.push({ key, entries: await readAll(await openReplica(store, key)) })
    return buildFeed({ logs }).items
  })
}

// One --once sync of a member; the resolved result carries its events.
async function sync (bootstrap, dir) {
  const events = []
  const result = await runSync({ ...localSwarmOptions(bootstrap), dataDir: dir, once: true, timeoutMs: 30000, onEvent: (e) => events.push(e) })
  return { ...result, events }
}

// A raw member client (no lib/sync.js): its own writable core with `blocks`,
// or a read-only core for `follow`; an admission channel per connection.
async function rawClient (t, bootstrap, association, { blocks = null, follow = null, joinPeer = null } = {}) {
  const store = new Corestore(tmpDir(t, 'varanda-e2e-raw-'))
  await store.ready()
  let core = null
  let key = null
  if (blocks) {
    core = store.get({ name: 'diary', valueEncoding: 'json' })
    await core.ready()
    key = hex(core.key)
    for (const b of blocks(key)) await core.append(b)
  } else if (follow) {
    core = store.get({ key: b4a.from(follow, 'hex') })
    await core.ready()
  }
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  t.teardown(() => store.close(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    store.replicate(socket)
    const have = key ? [{ key, length: core.length }] : []
    peers.push(attachAdmission(socket, { role: 'member', have, onmessage: (msg) => messages.push(msg) }))
  })
  if (joinPeer) swarm.joinPeer(b4a.from(joinPeer, 'hex'))
  else await joinAndFlush(swarm, [topicFor(association)])
  const seederPeer = () => until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  const message = (pred, name) => until(() => messages.find(pred), { name, timeoutMs: 20000 })
  const close = async () => {
    await swarm.destroy()
    await store.close()
  }
  return { store, swarm, core, key, messages, seederPeer, message, close }
}

function nothingWithin (core, ms) {
  return core.get(0, { timeout: ms }).then(() => false, () => true)
}

test('e2e: publish offline through the seeder, reply, rejections, withdrawal, restart', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const PUB = hex(kp.publicKey)
  const other = generateAssociationKeyPair()

  // Seeder: key, certificate issued by the association, start.
  const { dataDir: seedDir, publicKey: seederKey } = prepareSeederDir(t, kp)
  const first = await startSeeder(t, bootstrap, seedDir, { associationKey: PUB })
  t.alike(first.ready.admitted, [], 'fresh seeder admits nothing yet')

  // A: certificate, profile and a post; syncs once and goes offline.
  const A = await makeMember(t, kp, [profileRecord({ name: 'Ana' }), postRecord({ text: 'Olá, B!' })])
  t.is(A.length, 3)
  const ra = await sync(bootstrap, A.dir)
  t.ok(ra.ok, 'A sync ok ' + JSON.stringify(ra.errors))
  t.is(ra.admitted, true, 'A admitted by the seeder')
  t.is(ra.seeders, 1)
  t.ok(ra.events.some((e) => e.event === 'peer' && e.role === 'seeder' && e.verified === true))
  t.alike(first.seeder.admittedKeys(), [A.key])
  t.ok(first.events.some((e) => e.event === 'have' && e.key === A.key && e.length === 3), 'seeder holds all of A')

  // B follows A while A is offline: the post arrives through the seeder.
  const B = await makeMember(t, kp)
  writeFollows(B.dir, [A.key])
  const rb = await sync(bootstrap, B.dir)
  t.ok(rb.ok, 'B sync ok ' + JSON.stringify(rb.errors))
  t.is(rb.downloaded[A.key], 3, 'B downloaded A through the seeder')
  t.alike(rb.skipped, [])
  t.is(rb.peers, 1, 'only the seeder was online')
  const entriesA = await replicaEntries(B.dir, A.key)
  t.is(entriesA.length, 3)
  const feedB = await feedOf(B.dir, [A.key])
  const postA = feedB.find((i) => i.author === A.key && i.seq === 2)
  t.ok(postA, 'A post in B feed')
  t.is(postA.text, 'Olá, B!')
  t.is(postA.name, 'Ana')

  // B replies; A comes back, follows B and reads the reply.
  await withMember(B.dir, ({ diary }) => appendRecord(diary, postRecord({ text: 'Oi, Ana!', replyTo: { author: A.key, seq: 2 } })))
  const rb2 = await sync(bootstrap, B.dir)
  t.ok(rb2.ok, 'B second sync ok ' + JSON.stringify(rb2.errors))
  t.is(rb2.admitted, true)
  writeFollows(A.dir, [B.key])
  const ra2 = await sync(bootstrap, A.dir)
  t.ok(ra2.ok, 'A second sync ok ' + JSON.stringify(ra2.errors))
  t.is(ra2.downloaded[B.key], 2)
  const feedA = await feedOf(A.dir, [B.key])
  const reply = feedA.find((i) => i.author === B.key)
  t.ok(reply, 'reply in A feed')
  t.is(reply.text, 'Oi, Ana!')
  t.alike(reply.replyTo, { author: A.key, seq: 2 })
  t.ok(feedA.findIndex((i) => i.author === A.key && i.seq === 2) < feedA.indexOf(reply), 'post sorts before its reply')

  // Rejection: block 0 is a post, announced with a valid certificate.
  const poser = await rawClient(t, bootstrap, PUB, { blocks: () => [post('não sou certificado'), post('x')] })
  const poserPeer = await poser.seederPeer()
  poserPeer.send({ type: 'announce', key: poser.key, cert: createCert({ member: poser.key }, kp) })
  const rejected = await poser.message((m) => m.type === 'rejected' && m.key === poser.key, 'rejected poser')
  t.is(rejected.reason, 'not-in-log')
  t.absent(first.seeder.admittedKeys().includes(poser.key))
  t.absent(poser.key in readAdmitted(seedDir))

  // Third-peer isolation: nothing of the rejected log is served by the seeder.
  const third = await rawClient(t, bootstrap, PUB, { follow: poser.key, joinPeer: seederKey })
  await third.seederPeer()
  t.ok(await nothingWithin(third.core, 1500), 'rejected log is not readable from the seeder')
  // ...while an admitted one is.
  const readerA = await rawClient(t, bootstrap, PUB, { follow: A.key, joinPeer: seederKey })
  await readerA.seederPeer()
  t.ok(await readerA.core.get(0, { timeout: 10000 }), 'admitted log is readable from the seeder')
  await third.close()
  await readerA.close()

  // Rejection: certificate signed by another association.
  poserPeer.send({ type: 'announce', key: poser.key, cert: createCert({ member: poser.key }, other) })
  await poser.message((m) => m.type === 'rejected' && m.key === poser.key && m.reason === 'untrusted-association', 'rejected untrusted')
  t.alike(first.seeder.admittedKeys().sort(), [A.key, B.key].sort())
  await poser.close()

  // Seeder offline; withdrawal: C trusts another association and follows A.
  await first.seeder.close()
  const C = await makeMember(t, other)
  writeFollows(C.dir, [A.key])
  const pa3 = sync(bootstrap, A.dir)
  const pc = sync(bootstrap, C.dir)
  const started = Date.now()
  const [ra3, rc] = await Promise.all([pa3, pc])
  t.ok(ra3.ok, 'A sync ok without seeder ' + JSON.stringify(ra3.errors))
  t.ok(Date.now() - started < 25000, 'A was released before its timeout')
  t.is(ra3.admitted, false)
  t.ok(ra3.events.some((e) => e.event === 'withdrawn' && e.key === A.key && e.reason === 'untrusted-association'), 'A saw the withdrawal')
  t.ok(rc.ok, 'C sync ok ' + JSON.stringify(rc.errors))
  t.alike(rc.skipped, [{ key: A.key, reason: 'untrusted-association' }])
  t.absent(A.key in rc.downloaded)
  t.ok(rc.events.some((e) => e.event === 'skipped' && e.key === A.key))
  t.is((await replicaEntries(C.dir, A.key)).length, 0, 'nothing of A stored by C')

  // Restart from disk without --association: A and B survive, nothing dropped.
  const second = await startSeeder(t, bootstrap, seedDir)
  t.alike(second.ready.admitted.slice().sort(), [A.key, B.key].sort())
  t.absent(second.events.some((e) => e.event === 'rejected'), 'restart drops nothing valid')
  const reader = await rawClient(t, bootstrap, PUB, { follow: A.key, joinPeer: seederKey })
  await reader.core.download({ start: 0, end: 3 }).done()
  t.is(reader.core.contiguousLength, 3, 'A served from the restarted seeder')
  await reader.close()
  await second.seeder.close()
})

test('e2e: a fork un-admits the author at the seeder and at its followers', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const PUB = hex(kp.publicKey)
  const { dataDir: seedDir } = prepareSeederDir(t, kp)
  const { seeder, events } = await startSeeder(t, bootstrap, seedDir, { associationKey: PUB })

  const A = await makeMember(t, kp, [postRecord({ text: 'um' }), postRecord({ text: 'dois' })])
  const ra = await sync(bootstrap, A.dir)
  t.ok(ra.ok, 'A sync ok ' + JSON.stringify(ra.errors))
  t.is(ra.admitted, true)
  const B = await makeMember(t, kp)
  writeFollows(B.dir, [A.key])
  const rb = await sync(bootstrap, B.dir)
  t.ok(rb.ok, 'B sync ok ' + JSON.stringify(rb.errors))
  t.is(rb.downloaded[A.key], 3)

  // B stays online; A rewrites its history and comes back.
  const controllerB = new AbortController()
  t.teardown(() => controllerB.abort(), { force: true })
  const evB = []
  const pb = runSync({ ...localSwarmOptions(bootstrap), dataDir: B.dir, signal: controllerB.signal, onEvent: (e) => evB.push(e) })
  await until(() => evB.some((e) => e.event === 'ready'), { name: 'B ready' })

  await withMember(A.dir, async ({ diary }) => {
    await diary.truncate(1)
    await appendRecord(diary, postRecord({ text: 'reescrito' }))
    t.not(diary.fork, 0, 'A diary is forked')
  })
  const controllerA = new AbortController()
  t.teardown(() => controllerA.abort(), { force: true })
  const evA = []
  const pa = runSync({ ...localSwarmOptions(bootstrap), dataDir: A.dir, signal: controllerA.signal, onEvent: (e) => evA.push(e) })

  await until(() => events.some((e) => e.event === 'rejected' && e.key === A.key && e.reason === 'fork'), { timeoutMs: 30000, name: 'seeder rejected fork' })
  await until(() => !(A.key in readAdmitted(seedDir)), { timeoutMs: 30000, name: 'admitted.json without A' })
  t.absent(seeder.admittedKeys().includes(A.key), 'seeder un-admitted A')
  await until(() => evB.some((e) => e.event === 'skipped' && e.key === A.key && e.reason === 'fork'), { timeoutMs: 30000, name: 'B skipped fork' })
  await until(() => evA.some((e) => e.event === 'rejected' && e.key === A.key && e.reason === 'fork'), { timeoutMs: 30000, name: 'A rejected by the seeder' })

  const ra2 = await pa
  t.is(ra2.ok, false)
  t.is(ra2.rejected, 'fork')
  t.alike(ra2.errors, ['rejeitado: fork'])
  controllerB.abort()
  const rb2 = await pb
  t.ok(rb2.ok)
  t.alike(rb2.skipped, [{ key: A.key, reason: 'fork' }])
  t.absent(A.key in rb2.downloaded)
  t.is((await replicaEntries(B.dir, A.key)).length, 0, 'B purged the forked replica')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
  await seeder.close()
})
