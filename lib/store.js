'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const b4a = require('b4a')
const Corestore = require('corestore')
const { validateRecord, decodeBlock, MAX_BLOCK_BYTES, MAX_LOG_BLOCKS, MAX_LOG_BYTES } = require('./records')

// Private directory: created 0o700 and tightened to 0o700 when it exists.
// Follows symlinks: the data dir itself may be a symlink the user chose.
function privateDir (dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

// <dataDir>/store holds the Corestore primary key: a symlink there is
// refused (checked with lstat before and after the mkdir, so a link is never
// followed by the chmod), as is anything that is not a real directory.
function privateStoreDir (dir) {
  const refuse = () => {
    const err = new Error('store/ não é um diretório (link simbólico recusado): ' + dir)
    err.code = 'STORE_INVALID'
    return err
  }
  const check = () => {
    try {
      if (!fs.lstatSync(dir).isDirectory()) throw refuse()
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
  check()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  check()
  fs.chmodSync(dir, 0o700)
}

const LOCK_DIR = '.somos-lock'
const LOCK_PID = 'pid'
// A lock dir without a readable owner may be a peer between its mkdir and
// its owner write. It is stale only once the lock dir's own mtime is older
// than LOCK_GRACE_MS (measured from the directory, never from our call), so
// a lock another process created a moment ago is never taken over. Before
// giving up with LOCKED, a young owner-less lock is re-read for up to
// LOCK_WAIT_MS in case its owner publishes meanwhile.
const LOCK_GRACE_MS = 10000
const LOCK_WAIT_MS = 1000
// lockDir -> the owner token this process wrote into it.
const heldLocks = new Map()
let exitHookArmed = false

function lockedError () {
  const err = new Error('diretório de dados em uso')
  err.code = 'LOCKED'
  return err
}

function invalidLockError (lockDir) {
  const err = new Error('lock inválido (não é um diretório): ' + lockDir)
  err.code = 'LOCK_INVALID'
  return err
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Whether a lock pid can be a live owner. EPERM means the process belongs to
// another user: the data dir is 0o700 and ours, so such a process cannot own
// this lock and the lock is stale. Residual risk: a dead owner's pid reused
// by a live process of the same user reads as alive, and the lock then stays
// LOCKED until the user removes <dataDir>/.somos-lock by hand (README).
function pidAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The owner file holds `<pid> <token>` (token: 32 random hex). A bare pid
// (older format) still names a live or dead owner, without a token.
function parseOwner (raw) {
  const m = /^([1-9][0-9]{0,9})(?: ([0-9a-f]{32}))?$/.exec(raw === null ? '' : raw.trim())
  return m ? { pid: Number(m[1]), token: m[2] || null } : { pid: null, token: null }
}

function readOwnerRaw (lockDir) {
  try {
    return fs.readFileSync(path.join(lockDir, LOCK_PID), 'utf8')
  } catch {
    return null
  }
}

function readLockToken (lockDir) {
  return parseOwner(readOwnerRaw(lockDir)).token
}

// Snapshot of a lock dir: its identity (dev, ino), its mtime and the exact
// owner-file content. null when the lock path does not exist. Never follows
// a symlink: a lock path that is not a real directory (symlink, file,
// anything else) throws LOCK_INVALID.
function inspectLock (lockDir) {
  let st = null
  try {
    st = fs.lstatSync(lockDir)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  if (!st.isDirectory()) throw invalidLockError(lockDir)
  const raw = readOwnerRaw(lockDir)
  return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, raw, ...parseOwner(raw) }
}

function sameLock (a, b) {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino && a.raw === b.raw
}

// Published by rename, so a reader never sees a partial owner. The temp
// name carries our token, so a failure only ever unlinks our own file.
function writeLockOwner (lockDir, token) {
  const tmp = path.join(lockDir, LOCK_PID + '.' + token + '.tmp')
  try {
    fs.writeFileSync(tmp, process.pid + ' ' + token + '\n', { mode: 0o600, flag: 'wx' })
    fs.renameSync(tmp, path.join(lockDir, LOCK_PID))
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
}

// Removes the lock dir only when the token read back from it is ours.
function removeIfOurs (lockDir, token) {
  try {
    if (readLockToken(lockDir) === token) fs.rmSync(lockDir, { recursive: true, force: true })
  } catch {}
}

// Releases one acquisition: only the given token, never whatever token is
// current for the path (a later opener's lock is not ours to remove).
// Synchronous, so it also runs from the process 'exit' hook.
function releaseLock (lockDir, token) {
  if (heldLocks.get(lockDir) === token) heldLocks.delete(lockDir)
  removeIfOurs(lockDir, token)
}

function releaseAllLocks () {
  for (const [lockDir, token] of [...heldLocks]) releaseLock(lockDir, token)
}

// Takeover mutex: <lockDir>.takeover, a file created exclusively holding our
// token. Only its holder moves a stale lock, so two processes recovering the
// same stale lock never move each other's fresh lock. A mutex left by a
// crashed holder is removed once its mtime is LOCK_GRACE_MS old (and only if
// its content is still what was read).
function tryMutex (mutex, token) {
  try {
    fs.writeFileSync(mutex, token, { flag: 'wx', mode: 0o600 })
    return true
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  try {
    const raw = fs.readFileSync(mutex, 'utf8')
    if (Date.now() - fs.statSync(mutex).mtimeMs >= LOCK_GRACE_MS && fs.readFileSync(mutex, 'utf8') === raw) {
      fs.unlinkSync(mutex)
    }
  } catch {}
  return false
}

function releaseMutex (mutex, token) {
  try {
    if (fs.readFileSync(mutex, 'utf8') === token) fs.unlinkSync(mutex)
  } catch {}
}

// Under the takeover mutex, re-checks that lockDir is still exactly the lock
// inspected as stale (same dir identity, same owner content), moves it aside
// (atomic rename) and deletes the aside copy only if it is still that exact
// stale lock. Anything else (e.g. a hung pid-less owner that published while
// we moved it) is renamed back, and the caller re-inspects. If renaming it
// back fails (a racer already made a new lock dir), the moved lock is never
// deleted: it stays at <lockDir>.stale-<hex> and we throw LOCKED. Its owner,
// if alive, keeps running; its release is then a no-op (the token at lockDir
// is not its own) and the RocksDB lock of store/ is the backstop. Returns
// false when another process holds the mutex (the caller waits and retries).
function takeOverLock (lockDir, stale, token) {
  const mutex = lockDir + '.takeover'
  if (!tryMutex(mutex, token)) return false
  try {
    if (!sameLock(inspectLock(lockDir), stale)) return true
    const aside = lockDir + '.stale-' + crypto.randomBytes(6).toString('hex')
    try {
      fs.renameSync(lockDir, aside)
    } catch (err) {
      if (err.code === 'ENOENT') return true
      throw err
    }
    if (sameLock(inspectLock(aside), stale)) {
      fs.rmSync(aside, { recursive: true, force: true })
      return true
    }
    try {
      fs.renameSync(aside, lockDir)
    } catch {
      throw lockedError()
    }
    return true
  } finally {
    releaseMutex(mutex, token)
  }
}

// Exclusive data-dir lock: an atomic mkdir of <dataDir>/.somos-lock holding
// `<pid> <token>`. A live owner (this process included) means LOCKED; a dead
// owner (or another user's pid) is taken over; a missing or garbage owner is
// taken over only once the lock dir's mtime is LOCK_GRACE_MS in the past (or
// more than LOCK_GRACE_MS in the future: clock skew), else LOCKED after
// LOCK_WAIT_MS. A lock path that is not a real directory is LOCK_INVALID at
// once. Returns { lockDir, token } for this acquisition.
async function acquireLock (dataDir) {
  const lockDir = path.join(dataDir, LOCK_DIR)
  const token = crypto.randomBytes(16).toString('hex')
  const waitUntil = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 })
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const info = inspectLock(lockDir)
      if (info === null) {
        // Removed between our mkdir and our lstat: yield, then retry.
        await sleep(10)
        continue
      }
      if (info.pid !== null && pidAlive(info.pid)) throw lockedError()
      const age = Date.now() - info.mtimeMs
      if (info.pid === null && age < LOCK_GRACE_MS && age > -LOCK_GRACE_MS) {
        if (Date.now() >= waitUntil) throw lockedError()
        await sleep(50)
        continue
      }
      if (!takeOverLock(lockDir, info, token)) await sleep(20)
      continue
    }
    try {
      writeLockOwner(lockDir, token)
    } catch (err) {
      // Never removes a lock that is not ours: our owner-less dir is left
      // and ages out after LOCK_GRACE_MS like any crash leftover.
      removeIfOurs(lockDir, token)
      throw err
    }
    if (readLockToken(lockDir) !== token) throw lockedError()
    heldLocks.set(lockDir, token)
    if (!exitHookArmed) {
      exitHookArmed = true
      process.on('exit', releaseAllLocks)
    }
    return { lockDir, token }
  }
}

// The data directory is single-process: openStore takes the data-dir lock
// BEFORE the Corestore (and its RocksDB) is constructed, so a second opener
// fails with LOCKED without touching <dataDir>/store. The lock is released
// when the store closes successfully, or synchronously on process exit. If
// the Corestore close fails, the lock stays held (the exit hook still
// releases it) and the error propagates. dataDir and <dataDir>/store are
// private (0o700): the Corestore primary key, from which the diary signing
// key derives, lives under <dataDir>/store (a symlink there is refused).
// Each openStore releases only its own acquisition (its token), at most
// once: closing a store again after a later openStore took the lock never
// touches that later lock.
async function openStore (dataDir) {
  privateDir(dataDir)
  const { lockDir, token } = await acquireLock(dataDir)
  let released = false
  const release = () => {
    if (released) return
    released = true
    releaseLock(lockDir, token)
  }
  let store = null
  try {
    privateStoreDir(path.join(dataDir, 'store'))
    store = new Corestore(path.join(dataDir, 'store'))
    await store.ready()
  } catch (err) {
    let closed = true
    if (store !== null) {
      try { await store.close() } catch { closed = false }
    }
    // A failed close keeps the lock (released on exit); the ready() failure
    // is what gets rethrown either way.
    if (closed) release()
    throw err
  }
  const close = store.close.bind(store)
  store.close = async function (...args) {
    const result = await close(...args)
    release()
    return result
  }
  return store
}

function storeExists (dataDir) {
  return fs.existsSync(path.join(dataDir, 'store'))
}

async function openDiary (store) {
  const core = store.get({ name: 'diary', valueEncoding: 'json' })
  await core.ready()
  return core
}

// Replicas are always read-only sessions: `writable: false` makes hypercore
// mark the session read-only (_readonly), even for a key whose secret this
// store holds (the own diary). The check below is a defensive backstop.
// allowFork is never passed (hypercore default true, see protocol R5.9).
async function openReplica (store, hex) {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('chave inválida')
  const core = store.get({ key: b4a.from(hex.toLowerCase(), 'hex'), valueEncoding: 'json', writable: false })
  await core.ready()
  if (core.writable) {
    await core.close()
    throw new Error('chave do próprio diário')
  }
  return core
}

// Quarantine store: block-0 fetches only, wiped at open, never state.
async function openQuarantine (dataDir) {
  const dir = path.join(dataDir, 'quarantine')
  fs.rmSync(dir, { recursive: true, force: true })
  const qstore = new Corestore(dir)
  await qstore.ready()
  return qstore
}

function removeQuarantine (dataDir) {
  try {
    fs.rmSync(path.join(dataDir, 'quarantine'), { recursive: true, force: true })
  } catch {}
}

// Fresh session, so it also works after hypercore closed the key's sessions
// on a conflict.
async function purgeReplica (store, hex) {
  const c = store.get({ key: b4a.from(hex.toLowerCase(), 'hex') })
  await c.ready()
  await c.purge()
}

// Only a decode failure becomes { seq, record: null } (decodeBlock never
// throws); an error from core.get itself (closed session, storage error)
// propagates to the caller. A closed session reports contiguousLength 0, so
// it is rejected explicitly instead of looking like an empty log.
async function readAll (core) {
  if (core.closing) {
    const err = new Error('SESSION_CLOSED: cannot read from a closed session')
    err.code = 'SESSION_CLOSED'
    throw err
  }
  const entries = []
  for (let i = 0; i < core.contiguousLength; i++) {
    const block = await core.get(i, { wait: false, raw: true })
    entries.push({ seq: i, record: decodeBlock(block) })
  }
  return entries
}

function invalidRecord (reason) {
  const err = new Error('registro inválido: ' + reason)
  err.code = 'INVALID_RECORD'
  return err
}

// Storage limits of the own diary (lib/records.js). `limits` (optional,
// per field) only exists so tests can use small values.
const DEFAULT_LIMITS = Object.freeze({
  maxBlockBytes: MAX_BLOCK_BYTES,
  maxLogBlocks: MAX_LOG_BLOCKS,
  maxLogBytes: MAX_LOG_BYTES
})

// Per-core append queue, keyed by the shared underlying core (session.core,
// known once the session is ready), so every session of the same log in this
// process is serialized: validation and append of one call complete before
// the next call computes its seq.
const appendQueues = new WeakMap()

async function appendRecord (core, record, limits) {
  await core.ready()
  const queueKey = core.core !== null && typeof core.core === 'object' ? core.core : core
  const prev = appendQueues.get(queueKey) || Promise.resolve()
  const run = () => appendNow(core, record, { ...DEFAULT_LIMITS, ...limits })
  const next = prev.then(run, run)
  appendQueues.set(queueKey, next.catch(() => {}))
  return next
}

async function appendNow (core, record, limits) {
  await core.ready()
  // Validate and append a plain clone: the exact value that gets encoded,
  // so toJSON or accessors cannot change it after validation.
  let plain = null
  try {
    plain = decodeBlock(b4a.from(JSON.stringify(record)))
  } catch {}
  if (plain === null) throw invalidRecord('malformed')
  const reason = validateRecord(plain, core.length)
  if (reason) throw invalidRecord(reason)
  // The json value encoding stores JSON.stringify(plain); core.byteLength is
  // the byte total of the log so far.
  const blockBytes = b4a.byteLength(JSON.stringify(plain))
  if (blockBytes > limits.maxBlockBytes ||
      core.length >= limits.maxLogBlocks ||
      core.byteLength + blockBytes > limits.maxLogBytes) {
    throw new Error('limite do diário atingido')
  }
  await core.append(plain)
  return core.length - 1
}

function readJson (file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw err
  }
}

// Atomic publish through a unique temporary name in the same directory
// (`.<base>.<pid>.<random>.tmp`), created exclusively (O_EXCL) and never
// through a symlink (O_NOFOLLOW), fsynced, then renamed over the target, and
// the parent directory is fsynced so the rename survives a crash. Two
// concurrent writers (even across processes) each use their own temp file,
// so both succeed and the last rename wins; a failure unlinks the temp file.
function writeJsonAtomic (file, obj, mode) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp')
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode === undefined ? 0o666 : mode)
  let published = false
  try {
    try {
      if (mode !== undefined) fs.fchmodSync(fd, mode)
      fs.writeFileSync(fd, JSON.stringify(obj, null, 2) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
    published = true
  } finally {
    if (!published) {
      try { fs.unlinkSync(tmp) } catch {}
    }
  }
  fsyncDir(dir)
}

// Makes a just-renamed directory entry durable (as lib/cert.js does).
// Platforms that cannot open or fsync a directory fail with EISDIR, EPERM or
// EINVAL: only those are ignored; any other error propagates.
const FSYNC_DIR_IGNORED = new Set(['EISDIR', 'EPERM', 'EINVAL'])

function fsyncDir (dir) {
  let fd
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY)
    fs.fsyncSync(fd)
  } catch (err) {
    if (!FSYNC_DIR_IGNORED.has(err.code)) throw err
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

function readConfig (dataDir) {
  return readJson(path.join(dataDir, 'config.json'), null)
}

function writeConfig (dataDir, config) {
  writeJsonAtomic(path.join(dataDir, 'config.json'), config)
}

function readFollows (dataDir) {
  const data = readJson(path.join(dataDir, 'follows.json'), null)
  return data && Array.isArray(data.follows) ? data.follows : []
}

function writeFollows (dataDir, list) {
  const follows = [...new Set(list.map((k) => k.toLowerCase()))].sort()
  writeJsonAtomic(path.join(dataDir, 'follows.json'), { v: 1, follows })
}

module.exports = {
  openStore,
  storeExists,
  openDiary,
  openReplica,
  openQuarantine,
  removeQuarantine,
  purgeReplica,
  readAll,
  appendRecord,
  readConfig,
  writeConfig,
  readFollows,
  writeFollows,
  readJson,
  writeJsonAtomic
}
