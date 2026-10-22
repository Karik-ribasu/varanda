'use strict'
/* global Bare */

// Runs under Bare (node_modules/.bin/bare), spawned by test/bare-load.test.js:
//   bare smoke.js <tmpDir> <assocDir> <peerKey> <bootstrapCsv>
// <tmpDir> holds, planted by the Node side: fifo-key (a FIFO) and
// assoc-local/members.jsonl (a FIFO). <assocDir> is an association created
// on Node whose certificate signs the Node peer <peerKey>, reachable through
// the loopback testnet <bootstrapCsv>. Prints `BARE OK` and exits 0 when
// every step passed; any failure prints `BARE FAIL <step>: <error>` and
// exits 1.
const process = require('bare-process')
const path = require('bare-path')

const [tmp, assocDir, peerKey, bootstrapCsv] = process.argv.slice(2)

// No `performance` shim: the core's rate limits use lib/clock.js, which
// falls back to the process hrtime where `performance` is not defined.
if (typeof globalThis.performance !== 'undefined') console.log('note: this Bare defines performance')

const watchdog = setTimeout(() => {
  console.log('BARE FAIL watchdog: 90 s')
  process.exit(2)
}, 90000)

function assert (cond, what) {
  if (!cond) throw new Error('assertion failed: ' + what)
}

async function throwsCode (fn, code, what) {
  try {
    await fn()
  } catch (err) {
    assert(err.code === code, what + ': expected ' + code + ', got ' + (err.code || err.message))
    return
  }
  throw new Error(what + ': expected ' + code + ', nothing thrown')
}

async function throwsMessage (fn, message, what) {
  try {
    await fn()
  } catch (err) {
    assert(err.message === message, what + ': expected ' + JSON.stringify(message) + ', got ' + JSON.stringify(err.message))
    return
  }
  throw new Error(what + ': expected ' + JSON.stringify(message) + ', nothing thrown')
}

let step = 'start'
function at (name) {
  step = name
  console.log('step ' + name)
}

