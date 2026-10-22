// Member sync (docs §6): gates every followed log on its block 0, replicates
// the own diary and the accepted replicas with peers and seeders, and in
// --once mode resolves when the goals G1/G2/G3 hold.
// TODO(phase1): push notifications when a followed log grows.
//
// Follow entry states:
//   pending  nothing stored; advertised with length 0; the remote (quarantine)
//            gate runs when a peer advertises the key with length >= 1
//   regate   remote gate passed and the replica is open in the main store, but
//            block 0 has not yet arrived there and passed the LOCAL gate; still
//            advertised with length 0, absent from downloaded, G1 unmet
//   active   local gate passed; live download, advertised with contiguousLength
//   failing  gate failed or fork: its close + purge is in flight (completion
//            is blocked until the purge settles)
//   failed   skipped; excluded from every goal
const process = require('#process')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const {
  openStore,
  openDiary,
  openReplica,
  openQuarantine,
  removeQuarantine,
  purgeReplica,
  readConfig,
  readFollows
} = require('./store')
const { genesisCert, decodeBlock, validateRecord, MAX_LOG_BLOCKS, MAX_LOG_BYTES } = require('./records')
const { certForKey, seederCertForKey } = require('./cert')
const {
  createSwarm,
  topicFor,
  joinAndFlush,
  startRediscovery,
  attachAdmission,
  refuseOverConnectionLimit,
  watchContiguous,
  watchFork,
  startQuarantineFetch,
  MAX_CONNECTIONS,
  MAX_INVENTORY,
  MESSAGE_BURST,
  MESSAGE_RATE
} = require('./net')

const GATE_TIMEOUT_MS = 15000
const GATE_MIN_TIMEOUT_MS = 250
const GATE_RETRY_MS = 15000
const GRACE_MS = 5000
const REDISCOVER_ONCE_MS = 1000
const REDISCOVER_LONG_MS = 10000
// Security audit S2 / H1: ONE run-level budget for unverified peers (anyone
// who is not a verified seeder). It starts at the first hello of such a peer
// in --once mode; once it expires, their length claims (G1), their interest
// in our diary (G3) and their incomplete inventories no longer affect the
// goals for the rest of the run, whatever their identity, number or progress.
const UNVERIFIED_BUDGET_MS = 5000

const HEX64 = /^[0-9a-f]{64}$/

function noop () {}

function key8 (hex) {
  return String(hex).slice(0, 8)
}

// Block-0 verdict (docs §5, identical in the seeder): null = accepted.
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

async function localGate (core, keyHex, associationHex) {
  try {
    const raw = await core.get(0, { wait: false, raw: true })
    return gateVerdict(raw, keyHex, associationHex)
  } catch {
    return 'not-in-log'
  }
}

