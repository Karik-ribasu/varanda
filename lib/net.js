// Network helpers: rendezvous topic, bootstrap parsing, swarm creation, the
// 'varanda/admission/1' channel (sharing the hypercore replication muxer),
// growth and fork watchers, and the quarantine block-0 fetch (docs §4, §5, §8).
const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const HyperDHT = require('hyperdht')
const Hyperswarm = require('hyperswarm')
const { MAX_LOG_BLOCKS } = require('./records')

const PROTOCOL = 'varanda/admission/1'
const MAX_PAYLOAD = 16384
const MAX_HELLO_HAVE = 100
const INVENTORY_TIMEOUT_MS = 5000
// Per-connection limits (security audit S1, S6): a peer that exceeds one is
// disconnected and logged as { event: 'peer-dropped', peerKey, reason }.
const MAX_INVENTORY = 4096 // distinct keys one peer may advertise
const MAX_BAD_MESSAGES = 16 // tolerated per connection; one more disconnects
const HELLO_TIMEOUT_MS = 10000 // a valid hello must arrive within this
const MAX_CONNECTIONS = 64 // open connections per swarm (server side too)
// Message rate (cycle 3 H1, CWE-770): a per-connection token bucket over
// every VALID admission message. The burst covers an honest initial
// inventory (hello + up to MAX_INVENTORY overflow have messages) with room to
// spare; a peer over it is dropped with reason 'message-rate'.
const MESSAGE_BURST = MAX_INVENTORY + 64
const MESSAGE_RATE = 100 // tokens per second
// Our own sends are paced below the receiver's bucket (same burst minus a
// margin for network jitter, half the rate), and queued have messages are
// coalesced per key (latest wins), so an honest peer that advertises growth
// block by block (watchContiguous) never trips the receiver's limit.
const SEND_RATE_DIVISOR = 2
const SEND_BURST_MARGIN_DIVISOR = 16
// Bound on our own queued sends per connection (cycle 3 retry, item 3): have
// messages are merged per key, so only distinct keys and other messages
// count; an overflow drops the peer with reason 'send-backlog'.
const MAX_SEND_BACKLOG = MAX_INVENTORY + 64

const HEX64 = /^[0-9a-f]{64}$/
const HEX64_ANY = /^[0-9a-fA-F]{64}$/
// A rejected.reason is a token, never free text (S4).
const REASON_RE = /^[a-z0-9-]{1,64}$/

function noop () {}

function isPlainObject (x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x)
  return proto === Object.prototype || proto === null
}

function isHex64 (s) {
  return typeof s === 'string' && HEX64.test(s)
}

// Advertised lengths are capped at MAX_LOG_BLOCKS (S1): no log over the quota
// is ever kept, so a larger claim is a protocol violation.
function isLength (n) {
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_LOG_BLOCKS
}

function hasExactKeys (obj, keys) {
  const own = Object.keys(obj)
  if (own.length !== keys.length) return false
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return false
  }
  return true
}

function topicFor (associationHex) {
  if (typeof associationHex !== 'string' || !HEX64_ANY.test(associationHex)) {
    throw new TypeError('associationHex must be 64 hex characters')
  }
  return crypto.hash(b4a.from('varanda/rendezvous/v1:' + associationHex.toLowerCase(), 'utf8'))
}

function normalizeBootstrapEntry (host, port) {
  if (typeof host !== 'string' || host.length === 0) {
    throw new TypeError('invalid bootstrap entry: empty host')
  }
  const p = typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : port
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new TypeError('invalid bootstrap entry: bad port')
  }
  const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return h + ':' + p
}

function parseBootstrapString (entry) {
  if (typeof entry !== 'string') throw new TypeError('invalid bootstrap entry')
  const s = entry.trim()
  const i = s.lastIndexOf(':')
  if (i <= 0) throw new TypeError('invalid bootstrap entry: ' + entry)
  return normalizeBootstrapEntry(s.slice(0, i), s.slice(i + 1))
}

