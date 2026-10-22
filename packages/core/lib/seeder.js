// Seeder: an always-on, certificate-gated replicator (docs/protocol.md
// sections 1, 3, 4 and 5). A log is kept only when its block 0 is a valid
// member certificate for the trusted association; until then its block 0 is
// fetched through the quarantine store and never opened in the main store.
const fs = require('#fs')
const path = require('#path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  normalizeHex,
  certForKey,
  loadKeyPairFile,
  saveKeyPairFile,
  seederCertForKey
} = require('./cert')
const {
  topicFor,
  generateNoiseKeyPair,
  createSwarm,
  joinAndFlush,
  startRediscovery,
  attachAdmission,
  refuseOverConnectionLimit,
  watchContiguous,
  watchFork,
  startQuarantineFetch,
  MAX_CONNECTIONS,
  MAX_INVENTORY
} = require('./net')
const {
  openStore,
  openReplica,
  openQuarantine,
  removeQuarantine,
  purgeReplica,
  readConfig,
  writeConfig,
  readJson,
  writeJsonAtomic
} = require('./store')
const { validateRecord, decodeBlock, MAX_LOG_BLOCKS, MAX_LOG_BYTES } = require('./records')
const { UsageError } = require('./errors')

const GATE_TIMEOUT_MS = 15000
const REDISCOVER_MS = 10000
const KEY_FILE = 'seeder-key.json'
const CERT_FILE = 'seeder-cert.json'
const ADMITTED_FILE = 'admitted.json'
// Per-peer announce limits (H3): a token bucket (ANNOUNCE_RATE per second,
// ANNOUNCE_BURST tokens) checked before any signature is verified, and a cap
// on announces whose certificate fails (MAX_BAD_ANNOUNCES).
const ANNOUNCE_RATE = 10
const ANNOUNCE_BURST = 20
const MAX_BAD_ANNOUNCES = 16

const HEX64 = /^[0-9a-f]{64}$/

function noop () {}

