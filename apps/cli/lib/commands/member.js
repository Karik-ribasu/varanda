'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const util = require('node:util')
const b4a = require('b4a')
const { discoveryKey } = require('hypercore-crypto')
const { certForKey } = require('@varanda/core/lib/cert')
const {
  decodeBlock,
  memberCertRecord,
  profileRecord,
  postRecord,
  validateRecord,
  formatRef
} = require('@varanda/core/lib/records')
const { MAX_INVENTORY } = require('@varanda/core/lib/net')
const {
  openStore,
  storeExists,
  openDiary,
  openReplica,
  purgeReplica,
  readAll,
  appendRecord,
  readConfig,
  readFollows,
  writeFollows
} = require('@varanda/core/lib/store')
const { buildFeed, shortKey, formatFeedItem } = require('@varanda/core/lib/feed')
const { safe, jsonLine } = require('@varanda/core/lib/safe')

const HEX64 = /^[0-9a-fA-F]{64}$/
const GENESIS_REQUIRED = 'grave o certificado de membro antes de publicar'

function usage (message) {
  const err = new Error(message)
  err.code = 'USAGE'
  return err
}

function print (flags, result, line) {
  process.stdout.write((flags.json ? jsonLine(result) : line) + '\n')
}

function warn (line) {
  process.stderr.write(line + '\n')
}

function hex (key) {
  return b4a.toString(key, 'hex')
}

// The trust root is fixed by `id create` and read from config.json only.
function trustRoot (flags) {
  const config = readConfig(flags.dataDir)
  if (config === null) throw new Error('identidade não encontrada')
  if (config.role !== 'member') throw new Error('diretório não é de um membro')
  if (flags.association && flags.association !== config.association) {
    throw new Error('associação diferente da configurada')
  }
  return config.association
}

// Opens the store and the diary, runs fn and always closes the store.
async function withIdentity (flags, fn) {
  const association = trustRoot(flags)
  const store = await openStore(flags.dataDir)
  try {
    const diary = await openDiary(store)
    return await fn({ store, diary, ownHex: hex(diary.key), association })
  } finally {
    await store.close()
  }
}

function subOf (flags, expected, message) {
  const sub = flags.positionals[0]
  if (sub !== expected && !(Array.isArray(expected) && expected.includes(sub))) throw usage(message)
  return sub
}

// ---- id ----

// Publishes config.json only when it does not exist yet: a unique temp file
// hard-linked into place, so a concurrent writer can never be clobbered.
// Returns false when another process published first (EEXIST).
function publishConfig (dataDir, config) {
  const file = path.join(dataDir, 'config.json')
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp'
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.linkSync(tmp, file)
    } catch (err) {
      if (err.code === 'EEXIST') return false
      throw err
    }
    fsyncDir(path.dirname(file))
    return true
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

// Makes the new directory entry durable; only the errors of platforms that
// cannot open or fsync a directory are ignored (as lib/store.js does).
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

// Called with the store lock held: reads or fixes the trust root once.
function ensureMemberConfig (flags) {
  let config = readConfig(flags.dataDir)
  if (config === null) {
    if (!flags.association) throw usage('informe --association ou VARANDA_ASSOCIATION')
    const fresh = { v: 1, role: 'member', association: flags.association }
    if (publishConfig(flags.dataDir, fresh)) return fresh
    config = readConfig(flags.dataDir)
  }
  if (config.role !== 'member') throw new Error('diretório não é de um membro')
  if (flags.association && flags.association !== config.association) {
    throw new Error('associação diferente da configurada')
  }
  return config
}

async function idRun (flags) {
  const sub = flags.positionals[0]
  if (sub === 'create') {
    // Fail fast on usage before touching the data dir; re-checked under the lock.
    if (!flags.association && readConfig(flags.dataDir) === null) {
      throw usage('informe --association ou VARANDA_ASSOCIATION')
    }
    // The store's RocksDB lock is taken FIRST, so config.json is only ever
    // read and written by the single process that holds the data dir.
    const store = await openStore(flags.dataDir)
    try {
      const config = ensureMemberConfig(flags)
      const diary = await openDiary(store)
      const publicKey = hex(diary.key)
      print(flags, { publicKey, association: config.association }, 'chave pública: ' + publicKey)
    } finally {
      await store.close()
    }
  } else if (sub === 'show') {
    if (readConfig(flags.dataDir) === null || !storeExists(flags.dataDir)) {
      throw new Error('identidade não encontrada')
    }
    await withIdentity(flags, ({ ownHex, association }) => {
      print(flags, { publicKey: ownHex, association }, 'chave pública: ' + ownHex)
    })
  } else {
    throw usage('node bin/varanda.js id create|show')
  }
}