function parseBootstrap (value) {
  if (value === undefined || value === null || value === '') return undefined
  if (Array.isArray(value) && value.length === 0) return undefined
  let list
  if (typeof value === 'string') list = value.split(',')
  else if (Array.isArray(value)) list = value
  else throw new TypeError('invalid bootstrap value')
  return list.map((entry) => {
    if (isPlainObject(entry)) return normalizeBootstrapEntry(entry.host, entry.port)
    return parseBootstrapString(entry)
  })
}

function generateNoiseKeyPair () {
  return HyperDHT.keyPair()
}

function isLoopbackHost (host) {
  return host === '127.0.0.1' || host === '::1'
}

function createSwarm ({ bootstrap, keyPair, host } = {}) {
  // With a private bootstrap, port [0, 0] makes the DHT bind an ephemeral
  // port (hyperdht rewrites port 0 to 49737; an empty range falls through to
  // bind(0)). When the DHT is bound to a loopback address (tests, the demo,
  // same-machine manual runs) every node is directly reachable, so firewall
  // detection is switched off: with the default probing, a client-initiated
  // connection between two processes that both bound ephemeral ports opened
  // but carried no data until the other side reconnected (observed with
  // hyperdht 6.34 on loopback; the demo's sync --once then waited on the
  // seeder's rediscovery). A private bootstrap on any other host says nothing
  // about reachability (a peer behind NAT would fail), so hyperdht's own
  // detection stays on. swarm.destroy() also destroys this DHT, so never
  // destroy it separately.
  const dhtOpts = bootstrap ? { bootstrap, port: [0, 0] } : {}
  if (host) {
    dhtOpts.host = host
    if (isLoopbackHost(host)) dhtOpts.firewalled = false
  }
  // maxPeers bounds the connections hyperswarm initiates; it never reads
  // maxServerConnections, so incoming connections are bounded by
  // refuseOverConnectionLimit on every 'connection' instead.
  return new Hyperswarm({ keyPair, dht: new HyperDHT(dhtOpts), maxPeers: MAX_CONNECTIONS })
}

// Connection cap (S1), run on every swarm 'connection' BEFORE
// store.replicate: when the swarm already holds `limit` other open
// connections the new socket is destroyed, logged as
// { event: 'peer-dropped', peerKey, reason: 'connection-limit' }, and true is
// returned. The socket itself is already in swarm.connections when hyperswarm
// emits 'connection', so it is not counted against itself.
function refuseOverConnectionLimit (swarm, socket, { limit = MAX_CONNECTIONS, log = noop } = {}) {
  const connections = swarm && swarm.connections ? swarm.connections : new Set()
  const others = connections.size - (connections.has(socket) ? 1 : 0)
  if (others < limit) return false
  const peerKey = socket.remotePublicKey ? b4a.toString(socket.remotePublicKey, 'hex') : null
  log({ event: 'peer-dropped', peerKey, reason: 'connection-limit' })
  socket.destroy()
  return true
}

async function joinAndFlush (swarm, topics) {
  const joined = new Set()
  const discoveries = []
  for (const topic of topics) {
    if (!b4a.isBuffer(topic) || topic.byteLength !== 32) {
      throw new TypeError('topic must be a 32-byte buffer')
    }
    const hex = b4a.toString(topic, 'hex')
    if (joined.has(hex)) continue
    const existing = swarm.status(topic)
    if (existing && !existing.destroyed) continue
    joined.add(hex)
    discoveries.push(swarm.join(topic, { server: true, client: true }))
  }
  for (const d of discoveries) await d.flushed()
  await swarm.flush()
}