async function main () {
  at('require')
  const core = require('@varanda/core')
  const { Seeder } = require('@varanda/core/lib/seeder')
  const assoc = require('@varanda/core/lib/assoc')
  const member = require('@varanda/core/lib/member')
  const fs = require('../../lib/bare/fs')
  const { openStore, openDiary, readAll, appendRecord, writeFollows, readFollows } = core.store
  const { memberCertRecord, validRecordCopy } = core.records
  const { certForKey, saveKeyPairFile, loadKeyPairFile } = core.cert
  assert(typeof Seeder === 'function' && typeof member.idCreate === 'function', 'modules loaded')
  console.log('globals structuredClone=' + typeof structuredClone + ' TextEncoder=' + typeof TextEncoder + ' Bare=' + Bare.version)
  assert(fs.constants.O_EXCL > 0 && fs.constants.O_NOFOLLOW > 0 && fs.constants.O_NONBLOCK > 0, 'facade constants')

  at('assoc-fifo')
  // assoc-local/members.jsonl is a FIFO planted by Node: the audit append is
  // refused without hanging, exactly as on Node (ENXIO -> message).
  const localAssoc = path.join(tmp, 'assoc-local')
  const { publicKey: localHex } = assoc.initAssociation(localAssoc)
  assert(/^[0-9a-f]{64}$/.test(localHex), 'initAssociation key')
  assert(fs.lstatSync(path.join(localAssoc, 'members.jsonl')).isFIFO(), 'planted FIFO present')
  await throwsMessage(() => assoc.issueCertificate(localAssoc, { member: 'a'.repeat(64) }), 'registro de auditoria inválido', 'issueCertificate over a FIFO')
  fs.unlinkSync(path.join(localAssoc, 'members.jsonl'))

  at('assoc-issue')
  const localCert = assoc.issueCertificate(localAssoc, { member: 'a'.repeat(64) })
  assert(certForKey(localCert, 'a'.repeat(64), localHex).ok, 'issued cert verifies')
  assert(fs.readFileSync(path.join(localAssoc, 'members.jsonl'), 'utf8').split('\n').length === 2, 'one audit line')
  await throwsCode(() => assoc.initAssociation(localAssoc), 'ALREADY_INITIALIZED', 'initAssociation twice')

  at('store-open')
  const dataDir = path.join(tmp, 'member')
  const storeOptions = { lock: 'worklet' }
  const association = assoc.showAssociation(assocDir).publicKey
  const ctx = { dataDir, association, storeOptions }
  const id = await member.idCreate(ctx)
  assert(id.association === association, 'idCreate config')
  const ownHex = id.publicKey
  const cert = assoc.issueCertificate(assocDir, { member: ownHex })
  let store = await openStore(dataDir, storeOptions)
  let diary = await openDiary(store)
  assert(/^[1-9][0-9]{0,9} [0-9a-f]{32}\n$/.test(fs.readFileSync(path.join(dataDir, '.varanda-lock', 'pid'), 'utf8')), 'lock owner file')
  assert(fs.readFileSync(path.join(dataDir, '.varanda-lock', 'pid'), 'utf8').startsWith(process.pid + ' '), 'lock owner pid')

  at('store-locked')
  await throwsCode(() => openStore(dataDir, storeOptions), 'LOCKED', 'second concurrent openStore')
  await throwsCode(() => openStore(dataDir, { lock: 'worklet', recover: true }), 'LOCKED', 'recover on a lock held by us')

  at('diary-append')
  const seq = await appendRecord(diary, memberCertRecord(cert))
  assert(seq === 0, 'block 0 seq')
  let entries = await readAll(diary)
  assert(entries.length === 1 && entries[0].record.type === 'member-cert', 'read back block 0')
  assert(entries[0].record.cert.signature === cert.signature, 'read back cert')
  const copy = validRecordCopy(entries[0].record, 0)
  assert(copy !== null && copy !== entries[0].record && copy.cert.member === ownHex, 'validRecordCopy')
  assert(validRecordCopy({ type: 'post', text: 'x', at: 'bad', replyTo: null, f () {} }, 1) === null, 'validRecordCopy rejects')

  at('follows')
  writeFollows(dataDir, [peerKey.toUpperCase(), peerKey])
  const follows = readFollows(dataDir)
  assert(follows.length === 1 && follows[0] === peerKey, 'writeFollows/readFollows round trip')
  assert(fs.readFileSync(path.join(dataDir, 'follows.json'), 'utf8') === JSON.stringify({ v: 1, follows: [peerKey] }, null, 2) + '\n', 'follows.json bytes')

  at('close-reopen')
  await store.close()
  assert(!fs.existsSync(path.join(dataDir, '.varanda-lock')), 'lock released')
  store = await openStore(dataDir, storeOptions)
  diary = await openDiary(store)
  entries = await readAll(diary)
  assert(entries.length === 1 && diary.writable, 'reopened diary')
  await store.close()
  const r = await member.certAdd(ctx, cert)
  assert(r.seq === 0, 'certAdd is idempotent (through lib/member with storeOptions)')

  at('recover')
  const lockDir = path.join(dataDir, '.varanda-lock')
  fs.mkdirSync(lockDir, { mode: 0o700 })
  fs.writeFileSync(path.join(lockDir, 'pid'), process.pid + ' ' + 'cd'.repeat(16) + '\n', { mode: 0o600 })
  await throwsCode(() => openStore(dataDir, storeOptions), 'LOCKED', 'planted foreign lock')
  store = await openStore(dataDir, { lock: 'worklet', recover: true })
  const owner = fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')
  assert(owner !== process.pid + ' ' + 'cd'.repeat(16) + '\n' && /^[1-9][0-9]{0,9} [0-9a-f]{32}\n$/.test(owner), 'recovered with a fresh token')
  assert(!fs.existsSync(lockDir + '.takeover'), 'takeover mutex released')
  await store.close()

  at('key-file-wx')
  const keyFile = path.join(tmp, 'keys', 'k.json')
  const kp = core.cert.generateAssociationKeyPair()
  saveKeyPairFile(keyFile, kp)
  assert((fs.statSync(keyFile).mode & 0o777) === 0o600, 'key file mode')
  await throwsCode(() => saveKeyPairFile(keyFile, kp), 'EEXIST', 'saveKeyPairFile over an existing key')
  assert(fs.readdirSync(path.join(tmp, 'keys')).length === 1, 'no temp file left')
  await throwsCode(() => fs.openSync(keyFile, 'wx', 0o600), 'EEXIST', "facade 'wx' on an existing file")
  await throwsCode(() => fs.writeFileSync(keyFile, 'x', { flag: 'wx' }), 'EEXIST', "facade writeFileSync 'wx'")
  const loaded = loadKeyPairFile(keyFile)
  assert(loaded.publicKey.equals ? loaded.publicKey.equals(kp.publicKey) : Buffer.compare(loaded.publicKey, kp.publicKey) === 0, 'loadKeyPairFile')
  const seederKey = Seeder.createKey(path.join(tmp, 'seeder'))
  assert(Seeder.createKey(path.join(tmp, 'seeder')).publicKey === seederKey.publicKey, 'Seeder.createKey idempotent')

  at('nofollow')
  const link = path.join(tmp, 'keys', 'link.json')
  fs.symlinkSync(keyFile, link)
  await throwsCode(() => fs.openSync(link, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK), 'ELOOP', 'O_NOFOLLOW on a symlink')
  await throwsMessage(() => loadKeyPairFile(link), 'arquivo de chave inválido', 'loadKeyPairFile through a symlink')
  fs.closeSync(fs.openSync(link, 'r'))

  at('fifo')
  const fifo = path.join(tmp, 'fifo-key')
  assert(fs.lstatSync(fifo).isFIFO(), 'FIFO planted')
  await throwsMessage(() => loadKeyPairFile(fifo), 'arquivo de chave inválido', 'loadKeyPairFile on a FIFO (no hang)')
  await throwsCode(() => fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600), 'ENXIO', 'write open of a FIFO')

  at('sync')
  const bootstrap = bootstrapCsv.split(',')
  const result = await core.sync.runSync({
    dataDir,
    bootstrap,
    host: '127.0.0.1',
    once: true,
    timeoutMs: 30000,
    storeOptions,
    log: (line) => console.log('sync log: ' + line)
  })
  console.log('SYNC ' + JSON.stringify(result))
  assert(result.peers >= 1, 'a peer connected')
  assert(result.downloaded[peerKey] >= 1, 'the Node peer diary was downloaded')
  assert(!fs.existsSync(path.join(dataDir, '.varanda-lock')), 'lock released after sync')
  assert(!fs.existsSync(path.join(dataDir, 'quarantine')), 'quarantine removed')

  at('replica')
  store = await openStore(dataDir, storeOptions)
  const replica = await core.store.openReplica(store, peerKey)
  const got = await readAll(replica)
  assert(got.length === result.downloaded[peerKey] && got[0].record.type === 'member-cert', 'replica readable after sync')
  await store.close()

  clearTimeout(watchdog)
  console.log('BARE OK')
}

main().then(() => {
  process.exit(0)
}, (err) => {
  console.log('BARE FAIL ' + step + ': ' + (err && err.stack ? err.stack : err))
  process.exit(1)
})