// ---- cert ----

function readCertFile (file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error('não foi possível ler ' + file)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('certificado inválido (malformed)')
  }
}

async function certRun (flags) {
  subOf(flags, 'add', 'node bin/varanda.js cert add')
  if (!flags.certFile) throw usage('informe --cert-file <arquivo>')
  const association = trustRoot(flags)
  const cert = readCertFile(flags.certFile)
  await withIdentity(flags, async ({ diary, ownHex }) => {
    const r = certForKey(cert, ownHex, association)
    if (!r.ok) throw new Error('certificado inválido (' + r.reason + ')')
    if (diary.length > 0) {
      const block0 = decodeBlock(await diary.get(0, { wait: false, raw: true }))
      if (!util.isDeepStrictEqual(block0, { type: 'member-cert', cert })) {
        throw new Error('certificado já gravado')
      }
      print(flags, { seq: 0 }, 'certificado gravado (bloco 0)')
      return
    }
    await appendRecord(diary, memberCertRecord(cert))
    print(flags, { seq: 0 }, 'certificado gravado (bloco 0)')
  })
}

// ---- profile / post / reply ----

// Builds the record before opening anything; record validation errors are
// user-facing failures, not crashes.
function buildRecord (make) {
  try {
    return make()
  } catch (err) {
    throw new Error('registro inválido: ' + err.message)
  }
}

async function publish (flags, record) {
  return withIdentity(flags, async ({ diary, ownHex }) => {
    if (diary.length === 0) throw new Error(GENESIS_REQUIRED)
    try {
      const seq = await appendRecord(diary, record)
      return { seq, ref: formatRef({ author: ownHex, seq }) }
    } catch (err) {
      if (err.code === 'INVALID_RECORD' && /genesis-required/.test(err.message)) throw new Error(GENESIS_REQUIRED)
      throw err
    }
  })
}

async function profileRun (flags) {
  subOf(flags, 'set', 'node bin/varanda.js profile set')
  if (flags.name === null) throw usage('informe --name <nome>')
  const record = buildRecord(() => profileRecord({ name: flags.name, bio: flags.bio || '' }))
  const { seq } = await publish(flags, record)
  print(flags, { seq }, 'perfil atualizado #' + seq)
}

async function publishPost (flags, record) {
  const result = await publish(flags, record)
  print(flags, result, 'publicado #' + result.seq)
}

async function postRun (flags) {
  if (flags.text === null) throw usage('informe --text <texto>')
  await publishPost(flags, buildRecord(() => postRecord({ text: flags.text })))
}

async function replyRun (flags) {
  if (!flags.to || flags.text === null) throw usage('informe --to <chave>:<seq> e --text <texto>')
  if (!(flags.to.seq >= 1)) throw usage('referência inválida')
  await publishPost(flags, buildRecord(() => postRecord({ text: flags.text, replyTo: flags.to })))
}

// ---- follows ----

async function followRun (flags, follow) {
  if (!flags.author) throw usage('informe --author <hex>')
  const result = await withIdentity(flags, ({ ownHex }) => {
    if (flags.author === ownHex) throw new Error('não é possível seguir a própria chave')
    const current = readFollows(flags.dataDir)
    const has = current.includes(flags.author)
    if (follow === has) return { follows: current, changed: false }
    // The inventory (own diary + follows) must fit a hello (MAX_INVENTORY).
    if (follow && current.length >= MAX_INVENTORY - 1) throw new Error('limite de diários seguidos atingido')
    const next = follow ? [...current, flags.author] : current.filter((k) => k !== flags.author)
    writeFollows(flags.dataDir, next)
    return { follows: readFollows(flags.dataDir), changed: true }
  })
  let line
  if (follow) line = result.changed ? 'seguindo ' + flags.author : 'já seguindo'
  else line = result.changed ? 'deixou de seguir ' + flags.author : 'não seguia'
  print(flags, result, line)
}

async function followsRun (flags) {
  trustRoot(flags)
  const follows = readFollows(flags.dataDir)
  print(flags, { follows }, follows.join('\n'))
}

// ---- log ----