// Re-runs the DHT lookup of every topic that still has no peer. Hyperswarm
// refreshes a discovery only every 10 minutes, so two swarms whose first join
// of a topic happens at the same moment (each looks up before the other's
// announce is stored) would otherwise not find each other for that long.
function startRediscovery (swarm, topics, { intervalMs = 1000, hasPeer = () => false, log = noop } = {}) {
  const list = []
  for (const topic of topics) {
    if (!b4a.isBuffer(topic) || topic.byteLength !== 32) {
      throw new TypeError('topic must be a 32-byte buffer')
    }
    list.push(topic)
  }
  let stopped = false
  const timer = setInterval(() => {
    if (stopped || swarm.destroyed) return
    for (const topic of list) {
      let has = false
      try {
        has = hasPeer(topic)
      } catch (err) {
        log({ event: 'rediscovery-error', topic: b4a.toString(topic, 'hex'), error: err.message })
        continue
      }
      if (has) continue
      const discovery = swarm.status(topic)
      if (!discovery || discovery.destroyed) continue
      try {
        const p = discovery.refresh()
        if (p && typeof p.catch === 'function') {
          p.catch((err) => log({ event: 'rediscovery-error', topic: b4a.toString(topic, 'hex'), error: err.message }))
        }
      } catch (err) {
        log({ event: 'rediscovery-error', topic: b4a.toString(topic, 'hex'), error: err.message })
      }
    }
  }, intervalMs)
  if (timer.unref) timer.unref()
  return function stop () {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
}

function validateHaveEntry (e) {
  return isPlainObject(e) && hasExactKeys(e, ['key', 'length']) && isHex64(e.key) && isLength(e.length)
}

function validateMessage (msg) {
  try {
    if (!isPlainObject(msg)) return false
    switch (msg.type) {
      case 'hello': {
        const isSeeder = msg.role === 'seeder'
        if (!isSeeder && msg.role !== 'member') return false
        const keys = ['type', 'v', 'role', 'count', 'have']
        if (isSeeder) keys.push('cert')
        if (!hasExactKeys(msg, keys)) return false
        if (msg.v !== 1) return false
        if (isSeeder && !isPlainObject(msg.cert)) return false
        if (!Array.isArray(msg.have) || msg.have.length > MAX_HELLO_HAVE) return false
        if (!Number.isSafeInteger(msg.count) || msg.count < msg.have.length) return false
        if (msg.count > MAX_INVENTORY) return false
        return msg.have.every(validateHaveEntry)
      }
      case 'have':
      case 'admitted':
        return hasExactKeys(msg, ['type', 'key', 'length']) && isHex64(msg.key) && isLength(msg.length)
      case 'announce':
        return hasExactKeys(msg, ['type', 'key', 'cert']) && isHex64(msg.key) && isPlainObject(msg.cert)
      case 'rejected':
        return hasExactKeys(msg, ['type', 'key', 'reason']) && isHex64(msg.key) &&
          typeof msg.reason === 'string' && REASON_RE.test(msg.reason)
      default:
        return false
    }
  } catch {
    return false
  }
}

// Token bucket: `burst` tokens, refilled at `rate` per second, on a
// monotonic clock (a wall-clock step must not drain or stall it). take()
// consumes one token when available; force(n) consumes n even into debt (our
// own initial inventory, which the receiver's burst is sized for); waitMs()
// is the time until one token is available.
function tokenBucket (burst, rate) {
  let tokens = burst
  let last = performance.now()
  function refill () {
    const now = performance.now()
    tokens = Math.min(burst, tokens + (now - last) * rate / 1000)
    last = now
  }
  return {
    take () {
      refill()
      if (tokens < 1) return false
      tokens--
      return true
    },
    force (n) {
      refill()
      tokens -= n
    },
    waitMs () {
      refill()
      return tokens >= 1 ? 0 : Math.ceil((1 - tokens) * 1000 / rate)
    }
  }
}

function attachAdmission (socket, opts = {}) {
  if (socket._varandaPeer) return socket._varandaPeer

  const {
    role,
    cert = null,
    have = [],
    onmessage = noop,
    onclose = noop,
    oninventory = noop,
    log = noop,
    helloTimeoutMs = HELLO_TIMEOUT_MS, // injectable for tests
    messageBurst = MESSAGE_BURST, // injectable for tests
    messageRate = MESSAGE_RATE // injectable for tests
  } = opts

  if (role !== 'member' && role !== 'seeder') throw new TypeError('role must be member or seeder')
  if (role === 'seeder' && !isPlainObject(cert)) throw new TypeError('seeder role requires cert')
  if (!Array.isArray(have) || !have.every(validateHaveEntry)) throw new TypeError('invalid have entries')
  // Never send a hello the receiver rejects (count > MAX_INVENTORY).
  if (have.length > MAX_INVENTORY) throw new TypeError('inventory over MAX_INVENTORY')
  if (!(messageBurst >= 1) || !(messageRate > 0)) throw new TypeError('invalid message rate limits')

  const mux = socket && socket.noiseStream ? Hypercore.getProtocolMuxer(socket) : null
  if (!mux) throw new Error('replicate the store before attachAdmission')

  let resolveOpened
  let resolveHello
  let isOpen = false
  let closed = false
  let closeNotified = false
  let inventoryTimer = null
  let helloTimer = null
  let gotHello = false
  let dropped = null // reason the socket was destroyed by a limit
  const inbound = tokenBucket(messageBurst, messageRate)
  const outbound = tokenBucket(
    Math.max(1, messageBurst - Math.ceil(messageBurst / SEND_BURST_MARGIN_DIVISOR)),
    messageRate / SEND_RATE_DIVISOR
  )
  const backlog = [] // paced outgoing messages, in order
  const backlogHave = new Map() // key -> the have in backlog (latest wins)
  let flushTimer = null

  const peer = {
    peerKey: socket.remotePublicKey ? b4a.toString(socket.remotePublicKey, 'hex') : null,
    socket,
    role,
    remoteRole: null,
    remoteCert: null,
    remoteCount: null,
    remoteHave: new Map(),
    inventoryComplete: false,
    badMessages: 0,
    opened: new Promise((resolve) => { resolveOpened = resolve }),
    hello: new Promise((resolve) => { resolveHello = resolve }),
    send,
    close,
    queued: () => backlog.length // our sends waiting (test inspection)
  }

  const channel = mux.createChannel({ protocol: PROTOCOL, onopen, onclose: onchannelclose })
  if (channel === null) throw new Error('duplicate admission channel')

  const message = channel.addMessage({ encoding: c.buffer, onmessage: onraw })

  socket._varandaPeer = peer
  channel.open()
  // The hello timeout runs from here (the channel is opened at once): a
  // peer that never opens the channel is dropped too.
  helloTimer = setTimeout(() => {
    helloTimer = null
    if (!gotHello) drop('hello-timeout')
  }, helloTimeoutMs)
  if (helloTimer.unref) helloTimer.unref()

  return peer

  // A limit was exceeded (S1, S6): the socket is destroyed, which closes the
  // channel (onchannelclose settles the promises and notifies onclose).
  function drop (reason) {
    if (dropped || closed) return
    dropped = reason
    log({ event: 'peer-dropped', peerKey: peer.peerKey, reason })
    socket.destroy()
  }

  function badMessage () {
    peer.badMessages++
    if (peer.badMessages > MAX_BAD_MESSAGES) drop('bad-messages')
  }

  function rawSend (msg) {
    message.send(b4a.from(JSON.stringify(msg), 'utf8'))
  }

  function send (msg) {
    if (closed || !validateMessage(msg)) return false
    pacedSend(msg)
    return true
  }

  // Sends now when the channel is open, the outbound bucket allows and
  // nothing is waiting; otherwise queues in order (also before the channel
  // opens). A have for a key already queued (with no other message for that
  // key after it) only updates the queued length. The queue is bounded.
  function pacedSend (msg) {
    if (msg.type === 'have') {
      const queued = backlogHave.get(msg.key)
      if (queued) {
        queued.length = msg.length
        return
      }
    } else if (typeof msg.key === 'string') {
      backlogHave.delete(msg.key)
    }
    if (isOpen && backlog.length === 0 && outbound.take()) {
      rawSend(msg)
      return
    }
    if (backlog.length >= MAX_SEND_BACKLOG) {
      drop('send-backlog')
      return
    }
    const copy = { ...msg }
    backlog.push(copy)
    if (copy.type === 'have') backlogHave.set(copy.key, copy)
    scheduleFlush()
  }

  function flushBacklog () {
    flushTimer = null
    if (closed || !isOpen) return
    while (backlog.length > 0 && outbound.take()) {
      const msg = backlog.shift()
      if (msg.type === 'have' && backlogHave.get(msg.key) === msg) backlogHave.delete(msg.key)
      rawSend(msg)
    }
    if (backlog.length > 0) scheduleFlush()
  }

  function scheduleFlush () {
    if (flushTimer || closed || !isOpen) return
    flushTimer = setTimeout(flushBacklog, Math.max(1, outbound.waitMs()))
    if (flushTimer.unref) flushTimer.unref()
  }

  function close () {
    channel.close()
  }

  function onopen () {
    if (closed) return
    isOpen = true
    const hello = { type: 'hello', v: 1, role, count: have.length, have: have.slice(0, MAX_HELLO_HAVE) }
    if (role === 'seeder') hello.cert = cert
    rawSend(hello)
    const overflow = have.slice(MAX_HELLO_HAVE)
    for (const e of overflow) rawSend({ type: 'have', key: e.key, length: e.length })
    // The initial inventory fits the receiver's burst by construction.
    outbound.force(1 + overflow.length)
    // Sends made before the channel opened follow the inventory, paced.
    flushBacklog()
    resolveOpened(true)
  }

  // A channel that closes before it opened, or before a valid hello arrived,
  // settles the pending promises (opened -> false, hello -> null); they never
  // reject, so a caller awaiting them treats false/null as "peer gone".
  // The socket is destroyed with it (cycle 3 retry, item 1): a peer that
  // closes only the admission channel must not keep the transport (and its
  // connection slot) without ever being subject to the hello timeout.
  function onchannelclose () {
    closed = true
    isOpen = false
    backlog.length = 0
    backlogHave.clear()
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    clearInventoryTimer()
    if (helloTimer) clearTimeout(helloTimer)
    helloTimer = null
    resolveOpened(false)
    if (!gotHello) resolveHello(null)
    if (!socket.destroyed) socket.destroy()
    if (closeNotified) return
    closeNotified = true
    onclose(peer)
  }

  function clearInventoryTimer () {
    if (inventoryTimer) clearTimeout(inventoryTimer)
    inventoryTimer = null
  }

  function markInventoryComplete () {
    if (peer.inventoryComplete) return
    peer.inventoryComplete = true
    clearInventoryTimer()
    oninventory(peer)
  }

  function checkInventory () {
    if (gotHello && !peer.inventoryComplete && peer.remoteHave.size >= peer.remoteCount) {
      markInventoryComplete()
    }
  }

  // The (single) valid hello starts inventory tracking: a timer bounds the
  // wait for the overflow have messages that follow it.
  function startInventory () {
    peer.inventoryComplete = false
    clearInventoryTimer()
    if (closed) return
    inventoryTimer = setTimeout(() => {
      inventoryTimer = null
      if (peer.inventoryComplete || closed) return
      log({ event: 'inventory-timeout', peerKey: peer.peerKey })
      markInventoryComplete()
    }, INVENTORY_TIMEOUT_MS)
    if (inventoryTimer.unref) inventoryTimer.unref()
  }

  function onraw (buf) {
    if (closed || dropped) return
    let msg
    try {
      if (!buf || buf.byteLength === 0 || buf.byteLength > MAX_PAYLOAD) {
        badMessage()
        return
      }
      msg = JSON.parse(b4a.toString(buf, 'utf8'))
    } catch {
      badMessage()
      return
    }
    if (!validateMessage(msg)) {
      badMessage()
      return
    }
    // Every valid message costs one token (H1): repeating a known
    // advertisement never grows remoteHave nor counts as bad, so it is
    // bounded here.
    if (!inbound.take()) {
      drop('message-rate')
      return
    }

    if (msg.type === 'hello') {
      // Exactly one hello per connection (S6): a second one is a protocol
      // violation (our side sends exactly one, in onopen).
      if (gotHello) {
        drop('duplicate-hello')
        return
      }
      peer.remoteRole = msg.role
      peer.remoteCert = msg.role === 'seeder' ? msg.cert : null
      peer.remoteCount = msg.count
      peer.remoteHave = new Map()
      for (const e of msg.have) peer.remoteHave.set(e.key, e.length)
      gotHello = true
      if (helloTimer) clearTimeout(helloTimer)
      helloTimer = null
      resolveHello(msg)
      startInventory()
      // The hello is dispatched BEFORE its inventory can complete, so the
      // caller has updated its per-peer state (role, verified seeder) by the
      // time oninventory fires for it.
      onmessage(msg, peer)
      checkInventory()
      return
    } else if (msg.type === 'have' || msg.type === 'admitted') {
      // Only seeders admit (S2): an admitted from any other role is a bad
      // message and never touches remoteHave.
      if (msg.type === 'admitted' && peer.remoteRole !== 'seeder') {
        badMessage()
        return
      }
      // Bounded per-peer state (S1): a new key beyond MAX_INVENTORY distinct
      // keys disconnects the peer; the map never exceeds the cap.
      if (!peer.remoteHave.has(msg.key) && peer.remoteHave.size >= MAX_INVENTORY) {
        drop('inventory-limit')
        return
      }
      peer.remoteHave.set(msg.key, msg.length)
      // Dispatched BEFORE the completion check (same rule as the hello), so
      // the caller has recorded this advertisement when oninventory fires.
      onmessage(msg, peer)
      checkInventory()
      return
    } else if (msg.type === 'rejected') {
      peer.remoteHave.delete(msg.key)
    }

    onmessage(msg, peer)
  }
}

function watchContiguous (core, onGrow) {
  let last = core.contiguousLength
  const check = () => {
    const len = core.contiguousLength
    if (len > last) {
      last = len
      onGrow(len)
    }
  }
  core.on('append', check)
  core.on('download', check)
  return function stop () {
    core.off('append', check)
    core.off('download', check)
  }
}

function watchFork (core, onFork) {
  let fired = false
  const handler = () => {
    if (fired) return
    fired = true
    onFork('fork')
  }
  core.on('truncate', handler)
  core.on('conflict', handler)
  return function stop () {
    core.off('truncate', handler)
    core.off('conflict', handler)
  }
}

// Starts a block-0 fetch through the quarantine store, attached to the given
// sockets, and returns { promise, addSocket }. addSocket(socket) attaches one
// more peer (an advertiser that arrived while the fetch is in flight) to the
// same quarantine core and returns true; it returns false once the fetch has
// settled (the core is being purged) or for a socket already attached.
// The result also carries the signed `length` and `byteLength` the quarantine
// core learned with block 0 (the upgrade proof of the fetch), so the caller
// can apply the log quota (S3) before anything is opened in the main store.
function startQuarantineFetch (qstore, keyHex, sockets, timeoutMs) {
  if (!Array.isArray(sockets) || sockets.length === 0) {
    throw new TypeError('startQuarantineFetch requires at least one socket')
  }
  const core = qstore.get({ key: b4a.from(keyHex, 'hex') })
  const attached = new Set()
  let settled = false
  const promise = (async () => {
    try {
      await core.ready()
      for (const s of sockets) addSocket(s)
      let raw = null
      try {
        raw = await core.get(0, { raw: true, timeout: timeoutMs })
      } catch {
        return { raw: null, error: 'timeout', length: 0, byteLength: 0 }
      }
      if (raw === null) return { raw: null, error: 'timeout', length: 0, byteLength: 0 }
      return { raw, error: null, length: core.length, byteLength: core.byteLength }
    } finally {
      settled = true
      await core.purge()
    }
  })()
  function addSocket (socket) {
    if (settled || attached.has(socket)) return false
    attached.add(socket)
    core.replicate(socket)
    return true
  }
  return { promise, addSocket }
}

async function quarantineGet0 (qstore, keyHex, sockets, timeoutMs) {
  return startQuarantineFetch(qstore, keyHex, sockets, timeoutMs).promise
}

module.exports = {
  PROTOCOL,
  MAX_PAYLOAD,
  MAX_HELLO_HAVE,
  INVENTORY_TIMEOUT_MS,
  MAX_INVENTORY,
  MAX_BAD_MESSAGES,
  HELLO_TIMEOUT_MS,
  MAX_CONNECTIONS,
  MESSAGE_BURST,
  MESSAGE_RATE,
  MAX_SEND_BACKLOG,
  topicFor,
  parseBootstrap,
  generateNoiseKeyPair,
  createSwarm,
  refuseOverConnectionLimit,
  joinAndFlush,
  startRediscovery,
  attachAdmission,
  validateMessage,
  watchContiguous,
  watchFork,
  startQuarantineFetch,
  quarantineGet0
}