// purgeHook(key, store) replaces purgeReplica for every purge of this run,
// regateHook(key) returns a verdict (string) that overrides the local re-gate
// of a replica opened after a remote pass (null/undefined = run the real
// gate) and joinHook(swarm, topics) replaces joinAndFlush. All three are
// test-only hooks, as are inspectHook (called once with { claimCount(),
// topicHasPeer(topic), lastClosedPeer() }: the number of G1 claims held
// across every follow entry, the re-discovery predicate and the peer object
// of the last closed admission channel) and the injectable limits
// (unverifiedBudgetMs, maxLogBlocks, maxLogBytes, maxConnections,
// maxFetchSockets (the open sockets per gate fetch, default maxConnections),
// gateTimeoutMs, messageBurst, messageRate), whose defaults are the protocol
// constants.
async function runSync ({
  dataDir,
  associationKey = null,
  bootstrap,
  host,
  once = false,
  timeoutMs = 30000,
  log = noop,
  onEvent = noop,
  signal,
  purgeHook = null,
  regateHook = null,
  joinHook = null,
  unverifiedBudgetMs = UNVERIFIED_BUDGET_MS,
  maxLogBlocks = MAX_LOG_BLOCKS,
  maxLogBytes = MAX_LOG_BYTES,
  maxConnections = MAX_CONNECTIONS,
  maxFetchSockets = maxConnections,
  maxFollows = MAX_INVENTORY - 1,
  gateTimeoutMs = GATE_TIMEOUT_MS,
  messageBurst = MESSAGE_BURST,
  messageRate = MESSAGE_RATE,
  openHook = null,
  inspectHook = null,
  // Forwarded as is to openStore and openQuarantine (lib/store.js: lock
  // mode, recover, suspend); undefined = their defaults.
  storeOptions
} = {}) {
  // The trust root is checked before anything touches the data dir.
  const config = readConfig(dataDir)
  if (!config || config.role !== 'member') throw new Error('identidade não encontrada')
  if (associationKey && associationKey.toLowerCase() !== config.association) {
    throw new Error('associação diferente da configurada')
  }
  const association = config.association
  const started = Date.now()
  const deadline = started + timeoutMs

  let store = null
  let qstore = null
  let swarm = null
  let diary = null
  let ownHex = null
  let cert = null
  let stopDiaryWatch = null
  let stopRediscovery = null
  let graceTimer = null
  let deadlineTimer = null
  let graceDone = false
  let ending = false // finish() started: no new work, waiting for purges/gates
  let ended = false // result built
  let deadlineHit = false
  let fatal = null
  let result = null
  let settle
  const finished = new Promise((resolve) => { settle = resolve })
  const timers = new Set()
  const inflight = new Set() // quarantine fetches
  const settling = new Set() // purges and local re-gates finish() waits for
  const peers = new Set()
  let lastClosedPeer = null // test-only (inspectHook)
  const follows = new Map() // key -> entry
  const topicKeys = new Map() // topic hex -> key hex (own diary and follows)
  const skipped = []
  const errorsSoft = []
  const hardErrors = [] // make the result ok: false without ending the run
  let rendezvousHex = null
  let liveConnections = 0 // open sockets (counted on connect, decremented on close)
  const topicConnections = new Map() // topic hex -> Set of open sockets discovered on it
  let admittedEver = false
  let rejectedReason = null
  let budgetStarted = false // the unverified-peer budget (H1) is running or over
  let budgetExpired = false
  let confirmedLength = -1 // diary.length when G2 last held with a verified seeder
  const signalHandlers = []

  const emit = (ev) => {
    try {
      onEvent(ev)
    } catch {}
  }
  const softError = (msg) => {
    if (!errorsSoft.includes(msg)) errorsSoft.push(msg)
  }
  const hardError = (msg) => {
    if (!hardErrors.includes(msg)) hardErrors.push(msg)
  }

  function purgeKey (key) {
    return purgeHook ? purgeHook(key, store) : purgeReplica(store, key)
  }

  // Registers a promise finish() must wait for; the callbacks run on settle.
  function track (p, onOk, onErr) {
    const wrapped = p.then(onOk, onErr).catch(noop)
    settling.add(wrapped)
    wrapped.finally(() => settling.delete(wrapped)).catch(noop)
    return wrapped
  }

  function inventory () {
    const have = [{ key: ownHex, length: diary.length }]
    for (const e of follows.values()) {
      if (e.state === 'active') have.push({ key: e.key, length: e.core.contiguousLength })
      else if (e.state === 'pending' || e.state === 'regate') have.push({ key: e.key, length: 0 })
    }
    return have
  }

  function broadcast (msg) {
    for (const p of peers) p.send(msg)
  }

  function helloPeers () {
    return [...peers].filter((p) => p.gotHello)
  }

  // Max length advertised for key by any inventory-complete peer (undefined
  // when nobody advertises it): starts gates and reports `unadvertised`; it
  // is NOT the G1 target of an accepted follow (see target).
  function theirs (key) {
    let best
    for (const p of helloPeers()) {
      if (!p.inventoryComplete || !p.remoteHave.has(key)) continue
      const len = p.remoteHave.get(key)
      if (best === undefined || len > best) best = len
    }
    return best
  }

  // Max length advertised for a PENDING key by the peers that still hold it
  // (H2, cycle 3): verified seeders always; any other peer only while no
  // quarantine fetch that included its socket failed for the key in this run
  // and, with `budget`, only while the unverified budget runs. undefined
  // when nobody holds it at length >= 1.
  function pendingTheirs (entry, { budget }) {
    let best
    for (const p of helloPeers()) {
      if (!p.inventoryComplete || !p.remoteHave.has(entry.key)) continue
      const len = p.remoteHave.get(entry.key)
      if (len < 1) continue
      if (!p.verifiedSeeder) {
        if (entry.failedSockets.has(p.socket)) continue
        if (budget && budgetExpired) continue
      }
      if (best === undefined || len > best) best = len
    }
    return best
  }

  // G1 target of an ACTIVE follow (S2, H1): the max of the signed length the
  // replica already knows (authenticated by the author's signature through
  // replication), the lengths advertised by verified seeders and, while the
  // unverified budget runs, the claims of every other peer (noteClaim).
  function target (entry) {
    let best = entry.core.length
    pruneClaims(entry)
    for (const p of helloPeers()) {
      if (!p.inventoryComplete || !p.remoteHave.has(entry.key)) continue
      const len = p.remoteHave.get(entry.key)
      if (len <= best) continue
      if (p.verifiedSeeder) {
        best = len
        continue
      }
      if (budgetExpired) continue
      const claim = entry.claims.get(p.peerKey)
      if (claim && claim.length === len) best = len
    }
    return best
  }

  // G1 claims (H1, H2): kept only in --once mode and only while the budget
  // runs, once the replica is open (pending keys have no signed length to
  // compare); a claim at or below core.length is dropped. At most
  // maxConnections claims per entry; a peer's claims go when it disconnects.
  function noteClaim (entry, peer, length) {
    if (!once || peer.verifiedSeeder || peer.peerKey === null || !entry.core) return
    if (budgetExpired) {
      if (length > entry.core.length) ignoreClaim(entry, peer, length)
      return
    }
    if (length <= entry.core.length) {
      entry.claims.delete(peer.peerKey)
      return
    }
    const claim = entry.claims.get(peer.peerKey)
    if (claim) {
      claim.length = length
      return
    }
    if (entry.claims.size >= maxConnections) return
    entry.claims.set(peer.peerKey, { length })
  }

  // Claims the signed length caught up with are dropped.
  function pruneClaims (entry) {
    for (const [peerKey, claim] of entry.claims) {
      if (claim.length <= entry.core.length) entry.claims.delete(peerKey)
    }
  }

  function dropClaims (peer) {
    if (peer.peerKey === null) return
    for (const p of peers) if (p.peerKey === peer.peerKey) return // still connected
    for (const e of follows.values()) e.claims.delete(peer.peerKey)
  }

  function failedSocketCount () {
    let n = 0
    for (const e of follows.values()) n += e.failedSockets.size
    return n
  }

  function claimCount () {
    let n = 0
    for (const e of follows.values()) n += e.claims.size
    return n
  }

  // The budget starts at the first hello of an unverified peer (--once only).
  function startBudget () {
    if (!once || budgetStarted) return
    budgetStarted = true
    later(expireBudget, unverifiedBudgetMs)
  }

  // Budget over: the claims are dropped, and every unverified claim above
  // core.length and every unverified peer still below diary.length (now or
  // later in the run) is reported once per peer and key; the dedupe state
  // lives on the peer object and goes with it.
  function expireBudget () {
    if (ending) return
    budgetExpired = true
    for (const e of follows.values()) e.claims.clear()
    for (const p of helloPeers()) {
      if (p.verifiedSeeder) continue
      for (const [key, length] of p.remoteHave) {
        if (key === ownHex) noteInterest(p, length)
        else if (follows.has(key)) noteClaim(follows.get(key), p, length)
      }
    }
    evaluate()
  }

  function ignoreClaim (entry, peer, length) {
    if (!peer.ignoredClaims) peer.ignoredClaims = new Set()
    if (peer.ignoredClaims.has(entry.key)) return
    peer.ignoredClaims.add(entry.key)
    emit({ event: 'claim-ignored', key: entry.key, peerKey: peer.peerKey, length })
  }

  function noteInterest (peer, length) {
    if (!once || !budgetExpired || peer.verifiedSeeder || peer.ignoredInterest) return
    if (length >= diary.length) return
    peer.ignoredInterest = true
    emit({ event: 'peer-ignored', peerKey: peer.peerKey })
  }

  // A peer that may hold the run: verified seeders always, others only while
  // the unverified budget runs.
  function counts (p) {
    return p.verifiedSeeder || !budgetExpired
  }

  // G3 (S2, H1): peers interested in our diary that still count.
  function interestedPeers () {
    const out = []
    for (const p of helloPeers()) {
      if (p.verifiedSeeder && p.admittedOwn) {
        out.push(p)
        continue
      }
      if (p.remoteHave.has(ownHex) && counts(p)) out.push(p)
    }
    return out
  }

  function verifiedSeeders () {
    return helloPeers().filter((p) => p.verifiedSeeder)
  }

  function anyFailing () {
    for (const e of follows.values()) if (e.state === 'failing') return true
    return false
  }

  function unmetGoals () {
    const unmet = []
    // G1
    for (const e of follows.values()) {
      if (e.state === 'failed' || e.state === 'failing') continue
      const t = theirs(e.key)
      if (e.state === 'pending') {
        // H2: unmet while a fetch is in flight (bounded by the deadline), or
        // while a peer that still holds the key advertises it at >= 1.
        // A fetch cut by the deadline (item 4) and a replica discarded from
        // regate at the end (item 5) keep the key unmet whatever the budget.
        const held = pendingTheirs(e, { budget: true })
        if (held !== undefined) unmet.push(e.key + ':0/' + held)
        else if (e.fetching || e.cutByDeadline || e.discardedRegate) unmet.push(e.key + ':0/' + (t === undefined ? 0 : t))
      } else if (e.state === 'regate') {
        // Unmet until block 0 is in the main store and passed the local gate.
        unmet.push(e.key + ':0/' + (t === undefined ? 0 : t))
      } else {
        const ours = e.core.contiguousLength
        const want = target(e)
        if (ours < want) unmet.push(e.key + ':' + ours + '/' + want)
      }
    }
    // G2
    const seeders = verifiedSeeders()
    if (cert && seeders.length >= 1) {
      const met = seederHolds()
      if (!met) {
        let best = 0
        for (const p of seeders) best = Math.max(best, p.remoteHave.get(ownHex) || 0)
        unmet.push(ownHex + ':' + diary.length + '/' + best)
      }
    }
    // G3
    for (const p of interestedPeers()) {
      const len = p.remoteHave.get(ownHex) || 0
      if (len < diary.length) unmet.push(ownHex + ':' + diary.length + '/' + len)
    }
    return [...new Set(unmet)]
  }

  // G2 holds with >= 1 verified seeder that admitted our diary and
  // advertises its full length; remembered for seederConfirmed (H1 c).
  function seederHolds () {
    const met = cert !== null && verifiedSeeders().some((p) => p.admittedOwn && (p.remoteHave.get(ownHex) || 0) >= diary.length)
    if (met) confirmedLength = diary.length
    return met
  }

  function buildResult (ok, errors) {
    const downloaded = {}
    const unadvertised = []
    for (const e of follows.values()) {
      if (e.state === 'failed' || e.state === 'failing') continue
      if (e.state === 'active') {
        const t = theirs(e.key)
        downloaded[e.key] = e.core.contiguousLength
        if (t === undefined || t < 1) unadvertised.push(e.key) // D4
      } else if (e.state === 'pending') {
        // H2: advertisers whose fetch failed no longer count.
        if (pendingTheirs(e, { budget: false }) === undefined) unadvertised.push(e.key)
      } else {
        const t = theirs(e.key)
        if (t === undefined || t < 1) unadvertised.push(e.key)
      }
    }
    return {
      ok,
      peers: helloPeers().length,
      seeders: verifiedSeeders().length,
      admitted: admittedEver,
      rejected: rejectedReason,
      downloaded,
      unadvertised,
      skipped: skipped.slice(),
      errors,
      errorsSoft: errorsSoft.slice(),
      seederConfirmed: seederHolds() || confirmedLength >= diary.length
    }
  }

  // outcome() -> [ok, errors], evaluated only after every pending purge and
  // local re-gate settled, so the result reflects them; a purge failure
  // (fatal) or a hard error observed at any point makes ok false.
  function finish (outcome) {
    if (ending) return
    ending = true
    discardRegate()
    ;(async () => {
      while (settling.size > 0) await Promise.allSettled([...settling])
      ended = true
      let [ok, errors] = outcome()
      if (fatal) {
        ok = false
        errors = fatal.slice()
      } else if (hardErrors.length > 0) {
        ok = false
        errors = [...hardErrors, ...errors.filter((e) => !hardErrors.includes(e))]
      }
      result = buildResult(ok, errors)
      settle()
    })()
  }

  // A replica still in regate never passed the local gate in this run: on
  // ending it is closed and purged (tracked, so finish() and the store close
  // wait for it; a failure follows purgeFailed). It is reported as pending.
  function discardRegate () {
    for (const e of follows.values()) {
      if (e.state !== 'regate') continue
      stopEntry(e)
      e.state = 'pending'
      e.discardedRegate = true // still unmet for the outcome (item 5)
      const core = e.core
      e.core = null
      track((async () => {
        await core.close()
        await purgeKey(e.key)
      })(), noop, () => {
        if (!ended) purgeFailed(e.key)
        else log('aviso: falha ao limpar diário ' + key8(e.key))
      })
    }
  }

  function fail (errors) {
    if (!fatal) fatal = errors
    finish(() => [false, errors])
  }

  function purgeFailed (key) {
    fail(['falha ao limpar diário rejeitado: ' + key8(key)])
  }

  function evaluate () {
    if (ending || !once || !graceDone || deadlineHit) return
    const ps = helloPeers()
    if (ps.length === 0) return
    // An unverified peer's incomplete inventory waits only within the budget.
    if (ps.some((p) => !p.inventoryComplete && counts(p))) return
    if (anyFailing()) return
    if (unmetGoals().length === 0) finish(() => [true, []])
  }

  function checkGrace () {
    if (graceDone || graceTimer === null) return
    if ([...peers].every((p) => p.gotHello)) {
      clearTimeout(graceTimer)
      graceTimer = null
      graceDone = true
    }
  }

  function later (fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
    return timer
  }

  function leaveTopic (entry) {
    if (!swarm) return
    swarm.leave(entry.topic).catch(noop)
  }

  // Gate failure or fork: skip, withdraw, and (when a replica exists in the
  // main store) close + purge it; the purge is tracked and awaited by finish().
  function failFollow (entry, reason, { purge }) {
    if (entry.state === 'failing' || entry.state === 'failed') return
    stopEntry(entry)
    skipped.push({ key: entry.key, reason })
    emit({ event: 'skipped', key: entry.key, reason })
    broadcast({ type: 'rejected', key: entry.key, reason })
    leaveTopic(entry)
    if (!purge) {
      entry.state = 'failed'
      evaluate()
      return
    }
    entry.state = 'failing'
    const core = entry.core
    entry.core = null
    const p = (async () => {
      if (core) await core.close()
      await purgeKey(entry.key)
    })()
    track(p, () => {
      entry.state = 'failed'
      evaluate()
    }, () => {
      entry.state = 'failed'
      purgeFailed(entry.key)
    })
  }

  function stopEntry (entry) {
    if (entry.stopGrow) entry.stopGrow()
    if (entry.stopFork) entry.stopFork()
    if (entry.stopQuota) entry.stopQuota()
    if (entry.range) entry.range.destroy()
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer)
      timers.delete(entry.retryTimer)
    }
    entry.stopGrow = entry.stopFork = entry.stopQuota = entry.range = entry.retryTimer = null
  }

  // Log quota (S3): the signed length and byteLength advance on the upgrade
  // proof ('append' fires) before the blocks arrive, so a log over the quota
  // stops its download range before it is fetched. Chosen outcome: the
  // follow is skipped with reason 'quota' and its range destroyed; an ACTIVE
  // replica keeps the blocks already verified (no purge), so the next run
  // re-gates it at startup, hits the quota again and skips it again; a
  // replica still in regate holds nothing verified and is purged (an empty
  // core must not stay in the main store).
  function overQuota (core) {
    return core.length > maxLogBlocks || core.byteLength > maxLogBytes
  }

  // Returns true when the entry was failed for quota.
  function checkQuota (entry) {
    const core = entry.core
    if (ended || !core) return false
    if (entry.state !== 'active' && entry.state !== 'regate') return false
    if (!overQuota(core)) return false
    failFollow(entry, 'quota', { purge: entry.state === 'regate' })
    return true
  }

  // The quota listener is registered BEFORE the growth watcher (listeners
  // run in registration order) and onGrow checks again, so nothing past the
  // limit is ever advertised or reported downloaded.
  function watchEntry (entry, core) {
    entry.core = core
    const check = () => { if (entry.core === core) checkQuota(entry) }
    core.on('append', check)
    entry.stopQuota = () => core.off('append', check)
    entry.stopFork = watchFork(core, () => { onFork(entry) })
    entry.range = core.download({ start: 0, end: -1 })
    entry.stopGrow = watchContiguous(core, (length) => { onGrow(entry, length) })
    checkQuota(entry)
  }

  // Block 0 already passed the local gate (startup).
  function activate (entry, core) {
    entry.state = 'active'
    watchEntry(entry, core)
  }

  // Remote gate passed: the replica is open in the main store but nothing it
  // holds counts until block 0 arrives there and passes the local gate.
  function enterRegate (entry, core) {
    entry.state = 'regate'
    watchEntry(entry, core)
    // The claims advertised while the key was pending are recorded now.
    for (const p of helloPeers()) {
      if (p.remoteHave.has(entry.key)) noteClaim(entry, p, p.remoteHave.get(entry.key))
    }
    if (entry.state === 'regate' && core.contiguousLength > 0) regate(entry)
  }

  function onGrow (entry, length) {
    if (ended) return
    if (checkQuota(entry)) return
    if (entry.state === 'regate') {
      regate(entry)
      return
    }
    if (entry.state !== 'active') return
    broadcast({ type: 'have', key: entry.key, length })
    emit({ event: 'downloaded', key: entry.key, length })
    evaluate()
  }

  function regate (entry) {
    if (entry.gating || entry.state !== 'regate') return
    entry.gating = true
    const core = entry.core
    const p = (async () => {
      let reason = regateHook ? await regateHook(entry.key) : null
      if (reason === null || reason === undefined) reason = await localGate(core, entry.key, association)
      return reason
    })()
    track(p, (reason) => {
      entry.gating = false
      if (entry.state !== 'regate') return
      if (reason) {
        // The advertiser served a different block 0 to the main store than
        // to the quarantine: skip and purge, and the run cannot be ok.
        hardError('bloco 0 divergente: ' + key8(entry.key) + ' (' + reason + ')')
        failFollow(entry, reason, { purge: true })
        return
      }
      entry.state = 'active'
      const length = core.contiguousLength
      broadcast({ type: 'have', key: entry.key, length })
      emit({ event: 'downloaded', key: entry.key, length })
      evaluate()
    }, () => {
      entry.gating = false
      if (entry.state !== 'regate') return
      hardError('bloco 0 divergente: ' + key8(entry.key) + ' (not-in-log)')
      failFollow(entry, 'not-in-log', { purge: true })
    })
  }

  function onFork (entry) {
    if (ended) return
    if (entry.state !== 'active' && entry.state !== 'regate') return
    failFollow(entry, 'fork', { purge: true })
  }

  // Sockets of connected peers whose latest advertisement of key is >= 1.
  // In --once mode an unverified peer whose socket was in a failed fetch for
  // the key is not asked again (H2: re-advertising must not keep a fetch,
  // and so the key, in flight); long-running mode retries everyone.
  function advertisers (entry) {
    return helloPeers().filter((p) => {
      if ((p.remoteHave.get(entry.key) || 0) < 1) return false
      return !once || p.verifiedSeeder || !entry.failedSockets.has(p.socket)
    }).map((p) => p.socket)
  }

  // A late advertiser (a peer that advertises the key with length >= 1 while
  // a quarantine fetch for it is in flight) joins that fetch, so it can still
  // supply block 0 before the deadline.
  function noteAdvertisement (key, length, peer) {
    if (key === ownHex) {
      noteInterest(peer, length) // G3 itself reads remoteHave
      return
    }
    const entry = follows.get(key)
    if (!entry) return
    noteClaim(entry, peer, length)
    if (entry.state !== 'pending' || length < 1) return
    entry.advSeq++
    if (entry.fetch && peer && peer.gotHello && advertisers(entry).includes(peer.socket)) entry.fetch.addSocket(peer.socket)
    maybeFetch(entry)
  }

  function maybeFetch (entry) {
    if (ending || deadlineHit || entry.state !== 'pending' || entry.fetching) return
    if (entry.advSeq <= entry.fetchedAdv) return
    // Open sockets only (item 2): a closed one neither starts a fetch nor
    // takes one of its slots.
    const sockets = advertisers(entry).filter((s) => !s.destroyed)
    if (sockets.length === 0) return
    // In --once mode a fetch is bounded by the gate timeout AND the run's
    // deadline (H2): a fetch that fails before the deadline releases the
    // unverified advertisers it included from completion.
    let fetchTimeout = gateTimeoutMs
    let deadlineBound = false // this fetch ends with the run, not before it
    if (once) {
      const left = deadline - Date.now()
      if (left < GATE_MIN_TIMEOUT_MS) return
      deadlineBound = left <= gateTimeoutMs
      fetchTimeout = Math.min(gateTimeoutMs, left)
    }
    entry.fetching = true
    entry.cutByDeadline = false
    entry.fetchedAdv = entry.advSeq
    const p = fetchGate(entry, sockets, fetchTimeout, deadlineBound).finally(() => {
      entry.fetching = false
      entry.fetch = null
      inflight.delete(p)
      // A fetch in flight holds a pending key (H2): re-check once it ended.
      evaluate()
    })
    inflight.add(p)
  }

  async function fetchGate (entry, sockets, fetchTimeout, deadlineBound) {
    let r
    // Every socket attached to this fetch, at most maxFetchSockets OPEN ones
    // (item 2): a socket that closed no longer takes a slot, so short-lived
    // advertisers cannot lock a later one out of the fetch, and a slot it
    // frees goes to an advertiser refused while the fetch was full.
    const first = sockets.slice(0, maxFetchSockets)
    const included = new Set(first)
    try {
      const fetch = startQuarantineFetch(qstore, entry.key, first, fetchTimeout)
      const addSocket = (socket) => {
        for (const s of included) if (s.destroyed) included.delete(s)
        if (included.size >= maxFetchSockets) return false
        const added = fetch.addSocket(socket)
        if (added) included.add(socket)
        return added
      }
      entry.fetch = {
        promise: fetch.promise,
        addSocket,
        // A socket closed: if it held a slot, offer the freed slot(s) to the
        // connected advertisers not yet included (same eligibility as
        // maybeFetch), within the cap.
        release (socket) {
          if (!included.delete(socket)) return
          for (const s of advertisers(entry)) {
            if (included.size >= maxFetchSockets) break
            if (!s.destroyed && !included.has(s)) addSocket(s)
          }
        }
      }
      r = await fetch.promise
    } catch {
      if (!ended) purgeFailed(entry.key)
      return
    }
    if (entry.state !== 'pending') return
    if (r.error) {
      softError('bloco 0 indisponível: ' + key8(entry.key))
      // H2: the peers in a fetch that failed before the deadline no longer
      // hold the key for completion. A fetch bounded by the deadline (it
      // fails with the run, racing the deadline timer) keeps the key unmet:
      // 'tempo esgotado', as before, but only while one of its sockets is
      // still open: when every advertiser left, nobody holds the key any
      // more and it is reported unadvertised, as a departure before the
      // fetch became deadline-bound is.
      // Recorded in --once mode only, and only for sockets still open (a
      // closed socket is never pinned here: item 2).
      const anyOpen = [...included].some((s) => !s.destroyed)
      if ((deadlineBound || deadlineHit) && anyOpen) entry.cutByDeadline = true
      else if (once) for (const s of included) if (!s.destroyed) entry.failedSockets.add(s)
      if (ending) return
      if (!once) {
        entry.retryTimer = later(() => {
          entry.retryTimer = null
          entry.fetchedAdv = -1
          maybeFetch(entry)
        }, GATE_RETRY_MS)
      }
      // A new advertisement during the fetch triggers a new attempt.
      setImmediate(() => maybeFetch(entry))
      evaluate()
      return
    }
    if (ending) return
    const reason = gateVerdict(r.raw, entry.key, association)
    if (reason) {
      failFollow(entry, reason, { purge: false })
      return
    }
    // D2: the signed length/byteLength the quarantine learned with block 0
    // are checked against the quota before anything opens in the main store.
    if (overQuota(r)) {
      failFollow(entry, 'quota', { purge: false })
      return
    }
    let core
    try {
      if (openHook) await openHook(entry.key) // test-only
      core = await openReplica(store, entry.key)
    } catch (err) {
      if (!ended) log('aviso: falha ao abrir réplica ' + key8(entry.key) + ': ' + err.message)
      return
    }
    if (ending || entry.state !== 'pending') {
      // The main store already holds the core (servable): purge it (item 8).
      // finish() awaits tracked purges; after the result the finally still
      // waits for it before the store closes.
      await core.close().catch(noop)
      track(purgeKey(entry.key), noop, () => {
        if (!ended) purgeFailed(entry.key)
        else log('aviso: falha ao limpar diário ' + key8(entry.key))
      })
      return
    }
    enterRegate(entry, core)
    evaluate()
  }

  function onMessage (msg, peer) {
    if (ending) return
    switch (msg.type) {
      case 'hello': {
        peer.verifiedSeeder = msg.role === 'seeder' &&
          peer.peerKey !== null &&
          seederCertForKey(peer.remoteCert, peer.peerKey, association).ok
        if (!peer.verifiedSeeder) startBudget()
        if (!peer.gotHello) {
          peer.gotHello = true
          emit({ event: 'peer', role: peer.remoteRole, peerKey: peer.peerKey, verified: peer.verifiedSeeder })
          checkGrace()
        }
        for (const [key, length] of peer.remoteHave) {
          if (relevant(key)) {
            peer.lastAdv.set(key, length)
            peer.emittedHave.set(key, length)
          }
          noteAdvertisement(key, length, peer)
        }
        break
      }
      case 'have': {
        // H1 (cycle 3): only our own key or a followed key, and only when
        // the length this peer advertises for it changed; a repeat does no
        // work at all (no event, no evaluate).
        if (!relevant(msg.key)) return
        if (peer.lastAdv.get(msg.key) === msg.length) return
        peer.lastAdv.set(msg.key, msg.length)
        if (peer.emittedHave.get(msg.key) !== msg.length) {
          peer.emittedHave.set(msg.key, msg.length)
          emit({ event: 'have', key: msg.key, length: msg.length })
        }
        noteAdvertisement(msg.key, msg.length, peer)
        break
      }
      case 'admitted':
        if (relevant(msg.key)) peer.lastAdv.set(msg.key, msg.length)
        if (msg.key === ownHex && peer.verifiedSeeder) {
          peer.admittedOwn = true
          admittedEver = true
          emit({ event: 'admitted', key: msg.key, length: msg.length })
        }
        noteAdvertisement(msg.key, msg.length, peer)
        break
      case 'rejected':
        peer.lastAdv.delete(msg.key) // the advertisement is gone (remoteHave too)
        if (msg.key === ownHex) {
          if (!peer.verifiedSeeder) {
            // At most once per peer (H1, cycle 3).
            if (!peer.withdrawnOwn) {
              peer.withdrawnOwn = true
              emit({ event: 'withdrawn', key: msg.key, peerKey: peer.peerKey, reason: msg.reason })
            }
          } else if (msg.reason === 'timeout') {
            peer.admittedOwn = false
            emit({ event: 'rejected', key: msg.key, reason: msg.reason })
            softError('rejeitado: timeout (' + key8(peer.peerKey) + ')')
          } else {
            peer.admittedOwn = false
            emit({ event: 'rejected', key: msg.key, reason: msg.reason })
            rejectedReason = msg.reason
            fail(['rejeitado: ' + msg.reason])
            return
          }
        }
        break
      default:
        break // members ignore announce
    }
    evaluate()
  }

  // Keys whose advertisements matter to this run: our own and the follows.
  function relevant (key) {
    return key === ownHex || follows.has(key)
  }

  function onPeerDropped (ev) {
    log('aviso: par descartado (' + key8(ev.peerKey) + '): ' + ev.reason)
    emit(ev)
  }

  function onConnection (socket, info) {
    socket.on('error', noop)
    if (ending) {
      socket.destroy()
      return
    }
    // Connection cap (S1), before the store replicates the socket.
    if (refuseOverConnectionLimit(swarm, socket, { limit: maxConnections, log: onPeerDropped })) return
    // Live connections per topic (re-discovery resumes when the last one of a
    // topic goes away); info.topics is known for client-side connections only.
    liveConnections++
    const topicsOf = []
    if (info && Array.isArray(info.topics)) {
      for (const t of info.topics) topicsOf.push(b4a.toString(t, 'hex'))
    }
    for (const hex of topicsOf) {
      if (!topicConnections.has(hex)) topicConnections.set(hex, new Set())
      topicConnections.get(hex).add(socket)
    }
    socket.once('close', () => {
      liveConnections--
      for (const hex of topicsOf) {
        const set = topicConnections.get(hex)
        if (!set) continue
        set.delete(socket)
        if (set.size === 0) topicConnections.delete(hex)
      }
      for (const e of follows.values()) {
        e.failedSockets.delete(socket)
        if (e.fetch && !ending) e.fetch.release(socket)
      }
    })
    store.replicate(socket)
    let peer
    try {
      // The peer's opened/hello promises may resolve false/null on close;
      // this module tracks hello through gotHello/onmessage instead.
      peer = attachAdmission(socket, {
        role: 'member',
        have: inventory(),
        onmessage: onMessage,
        onclose: (p) => {
          peers.delete(p)
          dropClaims(p)
          checkGrace()
          evaluate()
          // Per-connection advertisement state goes with the connection.
          p.lastAdv = new Map()
          p.emittedHave = new Map()
          if (inspectHook) lastClosedPeer = p // test-only
        },
        oninventory: () => evaluate(),
        messageBurst,
        messageRate,
        log: (ev) => {
          if (ev && ev.event === 'inventory-timeout') log('aviso: inventário incompleto (' + key8(ev.peerKey) + ')')
          else if (ev && ev.event === 'peer-dropped') onPeerDropped(ev)
        }
      })
    } catch (err) {
      log('aviso: canal de admissão: ' + err.message)
      return
    }
    peer.gotHello = false
    peer.verifiedSeeder = false
    peer.admittedOwn = false
    peer.ignoredClaims = null // keys whose claim-ignored was emitted (H1)
    peer.ignoredInterest = false // peer-ignored emitted (H1)
    peer.lastAdv = new Map() // key -> last length processed (own + follows only)
    peer.emittedHave = new Map() // key -> last length reported as a 'have' event
    peer.withdrawnOwn = false // 'withdrawn' emitted for our diary
    peers.add(peer)
    // send() queues until the channel opens, right after hello.
    if (cert) peer.send({ type: 'announce', key: ownHex, cert })
  }

  // Reflects CURRENT live connections only: a topic whose last peer left is
  // looked up again by startRediscovery.
  function topicHasPeer (topic) {
    if (ending) return true
    const hex = b4a.toString(topic, 'hex')
    if (hex === rendezvousHex) return liveConnections > 0
    const key = topicKeys.get(hex)
    if (!key) return true
    // Item 6: a connection discovered on the topic counts only while its
    // peer has not sent hello yet, is a verified seeder, or advertises the
    // key at >= 1 (an empty follower must not stop re-discovery).
    for (const socket of topicConnections.get(hex) || []) {
      const p = socket._varandaPeer
      if (!p || !p.gotHello || p.verifiedSeeder) return true
      if ((p.remoteHave.get(key) || 0) >= 1) return true
    }
    // D1: a peer advertising the key at 0 (a follower of a pending key) holds
    // nothing for us, so it does not stop the topic's re-discovery.
    for (const p of peers) if ((p.remoteHave.get(key) || 0) >= 1) return true
    return false
  }

  function onAbort () {
    if (ending) return
    if (once) finish(timeoutOutcome)
    else finish(() => [true, []])
  }

  function timeoutOutcome () {
    const ps = helloPeers()
    if (ps.length === 0) return [false, ['sem pares']]
    const unmet = unmetGoals()
    // The deadline may have hit while a purge was in flight; if everything
    // holds once it settled, the run succeeded.
    if (unmet.length === 0 && ps.every((p) => p.inventoryComplete || !counts(p))) return [true, []]
    return [false, ['tempo esgotado: ' + unmet.join(', ')]]
  }

  function onDeadline () {
    deadlineTimer = null
    if (ending) return
    deadlineHit = true
    // Gate fetches never run past the deadline: let them report first.
    Promise.allSettled([...inflight]).then(() => finish(timeoutOutcome))
  }

  try {
    store = await openStore(dataDir, storeOptions)
    // R6.2: the main store holds the RocksDB lock before the quarantine is wiped.
    diary = await openDiary(store)
    ownHex = b4a.toString(diary.key, 'hex')
    // D3: only block 0 is read (same semantics as genesisCert(readAll)).
    const g = genesisCert(diary.contiguousLength > 0
      ? [{ seq: 0, record: decodeBlock(await diary.get(0, { wait: false, raw: true })) }]
      : [])
    if (g && certForKey(g, ownHex, association).ok) cert = g
    else log('sem certificado válido no bloco 0: o diário não será anunciado')
    qstore = await openQuarantine(dataDir, storeOptions)
    if (inspectHook) inspectHook({ claimCount, topicHasPeer, failedSocketCount, lastClosedPeer: () => lastClosedPeer }) // test-only

    // One deadline (item 7): the completion timer and the gate fetches share
    // `deadline`, computed before the startup I/O.
    if (once) deadlineTimer = setTimeout(onDeadline, Math.max(0, deadline - Date.now()))
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    } else if (!once) {
      for (const sig of ['SIGINT', 'SIGTERM']) {
        process.once(sig, onAbort)
        signalHandlers.push(sig)
      }
    }

    // Follow gate at start (R5.8 a), before any swarm.
    // The inventory (own diary + follows) must fit a hello (item 4c): a
    // hand-edited follows.json over the limit uses the first maxFollows.
    let followList = readFollows(dataDir)
    if (followList.length > maxFollows) {
      log('aviso: limite de diários seguidos excedido: só os primeiros ' + maxFollows + ' serão sincronizados')
      followList = followList.slice(0, maxFollows)
    }
    for (const raw of followList) {
      if (ending) break
      const key = typeof raw === 'string' ? raw.toLowerCase() : ''
      if (!HEX64.test(key) || key === ownHex || follows.has(key)) {
        if (key !== ownHex) log('aviso: chave seguida inválida ignorada')
        continue
      }
      const entry = {
        key,
        state: 'pending',
        core: null,
        topic: Hypercore.discoveryKey(b4a.from(key, 'hex')),
        range: null,
        stopGrow: null,
        stopFork: null,
        retryTimer: null,
        fetching: false,
        fetch: null, // the in-flight quarantine fetch handle ({ promise, addSocket })
        gating: false,
        advSeq: 0,
        fetchedAdv: 0,
        stopQuota: null,
        claims: new Map(), // peerKey -> { length } (G1 claims, --once only)
        failedSockets: new Set(), // open sockets of failed fetches for this key (H2, --once)
        cutByDeadline: false, // the last fetch ended with the deadline (item 4)
        discardedRegate: false // purged from regate when the run ended (item 5)
      }
      follows.set(key, entry)
      const core = await openReplica(store, key)
      let reason = null
      if (core.fork !== 0) reason = 'fork'
      else if (core.contiguousLength > 0) reason = await localGate(core, key, association)
      if (core.contiguousLength > 0 && reason === null) {
        activate(entry, core)
        continue
      }
      // Tracked like the runtime purges: an abort during it still waits for
      // it, and a failure makes the result ok: false.
      let purged = true
      await track((async () => {
        await core.close()
        await purgeKey(key)
      })(), noop, () => {
        purged = false
        purgeFailed(key)
      })
      if (!purged) break
      if (reason) {
        entry.state = 'failed'
        skipped.push({ key, reason })
        emit({ event: 'skipped', key, reason })
      }
    }

    if (!ending) {
      swarm = createSwarm({ bootstrap, host })
      swarm.on('connection', onConnection)
      const rendezvous = topicFor(association)
      rendezvousHex = b4a.toString(rendezvous, 'hex')
      const topics = [rendezvous, diary.discoveryKey]
      topicKeys.set(b4a.toString(diary.discoveryKey, 'hex'), ownHex)
      for (const e of follows.values()) {
        if (e.state === 'failed') continue
        topics.push(e.topic)
        topicKeys.set(b4a.toString(e.topic, 'hex'), e.key)
      }
      stopDiaryWatch = watchContiguous(diary, (length) => {
        broadcast({ type: 'have', key: ownHex, length })
        evaluate()
      })
      // The deadline and an abort interrupt network startup: the join is
      // raced against the run's completion; when that wins, the swarm is
      // destroyed in the finally below and the timeout/abort result stands.
      const done = store.findingPeers()
      try {
        await Promise.race([(joinHook || joinAndFlush)(swarm, topics), finished])
      } finally {
        done()
      }
      if (!ending) {
        emit({ event: 'ready', topic: rendezvousHex })
        stopRediscovery = startRediscovery(swarm, topics, {
          intervalMs: once ? REDISCOVER_ONCE_MS : REDISCOVER_LONG_MS,
          hasPeer: topicHasPeer,
          log: (ev) => log('aviso: redescoberta: ' + (ev && ev.error))
        })
        graceTimer = setTimeout(() => {
          graceTimer = null
          graceDone = true
          evaluate()
        }, GRACE_MS)
        checkGrace()
        evaluate()
      }
    }

    await finished
    return result
  } finally {
    ending = true
    ended = true
    if (deadlineTimer) clearTimeout(deadlineTimer)
    if (graceTimer) clearTimeout(graceTimer)
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    if (signal) signal.removeEventListener('abort', onAbort)
    for (const sig of signalHandlers) process.removeListener(sig, onAbort)
    if (stopRediscovery) stopRediscovery()
    if (stopDiaryWatch) stopDiaryWatch()
    discardRegate() // a throw may have skipped finish()
    for (const e of follows.values()) stopEntry(e)
    if (swarm) await swarm.destroy().catch(noop)
    // The quarantine is closed and removed, and every in-flight fetch and
    // purge has settled, BEFORE the main store closes: store.close releases
    // the data-dir lock, so a run that takes the lock right after this one
    // (and wipes/recreates the quarantine) never has it removed under it.
    if (qstore) {
      await qstore.close().catch(noop)
      await Promise.allSettled([...inflight])
      removeQuarantine(dataDir)
    }
    // A throw before `finished` may leave purges in flight: never close the
    // store underneath them.
    while (settling.size > 0) await Promise.allSettled([...settling])
    if (store) await store.close().catch(noop)
  }
}

module.exports = { runSync, GATE_TIMEOUT_MS, GATE_MIN_TIMEOUT_MS, GATE_RETRY_MS, UNVERIFIED_BUDGET_MS }