async function logRun (flags) {
  let key
  let entries
  if (!flags.author) {
    ;({ key, entries } = await withIdentity(flags, async ({ diary, ownHex }) => ({
      key: ownHex,
      entries: await readAll(diary)
    })))
  } else {
    trustRoot(flags)
    const store = await openStore(flags.dataDir)
    try {
      const diary = await openDiary(store)
      key = flags.author
      if (key === hex(diary.key)) {
        entries = await readAll(diary)
      } else {
        // Never create a core for a key with no local data (D).
        if (!HEX64.test(key) || !(await store.storage.hasCore(discoveryKey(b4a.from(key.toLowerCase(), 'hex'))))) {
          throw new Error('sem dados locais para este diário')
        }
        const replica = await openReplica(store, key)
        entries = await readAll(replica)
        // An empty core must not linger in the main store.
        if (replica.contiguousLength === 0) await purgeReplica(store, key)
      }
    } finally {
      await store.close()
    }
  }
  for (const entry of entries) process.stdout.write(jsonLine({ seq: entry.seq, record: entry.record }) + '\n')
  if (flags.json) process.stdout.write(jsonLine({ key, entries }) + '\n')
}

// ---- feed ----

// Reason a followed log is not shown, or null when it is kept.
function skipReason (core, entries, key, association) {
  if (core.fork !== 0) return 'fork'
  if (entries.length === 0) return 'no-cert'
  const first = entries[0].record
  if (validateRecord(first, 0) !== null) return 'not-in-log'
  const r = certForKey(first.cert, key, association)
  return r.ok ? null : r.reason
}

function skipLog (skippedLogs, key, reason) {
  skippedLogs.push({ key, reason })
  warn('aviso: diário ' + shortKey(key) + ' ignorado (' + safe(reason) + ')')
}

async function feedRun (flags) {
  const { items, skipped, future } = await withIdentity(flags, async ({ store, diary, ownHex, association }) => {
    const kept = [{ key: ownHex, entries: await readAll(diary) }]
    const skippedLogs = []
    const seen = new Set([ownHex])
    for (const raw of readFollows(flags.dataDir)) {
      // Entries are hand-editable: skip the own key, bad entries and duplicates.
      if (typeof raw !== 'string' || !HEX64.test(raw)) {
        warn('aviso: entrada inválida em follows.json ignorada (' + safe(String(raw).slice(0, 80)) + ')')
        continue
      }
      const key = raw.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      // Never create a core for a key with no local data (R5.4 a).
      if (!(await store.storage.hasCore(discoveryKey(b4a.from(key, 'hex'))))) {
        skipLog(skippedLogs, key, 'no-cert')
        continue
      }
      const replica = await openReplica(store, key)
      const entries = await readAll(replica)
      // The reason (fork check included) is computed BEFORE an empty core is
      // purged, so an empty forked replica is still reported 'fork'.
      const reason = skipReason(replica, entries, key, association)
      // An empty core must not linger in the main store.
      if (replica.contiguousLength === 0) await purgeReplica(store, key)
      if (reason === null) {
        kept.push({ key, entries })
      } else {
        skipLog(skippedLogs, key, reason)
      }
    }
    const built = buildFeed({ logs: kept, limit: flags.limit || Infinity })
    for (const ref of built.future) warn('aviso: publicação ' + ref + ' ignorada (future)')
    return { items: built.items, skipped: skippedLogs, future: built.future }
  })
  if (flags.json) {
    process.stdout.write(jsonLine({ items, skipped, future }) + '\n')
  } else {
    const width = feedWidth(process.stdout)
    for (const item of items) process.stdout.write(formatFeedItem(item, { width }) + '\n')
  }
}

// Wrap width of the human feed: the terminal width on a TTY, otherwise 80
// (scripts should use --json, which is never wrapped). Floor of 20.
function feedWidth (stream) {
  const cols = stream.isTTY ? Number(stream.columns) : 80
  return Math.max(20, Number.isFinite(cols) && cols > 0 ? cols : 80)
}

module.exports = {
  publishConfig,
  feedWidth,
  commands: {
    id: { summary: 'identidade (chave pública do diário)', run: idRun },
    cert: { summary: 'grava o certificado como bloco 0 do diário', run: certRun },
    profile: { summary: 'define nome e bio', run: profileRun },
    post: { summary: 'publica um texto (--text)', run: postRun },
    reply: { summary: 'responde a uma publicação (--to <chave>:<seq> --text)', run: replyRun },
    follow: { summary: 'segue uma chave pública', run: (flags) => followRun(flags, true) },
    unfollow: { summary: 'deixa de seguir uma chave pública', run: (flags) => followRun(flags, false) },
    follows: { summary: 'lista as chaves seguidas', run: followsRun },
    log: { summary: 'mostra os blocos locais de um diário', run: logRun },
    feed: { summary: 'feed com as publicações dos diários seguidos', run: feedRun }
  }
}