function isPlainObject (x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

function key8 (hex) {
  return String(hex).slice(0, 8)
}

// Block-0 verdict on a raw block (identical to lib/sync.js): null when block 0
// is a valid member certificate for keyHex under the trusted association.
function gateVerdict (raw, keyHex, associationHex) {
  try {
    const block0 = decodeBlock(raw)
    if (block0 === null || validateRecord(block0, 0) !== null) return 'not-in-log'
    const r = certForKey(block0.cert, keyHex, associationHex)
    return r.ok ? null : r.reason
  } catch {
    return 'not-in-log'
  }
}

// LOCAL gate: block 0 already in the main store. Any error is 'not-in-log',
// so a failure can never skip the purge.
async function localVerdict (core, keyHex, associationHex) {
  try {
    const raw = await core.get(0, { wait: false, raw: true })
    return gateVerdict(raw, keyHex, associationHex)
  } catch {
    return 'not-in-log'
  }
}

function loadSeederKey (dataDir) {
  try {
    return loadKeyPairFile(path.join(dataDir, KEY_FILE))
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('chave do semeador não encontrada (use seed key)')
    throw err
  }
}

function loadSeederCert (dataDir) {
  let cert
  try {
    cert = readJson(path.join(dataDir, CERT_FILE), null)
  } catch {
    throw new Error('certificado do semeador inválido (malformed)')
  }
  if (cert === null) throw new Error('certificado do semeador não encontrado (use seed cert add)')
  return cert
}

function checkSeederCert (cert, keyPair, associationHex) {
  const r = seederCertForKey(cert, b4a.toString(keyPair.publicKey, 'hex'), associationHex)
  if (!r.ok) throw new Error('certificado do semeador inválido (' + r.reason + ')')
}

class Seeder {
  // purgeHook(core), gateHook(key), admitHook(key, step) ('persist' |
  // 'open', awaited right before that admission step; a throw simulates the
  // step failing) and storeHook() (awaited right after the main store, and
  // its data-dir lock, is acquired) are test-only hooks, as are the injectable limits
  // (maxLogBlocks, maxLogBytes, maxConnections, maxServed, maxAnnounces,
  // announceRate, announceBurst, maxBadAnnounces; defaults = the constants).
  constructor ({
    dataDir,
    associationKey = null,
    bootstrap,
    host,
    log = noop,
    purgeHook = null,
    gateHook = null,
    admitHook = null,
    storeHook = null,
    maxLogBlocks = MAX_LOG_BLOCKS,
    maxLogBytes = MAX_LOG_BYTES,
    maxConnections = MAX_CONNECTIONS,
    maxServed = MAX_INVENTORY,
    maxAnnounces = MAX_INVENTORY,
    announceRate = ANNOUNCE_RATE,
    announceBurst = ANNOUNCE_BURST,
    maxBadAnnounces = MAX_BAD_ANNOUNCES
  } = {}) {
    this.maxServed = maxServed
    this.maxAnnounces = maxAnnounces
    this.announceRate = announceRate
    this.announceBurst = announceBurst
    this.maxBadAnnounces = maxBadAnnounces
    this.dataDir = dataDir
    this.associationKey = associationKey
    this.bootstrap = bootstrap
    this.host = host
    this.log = log
    this.purgeHook = purgeHook
    this.gateHook = gateHook
    this.admitHook = admitHook
    this.storeHook = storeHook
    this.maxLogBlocks = maxLogBlocks
    this.maxLogBytes = maxLogBytes
    this.maxConnections = maxConnections

    this.association = null
    this.topic = null
    this.store = null
    this.qstore = null
    this.swarm = null
    this.fatal = false

    // Source of truth after start(): admitted (served) and dropping (being
    // purged); admitted.json is always the union of both (R6.1).
    this._admitted = new Map()
    this._dropping = new Map()
    this._served = new Map() // key -> { core, download, stopFork, stopGrow, gated, gating, dropped }
    this._chains = new Map() // key -> per-key announce chain (R4.7)
    this._inflight = new Map() // key -> the admission step currently running
    this._reserved = new Set() // keys holding a capacity slot mid-admission (M1)
    this._drops = new Map() // key -> promise of the drop (purge) in progress
    this._writeQueue = Promise.resolve()
    this._peers = new Set()
    this._keyPair = null
    this._cert = null
    this._started = false
    this._closing = null
    this._stopRediscovery = null
    this.closed = new Promise((resolve) => { this._resolveClosed = resolve })
  }

  // Shared by `seed key`, `seed cert add` and `seed`: the first of them fixes
  // the seeder's trust root in config.json.
  static ensureConfig (dataDir, associationKey) {
    let given = null
    if (associationKey !== null && associationKey !== undefined) {
      given = normalizeHex(associationKey)
      if (given === null || given.length !== 64) throw new UsageError('chave da associação inválida')
    }
    const config = readConfig(dataDir)
    if (config !== null) {
      if (!isPlainObject(config) || config.role !== 'seeder') throw new Error('diretório não é de um semeador')
      if (typeof config.association !== 'string' || !HEX64.test(config.association)) {
        throw new Error('diretório não é de um semeador')
      }
      if (given !== null && given !== config.association) throw new Error('associação diferente da configurada')
      return config.association
    }
    if (given === null) throw new UsageError('informe --association ou VARANDA_ASSOCIATION')
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    writeConfig(dataDir, { v: 1, role: 'seeder', association: given })
    return given
  }

  // Idempotent: an existing key file is returned as is (never overwritten).
  static createKey (dataDir) {
    const file = path.join(dataDir, KEY_FILE)
    try {
      return { publicKey: b4a.toString(loadKeyPairFile(file).publicKey, 'hex') }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    const kp = generateNoiseKeyPair()
    try {
      saveKeyPairFile(file, kp)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      return { publicKey: b4a.toString(loadKeyPairFile(file).publicKey, 'hex') }
    }
    return { publicKey: b4a.toString(kp.publicKey, 'hex') }
  }

  static addCert (dataDir, certFile, associationHex) {
    let cert
    try {
      cert = JSON.parse(fs.readFileSync(certFile, 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('arquivo não encontrado: ' + certFile)
      throw new Error('certificado do semeador inválido (malformed)')
    }
    const keyPair = loadSeederKey(dataDir)
    checkSeederCert(cert, keyPair, associationHex)
    writeJsonAtomic(path.join(dataDir, CERT_FILE), cert, 0o600)
    return { seeder: cert.seeder }
  }

  admittedKeys () {
    return [...this._admitted.keys()]
  }

  async start () {
    if (this._started) throw new Error('semeador já iniciado')
    this._started = true

    // Step 1: trust root, Noise key pair and seeder certificate.
    this.association = Seeder.ensureConfig(this.dataDir, this.associationKey)
    this._keyPair = loadSeederKey(this.dataDir)
    this._cert = loadSeederCert(this.dataDir)
    checkSeederCert(this._cert, this._keyPair, this.association)

    // Step 2: the main store (data-dir lock) FIRST, then the state: a
    // previous seeder process may write admitted.json until it releases the
    // lock, so it is read only once the lock is held. The main store opens
    // BEFORE the quarantine is wiped (R6.2).
    this.store = await openStore(this.dataDir)

    try {
      if (this.storeHook) await this.storeHook()
      const data = readJson(path.join(this.dataDir, ADMITTED_FILE), { v: 1, admitted: {} })
      const listed = isPlainObject(data) && isPlainObject(data.admitted) ? data.admitted : {}
      for (const [key, cert] of Object.entries(listed)) {
        if (HEX64.test(key)) this._admitted.set(key, cert)
      }
      this.qstore = await openQuarantine(this.dataDir)

      // Step 3: re-gate every stored replica before anything can serve it.
      const survivors = []
      for (const key of [...this._admitted.keys()]) {
        const core = await openReplica(this.store, key)
        let reason = null
        if (core.fork !== 0) reason = 'fork'
        else if (core.contiguousLength === 0) reason = 'no-cert'
        else if (this._overQuota(core)) reason = 'quota' // item 5: before any serve/join
        else reason = await localVerdict(core, key, this.association)
        if (reason === null && survivors.length < this.maxServed) {
          survivors.push([key, core])
          continue
        }
        // Capacity (M1): a listed log beyond maxServed is purged through the
        // same path, so a restart always comes back under the cap.
        if (reason === null) this.log({ event: 'warning', key, reason: 'seeder-full' })
        else this.log({ event: 'rejected', key, reason })
        try {
          await this._purge(key)
        } catch {
          throw new Error('falha ao limpar diário rejeitado: ' + key8(key))
        }
        this._admitted.delete(key)
        await this._persist()
      }

      // Step 4: watchers and live downloads (no swarm yet).
      for (const [key, core] of survivors) this._serve(key, core, { regate: false })

      // Step 5: the swarm, with the seeder's Noise key pair.
      this.topic = topicFor(this.association)
      this.swarm = createSwarm({ bootstrap: this.bootstrap, keyPair: this._keyPair, host: this.host })
      this.swarm.on('connection', (socket) => this._onConnection(socket))
      const topics = [this.topic, ...survivors.map(([, core]) => core.discoveryKey)]
      const done = this.store.findingPeers()
      try {
        await joinAndFlush(this.swarm, topics)
      } finally {
        done()
      }
      if (this._closing) throw new Error('semeador encerrado')
      this._stopRediscovery = startRediscovery(this.swarm, [this.topic], {
        intervalMs: REDISCOVER_MS,
        hasPeer: () => this.swarm.connections.size > 0
      })
    } catch (err) {
      await this.close()
      throw err
    }

    const topic = b4a.toString(this.topic, 'hex')
    const admitted = this.admittedKeys()
    this.log({ event: 'ready', topic, admitted })
    return { topic, admitted }
  }

  // TODO(phase2): moderation lists — consult a block list before admitting.
  // TODO(phase2): certificate revocation list.
  // (a) The announced certificate is checked synchronously BEFORE anything
  // is queued (review item 1), so a flood of announces never grows memory.
  // The per-peer rate limit runs before the signature check, and a peer
  // whose certificates keep failing is dropped (H3), so a dropped peer
  // costs no further verify.
  admit (key, cert, peer) {
    if (this._closing || peer.seederDropped) return Promise.resolve()
    if (!this._takeAnnounceToken(peer)) {
      this._dropPeer(peer, 'announce-rate')
      return Promise.resolve()
    }
    if (typeof key !== 'string' || !HEX64.test(key)) {
      this._reject(peer, String(key), 'malformed')
      this._badAnnounce(peer)
      return Promise.resolve()
    }
    const r = certForKey(cert, key, this.association)
    if (!r.ok) {
      this._reject(peer, key, r.reason)
      this._badAnnounce(peer)
      return Promise.resolve()
    }
    return this._enqueue(key, cert, peer)
  }

  // Token bucket per peer: announceBurst tokens, refilled at announceRate/s.
  _takeAnnounceToken (peer) {
    const now = performance.now() // monotonic: a wall-clock step must not drain the bucket
    if (!peer.announceBucket) peer.announceBucket = { tokens: this.announceBurst, at: now }
    const b = peer.announceBucket
    b.tokens = Math.min(this.announceBurst, b.tokens + (now - b.at) * this.announceRate / 1000)
    b.at = now
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  _badAnnounce (peer) {
    peer.badAnnounces = (peer.badAnnounces || 0) + 1
    if (peer.badAnnounces >= this.maxBadAnnounces) this._dropPeer(peer, 'bad-announces')
  }

  _dropPeer (peer, reason) {
    if (peer.seederDropped) return
    peer.seederDropped = true
    this.log({ event: 'peer-dropped', peerKey: peer.peerKey, reason })
    peer.socket.destroy()
  }

  async _admitNow (key, cert, peer, onFetch = noop) {
    if (this._closing) return

    // A drop in progress wins over this announce: its purge completes (and
    // the key leaves dropping) before the key is looked at again, and then
    // only through the full quarantine gate.
    while (this._drops.has(key)) await this._drops.get(key)
    if (this._closing) return

    // The admission step itself is tracked so a drop that starts meanwhile
    // waits for it (and only for it, never for queued announces).
    const work = this._admitGated(key, cert, peer, onFetch)
    this._inflight.set(key, work)
    try {
      return await work
    } finally {
      if (this._inflight.get(key) === work) this._inflight.delete(key)
    }
  }

  // Outcomes marked `shared` do not depend on the announcer's socket, so the
  // per-key queue may hand them to waiters (M2): admitted, and a rejection
  // of a certificate found in block 0.
  async _admitGated (key, cert, peer, onFetch) {
    // (b) already admitted: idempotent answer.
    const served = this._served.get(key)
    if (this._admitted.has(key) && served) {
      const length = served.core.contiguousLength
      peer.send({ type: 'admitted', key, length })
      return { type: 'admitted', length, shared: true }
    }
    // Being purged with no drop to wait on: the purge failed and the seeder
    // is closing (fatal); never re-admit over it.
    if (this._dropping.has(key) || this._admitted.has(key)) return
    if (!this._peers.has(peer)) return
    // Inventory cap (review item 4a): a seeder serving MAX_INVENTORY logs
    // could no longer send a valid hello, so it refuses further admissions.
    // The slot is reserved synchronously, before the first await (M1), so
    // concurrent admissions for different keys never overshoot the cap.
    if (this._served.size + this._reserved.size >= this.maxServed) return this._reject(peer, key, 'seeder-full')
    this._reserved.add(key)
    try {
      return await this._admitReserved(key, cert, peer, onFetch)
    } finally {
      this._reserved.delete(key)
    }
  }

  async _admitReserved (key, cert, peer, onFetch) {
    // (c) remote gate through the quarantine store, attached to P and to
    // every other announcer of the key queued meanwhile (onFetch, M2), so
    // any honest announcer can supply block 0.
    let res
    try {
      const fetch = startQuarantineFetch(this.qstore, key, [peer.socket], GATE_TIMEOUT_MS)
      onFetch(fetch)
      try {
        res = await fetch.promise
      } finally {
        onFetch(null)
      }
    } catch {
      if (!this._closing) this._fatal(key)
      return
    }
    if (this.gateHook) await this.gateHook(key)
    if (this._closing) return
    if (res.error) return this._reject(peer, key, 'timeout')
    const verdict = gateVerdict(res.raw, key, this.association)
    if (verdict !== null) {
      const out = this._reject(peer, key, verdict)
      if (verdict !== 'not-in-log') out.shared = true
      return out
    }
    // Log quota (S3): the signed length and byteLength the quarantine core
    // learned with block 0 are checked before anything is opened in the main
    // store (an oversized block 0 itself is 'not-in-log': decodeBlock refuses
    // it).
    if (this._overQuota(res)) return this._reject(peer, key, 'quota')
    // Re-check the cap right before admitting (defence in depth, M1).
    if (this._served.size >= this.maxServed) return this._reject(peer, key, 'seeder-full')

    // (d) admit: persist BEFORE the main store opens the key. A failure after
    // admitted.set (persist throwing, e.g. ENOSPC, or openReplica throwing)
    // rolls the admission back: the key leaves the map, the file is rewritten
    // best-effort and the announcer gets 'admission-failed'; a later announce
    // runs the full gate again. A failure in the open step (S7) may have left
    // the core stored (corestore serves any stored core), so when the storage
    // holds it the replica is purged first; a purge failure is fatal like
    // every other and the key stays listed for the next start to re-gate and
    // purge it. (A core that was never stored is not purged: opening a fresh
    // session only to purge it races with the announcer's replication.)
    this._admitted.set(key, cert)
    let core
    let opening = false
    try {
      if (this.admitHook) await this.admitHook(key, 'persist')
      await this._persist()
      if (this._closing) return
      opening = true
      if (this.admitHook) await this.admitHook(key, 'open')
      core = await openReplica(this.store, key)
    } catch {
      if (opening) {
        try {
          if (await this._stored(key)) await this._purge(key)
        } catch {
          if (!this._closing) this._fatal(key)
          return
        }
      }
      this._admitted.delete(key)
      await this._persist().catch(noop)
      if (this._closing) return
      return this._reject(peer, key, 'admission-failed')
    }
    if (this._closing) return
    this._serve(key, core, { regate: true })
    // A resumed main-store core already over the quota was dropped inside
    // _serve (rejected sent, purge under way): no join, no admitted (item 6).
    const entry = this._served.get(key)
    if (!entry || entry.dropped) return { type: 'rejected', reason: 'quota' }
    this.swarm.join(core.discoveryKey, { server: true, client: true })
    const length = core.contiguousLength
    peer.send({ type: 'admitted', key, length })
    this.log({ event: 'admitted', key, length })
    return { type: 'admitted', length, shared: true }
  }

  _reject (peer, key, reason) {
    peer.send({ type: 'rejected', key, reason })
    this.log({ event: 'rejected', key, reason })
    return { type: 'rejected', reason }
  }

  _overQuota ({ length, byteLength }) {
    return length > this.maxLogBlocks || byteLength > this.maxLogBytes
  }

  _serve (key, core, { regate }) {
    const entry = { core, download: null, stopFork: noop, stopGrow: noop, stopQuota: noop, gated: !regate, gating: false, dropped: false }
    // Log quota on growth (S3): length/byteLength advance on the signed
    // upgrade ('append' fires) before the blocks arrive, so an admitted log
    // that grows past a limit is dropped before it is fetched. Registered
    // BEFORE the growth watcher (listeners run in registration order), and
    // _onGrow checks again, so nothing past the limit is ever advertised.
    const checkQuota = () => {
      if (entry.dropped || this._closing) return
      if (this._overQuota(core)) this._drop(key, 'quota')
    }
    core.on('append', checkQuota)
    entry.stopQuota = () => core.off('append', checkQuota)
    entry.stopFork = watchFork(core, (reason) => this._drop(key, reason))
    entry.download = core.download({ start: 0, end: -1 })
    entry.stopGrow = watchContiguous(core, (length) => this._onGrow(key, entry, length))
    this._served.set(key, entry)
    checkQuota()
    if (entry.dropped) return
    // A replica opened for re-gating may already hold block 0.
    if (regate && core.contiguousLength >= 1) this._onGrow(key, entry, core.contiguousLength)
  }

  _onGrow (key, entry, length) {
    if (entry.dropped || this._closing) return
    if (this._overQuota(entry.core)) return this._drop(key, 'quota')
    if (!entry.gated) {
      // Re-gate on arrival: the main store may have received a different
      // block 0 than the quarantine did.
      if (entry.gating) return
      entry.gating = true
      localVerdict(entry.core, key, this.association).then((reason) => {
        entry.gating = false
        if (entry.dropped || this._closing) return
        if (reason !== null) return this._drop(key, reason)
        entry.gated = true
        this._broadcastHave(key, entry.core.contiguousLength)
      })
      return
    }
    this._broadcastHave(key, length)
  }

  _broadcastHave (key, length) {
    for (const peer of this._peers) peer.send({ type: 'have', key, length })
    this.log({ event: 'have', key, length })
  }

  _stopEntry (entry) {
    entry.stopFork()
    entry.stopGrow()
    entry.stopQuota()
    try {
      if (entry.download) entry.download.destroy()
    } catch {}
  }

  // Runtime drop (R6.1): the key stays persisted (in dropping) until its
  // purge succeeds. The drop wins over announces: it runs right away (after
  // an admission step that is mid-flight for the key, never after queued
  // announces), and every announce for the key waits for it (_admitNow).
  _drop (key, reason) {
    const entry = this._served.get(key)
    if (!entry || entry.dropped || this._closing) return
    entry.dropped = true
    this._served.delete(key)
    const cert = this._admitted.get(key)
    this._admitted.delete(key)
    this._dropping.set(key, cert)
    this._stopEntry(entry)
    if (this.swarm) {
      try {
        this.swarm.leave(entry.core.discoveryKey).catch(noop)
      } catch {}
    }
    for (const peer of this._peers) peer.send({ type: 'rejected', key, reason })
    this.log({ event: 'rejected', key, reason })
    const inflight = this._inflight.get(key) || null
    const drop = (async () => {
      if (inflight) await inflight.catch(noop)
      try {
        await this._purge(key)
      } catch {
        if (!this._closing) this._fatal(key)
        return
      }
      this._dropping.delete(key)
      await this._persist()
    })()
    const tracked = drop.catch(noop).then(() => {
      if (this._drops.get(key) === tracked) this._drops.delete(key)
    })
    this._drops.set(key, tracked)
  }

  _fatal (key) {
    this.fatal = true
    this.log({ event: 'fatal', key, reason: 'purge-failed' })
    this.close().catch(noop)
  }

  // Whether the main store's storage holds a core for key (never opens one).
  _stored (key) {
    return this.store.storage.hasCore(crypto.discoveryKey(b4a.from(key, 'hex')))
  }

  async _purge (key) {
    if (!this.purgeHook) return purgeReplica(this.store, key)
    const core = this.store.get({ key: b4a.from(key, 'hex') })
    await core.ready()
    try {
      await this.purgeHook(core)
    } catch (err) {
      await core.close().catch(noop)
      throw err
    }
  }

  // ONE serialized writer: admitted.json = admitted ∪ dropping.
  _persist () {
    const write = () => {
      const admitted = {}
      for (const [key, cert] of this._admitted) admitted[key] = cert
      for (const [key, cert] of this._dropping) admitted[key] = cert
      writeJsonAtomic(path.join(this.dataDir, ADMITTED_FILE), { v: 1, admitted })
    }
    const next = this._writeQueue.then(write, write)
    this._writeQueue = next.catch(noop)
    return next
  }

  // Bounded per-key announce queue (R4.7, review item 1): one admission
  // RUNS per key and at most ONE more is QUEUED; any further announce for
  // the key only registers its peer (and its own, already verified,
  // certificate) as a waiter of the queued admission (one slot per peer; the
  // queued announcer itself is answered by its own run). Every queued
  // announcer and waiter is also attached to the quarantine fetch in flight
  // for the key (M2), so any honest announcer can supply block 0. A waiter
  // gets the queued admission's outcome only when it is `shared` (admitted,
  // or a block-0 certificate rejection); after an outcome that depended on
  // another announcer's socket (timeout, not-in-log, admission-failed, none)
  // a still-connected waiter runs its own gate, and a queued announcer that
  // left hands its turn to a connected waiter. Outstanding announces
  // (running, queued or waiting) are also bounded per peer: a peer that
  // would hold more than maxAnnounces distinct keys outstanding is dropped
  // ('announce-limit').
  _enqueue (key, cert, peer) {
    let chain = this._chains.get(key)
    if (!chain) {
      chain = { running: null, queued: null, fetch: null }
      this._chains.set(key, chain)
    }
    if (chain.running === null) {
      if (!this._holdAnnounce(peer, key)) {
        if (this._chains.get(key) === chain) this._chains.delete(key)
        return Promise.resolve()
      }
      return this._runItem(chain, key, { cert, peer, waiters: new Map(), settle: noop })
    }
    if (chain.queued === null) {
      if (!this._holdAnnounce(peer, key)) return Promise.resolve()
      let settle
      const done = new Promise((resolve) => { settle = resolve })
      chain.queued = { cert, peer, waiters: new Map(), settle }
      this._attachToFetch(chain, peer)
      return done
    }
    if (chain.queued.peer === peer || chain.queued.waiters.has(peer)) return Promise.resolve()
    if (!this._holdAnnounce(peer, key)) return Promise.resolve()
    chain.queued.waiters.set(peer, cert)
    this._attachToFetch(chain, peer)
    return Promise.resolve()
  }

  _attachToFetch (chain, peer) {
    if (chain.fetch && this._peers.has(peer) && !peer.seederDropped) chain.fetch.addSocket(peer.socket)
  }

  // peer.announced: key -> number of queue slots (running, queued, waiter)
  // the peer holds for that key; its size is the peer's outstanding keys.
  _holdAnnounce (peer, key) {
    if (!peer.announced) peer.announced = new Map()
    const n = peer.announced.get(key) || 0
    if (n === 0 && peer.announced.size >= this.maxAnnounces) {
      this._dropPeer(peer, 'announce-limit')
      return false
    }
    peer.announced.set(key, n + 1)
    return true
  }

  _releaseAnnounce (peer, key) {
    if (!peer.announced) return
    const n = peer.announced.get(key) || 0
    if (n <= 1) peer.announced.delete(key)
    else peer.announced.set(key, n - 1)
  }

  _runItem (chain, key, item) {
    // A queued announcer that left hands its turn to a connected waiter.
    while (!this._peers.has(item.peer) && item.waiters.size > 0 && !this._closing) {
      this._releaseAnnounce(item.peer, key)
      const [w, wcert] = item.waiters.entries().next().value
      item.waiters.delete(w)
      item.peer = w
      item.cert = wcert
    }
    const onFetch = (fetch) => {
      chain.fetch = fetch
      if (!fetch) return
      for (const w of item.waiters.keys()) this._attachToFetch(chain, w)
      if (chain.queued) {
        this._attachToFetch(chain, chain.queued.peer)
        for (const w of chain.queued.waiters.keys()) this._attachToFetch(chain, w)
      }
    }
    const run = this._admitNow(key, item.cert, item.peer, onFetch).then((outcome) => outcome, () => undefined)
    chain.running = run
    const tail = run.then((outcome) => {
      chain.fetch = null
      this._releaseAnnounce(item.peer, key)
      const shared = !!(outcome && outcome.shared)
      const retry = []
      for (const [w, wcert] of item.waiters) {
        if (this._closing || !this._peers.has(w)) {
          this._releaseAnnounce(w, key)
        } else if (shared) {
          this._releaseAnnounce(w, key)
          if (outcome.type === 'admitted') w.send({ type: 'admitted', key, length: outcome.length })
          else w.send({ type: 'rejected', key, reason: outcome.reason })
        } else {
          retry.push([w, wcert])
        }
      }
      item.settle()
      let next = chain.queued
      chain.queued = null
      chain.running = null
      // Waiters that got no shared outcome keep their slot and gate again:
      // as waiters of the queued admission, or one of them runs next.
      for (const [w, wcert] of retry) {
        if (next === null) next = { cert: wcert, peer: w, waiters: new Map(), settle: noop }
        else if (next.peer === w || next.waiters.has(w)) this._releaseAnnounce(w, key)
        else next.waiters.set(w, wcert)
      }
      if (next) this._runItem(chain, key, next)
      else if (this._chains.get(key) === chain) this._chains.delete(key)
    })
    return tail
  }

  _onConnection (socket) {
    socket.on('error', noop)
    if (this._closing) {
      socket.destroy()
      return
    }
    // Connection cap (S1), before the store replicates the socket.
    const onDropped = (ev) => this.log(ev)
    if (refuseOverConnectionLimit(this.swarm, socket, { limit: this.maxConnections, log: onDropped })) return
    this.store.replicate(socket)
    const have = []
    for (const [key, entry] of this._served) {
      // Never more than a valid hello carries (defence in depth, M1).
      if (have.length >= MAX_INVENTORY) break
      have.push({ key, length: entry.gated ? entry.core.contiguousLength : 0 })
    }
    let peer
    try {
      peer = attachAdmission(socket, {
        role: 'seeder',
        cert: this._cert,
        have,
        onmessage: (msg, p) => this._onMessage(msg, p),
        onclose: (p) => this._peers.delete(p),
        log: (ev) => { if (ev && ev.event === 'peer-dropped') onDropped(ev) }
      })
    } catch {
      socket.destroy()
      return
    }
    this._peers.add(peer)
    // hello resolves null when the peer leaves first: never block on it.
    Promise.resolve(peer.hello).then((hello) => {
      if (!hello || this._closing || !this._peers.has(peer)) return
      this.log({ event: 'peer', role: peer.remoteRole, peerKey: peer.peerKey })
    }, noop)
  }

  _onMessage (msg, peer) {
    if (this._closing) return
    if (msg.type === 'announce') this.admit(msg.key, msg.cert, peer).catch(noop)
  }

  close () {
    if (this._closing) return this._closing
    this._closing = (async () => {
      if (this._stopRediscovery) this._stopRediscovery()
      for (const entry of this._served.values()) this._stopEntry(entry)
      this._served.clear()
      if (this.swarm) {
        try { await this.swarm.destroy() } catch {}
      }
      // The quarantine is closed and removed, and every in-flight admission
      // step and drop (purge) has settled, BEFORE the main store closes:
      // store.close releases the data-dir lock, so the next opener of this
      // data dir (which wipes/recreates the quarantine) never has it removed
      // under it.
      if (this.qstore) {
        try { await this.qstore.close() } catch {}
        await Promise.allSettled([...this._inflight.values()])
        removeQuarantine(this.dataDir)
      }
      await Promise.allSettled([...this._drops.values()])
      if (this.store) {
        try { await this.store.close() } catch {}
      }
      this._peers.clear()
      this._resolveClosed()
    })()
    return this._closing
  }
}

Seeder.GATE_TIMEOUT_MS = GATE_TIMEOUT_MS
Seeder.ANNOUNCE_RATE = ANNOUNCE_RATE
Seeder.ANNOUNCE_BURST = ANNOUNCE_BURST
Seeder.MAX_BAD_ANNOUNCES = MAX_BAD_ANNOUNCES

module.exports = { Seeder, GATE_TIMEOUT_MS }
