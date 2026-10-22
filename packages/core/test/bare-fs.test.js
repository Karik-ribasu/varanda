'use strict'

// lib/bare/fs-facade.js driven on Node with a fake backend that behaves like
// bare-fs 4.8.4: path-only readFileSync/writeFileSync (a numeric fd is a
// path), string flags without exclusivity ('wx' = 'w'), no O_EXCL,
// O_NOFOLLOW or O_NONBLOCK constants, and FileError-like errors.
const test = require('brittle')
const nodeFs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createFs } = require('../lib/bare/fs-facade')
const { tmpDir } = require('./helpers/tmp')

const REAL = ['O_RDONLY', 'O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_TRUNC', 'O_APPEND']

// bare-fs toFlags: no O_EXCL (undefined | x = x), unknown string -> 0.
function bareToFlags (c, flags) {
  switch (flags) {
    case 'r': return c.O_RDONLY
    case 'r+': return c.O_RDWR
    case 'w': case 'wx': case 'xw': return c.O_TRUNC | c.O_CREAT | c.O_WRONLY
    case 'w+': case 'wx+': case 'xw+': return c.O_TRUNC | c.O_CREAT | c.O_RDWR
    case 'a': case 'ax': case 'xa': return c.O_APPEND | c.O_CREAT | c.O_WRONLY
    case 'a+': case 'ax+': case 'xa+': return c.O_APPEND | c.O_CREAT | c.O_RDWR
    default: return 0
  }
}

function fakeBackend ({ extraConstants = {} } = {}) {
  const constants = {}
  for (const name of REAL) constants[name] = nodeFs.constants[name]
  for (const name of ['S_IFMT', 'S_IFREG', 'S_IFDIR', 'S_IFLNK', 'S_IFIFO', 'S_IFSOCK']) constants[name] = nodeFs.constants[name]
  Object.assign(constants, extraConstants)
  let realMask = 0
  for (const [name, value] of Object.entries(constants)) if (name.startsWith('O_')) realMask |= value
  const opens = []
  const backend = {
    constants,
    opens,
    realMask,
    openSync (filepath, flags = 'r', mode = 0o666) {
      opens.push({ filepath, flags, mode })
      if (typeof flags === 'string') flags = bareToFlags(constants, flags)
      return nodeFs.openSync(filepath, flags, mode)
    },
    // Path only: a number is a path named after it (bare-fs behaviour).
    readFileSync (filepath, opts) {
      return nodeFs.readFileSync(String(filepath), opts)
    },
    writeFileSync (filepath, data, opts) {
      return nodeFs.writeFileSync(String(filepath), data, opts)
    }
  }
  for (const name of ['closeSync', 'readSync', 'writeSync', 'fstatSync', 'lstatSync', 'statSync', 'mkdirSync',
    'unlinkSync', 'symlinkSync', 'renameSync', 'rmSync', 'fsyncSync', 'chmodSync', 'fchmodSync', 'linkSync', 'existsSync']) {
    backend[name] = nodeFs[name]
  }
  return backend
}

// Every open that reached the backend used numeric flags with real bits only.
function assertBackendOpens (t, backend) {
  for (const { flags } of backend.opens) {
    t.is(typeof flags, 'number', 'numeric flags reach the backend')
    t.is(flags & ~backend.realMask, 0, 'only real bits reach the backend')
  }
}

function codeOf (fn) {
  try {
    fn()
    return null
  } catch (err) {
    return err.code
  }
}

test('constants: synthetic bits above every real bit, backend untouched', (t) => {
  const backend = fakeBackend()
  const fs = createFs(backend)
  const c = fs.constants
  for (const name of REAL) t.is(c[name], backend.constants[name])
  for (const name of ['O_EXCL', 'O_NOFOLLOW', 'O_NONBLOCK']) {
    t.ok(Number.isInteger(c[name]) && c[name] > 0, name + ' defined')
    t.ok(c[name] > backend.realMask, name + ' above every real bit')
    t.is(c[name] & backend.realMask, 0, name + ' collides with nothing')
    t.is(backend.constants[name], undefined, 'backend constants untouched')
  }
  t.ok(c.O_EXCL !== c.O_NOFOLLOW && c.O_NOFOLLOW !== c.O_NONBLOCK && c.O_EXCL !== c.O_NONBLOCK)
  t.ok(Object.isFrozen(c))
  // Pass-through of everything else.
  t.is(fs.lstatSync, nodeFs.lstatSync)
  t.is(fs.closeSync, nodeFs.closeSync)
  t.exception.all(() => createFs({}), /constants/)
})

test('a backend with a real O_EXCL keeps it and passes it through', (t) => {
  const backend = fakeBackend({ extraConstants: { O_EXCL: nodeFs.constants.O_EXCL } })
  const fs = createFs(backend)
  t.is(fs.constants.O_EXCL, nodeFs.constants.O_EXCL)
  t.ok(fs.constants.O_NOFOLLOW > backend.realMask)
  const dir = tmpDir(t)
  const file = path.join(dir, 'x')
  fs.closeSync(fs.openSync(file, 'wx'))
  t.is(codeOf(() => fs.openSync(file, 'wx')), 'EEXIST', 'the kernel refuses the second create')
  t.ok(backend.opens.every((o) => (o.flags & nodeFs.constants.O_EXCL) !== 0), 'the real O_EXCL bit reaches the backend')
  assertBackendOpens(t, backend)
})

test('string flags are parsed by the facade; wx is exclusive; invalid flags', (t) => {
  const backend = fakeBackend()
  const fs = createFs(backend)
  const dir = tmpDir(t)
  const file = path.join(dir, 'f')
  for (const flag of ['wx', 'xw', 'wx+', 'xw+', 'ax', 'xa', 'ax+', 'xa+']) {
    const p = path.join(dir, 'flag-' + flag)
    fs.closeSync(fs.openSync(p, flag, 0o600))
    let err = null
    try { fs.openSync(p, flag) } catch (e) { err = e }
    t.ok(err !== null, flag + ' refused on an existing file')
    t.is(err.code, 'EEXIST')
    t.is(err.syscall, 'open')
    t.is(err.path, p)
  }
  nodeFs.writeFileSync(file, '')
  for (const flag of ['r', 'r+', 'w', 'w+', 'a', 'a+']) {
    fs.closeSync(fs.openSync(file, flag))
    fs.closeSync(fs.openSync(file, flag))
  }
  t.is(codeOf(() => fs.openSync(path.join(dir, 'missing'), 'r')), 'ENOENT')
  t.is(codeOf(() => fs.openSync(path.join(dir, 'missing'), 'r+')), 'ENOENT')
  let err = null
  try { fs.openSync(file, 'zz') } catch (e) { err = e }
  t.ok(err instanceof TypeError)
  t.is(err.code, 'ERR_INVALID_ARG_VALUE')
  t.is(err.message, "The argument 'flags' is invalid. Received 'zz'")
  err = null
  try { fs.openSync(file, 1.5) } catch (e) { err = e }
  t.ok(err instanceof RangeError)
  t.is(err.code, 'ERR_OUT_OF_RANGE')
  t.is(codeOf(() => fs.openSync(file, {})), 'ERR_INVALID_ARG_VALUE')
  t.is(codeOf(() => fs.openSync(file, 'rs')), 'ERR_INVALID_ARG_VALUE', 'O_SYNC flags are not supported')
  t.ok(backend.opens.length >= 20)
  assertBackendOpens(t, backend)
})

test('O_CREAT|O_EXCL: exclusive create, existing file and dangling symlink are EEXIST', (t) => {
  const backend = fakeBackend()
  const fs = createFs(backend)
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  const dir = tmpDir(t)
  const file = path.join(dir, 'new')
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  fs.writeFileSync(fd, 'x')
  fs.closeSync(fd)
  t.is(nodeFs.readFileSync(file, 'utf8'), 'x')
  t.is(codeOf(() => fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL)), 'EEXIST')
  const dangling = path.join(dir, 'dangling')
  nodeFs.symlinkSync(path.join(dir, 'nowhere'), dangling)
  t.is(codeOf(() => fs.openSync(dangling, O_WRONLY | O_CREAT | O_EXCL)), 'EEXIST', 'dangling symlink counts as existing')
  t.absent(nodeFs.existsSync(path.join(dir, 'nowhere')), 'the link target was never created')
  const sub = path.join(dir, 'sub')
  nodeFs.mkdirSync(sub)
  t.is(codeOf(() => fs.openSync(sub, O_WRONLY | O_CREAT | O_EXCL)), 'EEXIST')
  // O_EXCL without O_CREAT is not an exclusive create.
  fs.closeSync(fs.openSync(file, O_WRONLY | O_EXCL))
  assertBackendOpens(t, backend)
})

test('O_NOFOLLOW: a symlink is ELOOP, a regular file opens', (t) => {
  const backend = fakeBackend()
  const fs = createFs(backend)
  const { O_RDONLY, O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  const dir = tmpDir(t)
  const target = path.join(dir, 'target')
  nodeFs.writeFileSync(target, 'secret')
  const link = path.join(dir, 'link')
  nodeFs.symlinkSync(target, link)
  let err = null
  try { fs.openSync(link, O_RDONLY | O_NOFOLLOW | O_NONBLOCK) } catch (e) { err = e }
  t.is(err.code, 'ELOOP')
  t.is(err.syscall, 'open')
  t.is(err.path, link)
  t.is(codeOf(() => fs.openSync(link, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)), 'ELOOP')
  t.is(nodeFs.readFileSync(target, 'utf8'), 'secret', 'the target was never touched')
  const fd = fs.openSync(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  t.ok(fs.fstatSync(fd).isFile())
  t.is(fs.readFileSync(fd, 'utf8'), 'secret')
  fs.closeSync(fd)
  // Without O_NOFOLLOW the link is followed, as on Node.
  fs.closeSync(fs.openSync(link, O_RDONLY))
  assertBackendOpens(t, backend)
})

test('O_NONBLOCK: FIFO refused without opening it, with each caller\'s code', (t) => {
  const backend = fakeBackend()
  const fs = createFs(backend)
  const { O_RDONLY, O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  const dir = tmpDir(t)
  const fifo = path.join(dir, 'fifo')
  const made = spawnSync('mkfifo', [fifo])
  t.is(made.status, 0, 'mkfifo')
  const before = backend.opens.length
  // lib/assoc.js appendPrivate (write open): ENXIO -> 'registro de auditoria inválido' on Node too.
  let err = null
  try { fs.openSync(fifo, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600) } catch (e) { err = e }
  t.is(err.code, 'ENXIO')
  t.is(err.syscall, 'open')
  t.is(err.path, fifo)
  // lib/cert.js readKeyFile (read open): ELOOP -> 'arquivo de chave inválido' (on Node the fstat check does it).
  t.is(codeOf(() => fs.openSync(fifo, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)), 'ELOOP')
  t.is(codeOf(() => fs.openSync(fifo, O_RDONLY | O_NONBLOCK)), 'ELOOP', 'also without O_NOFOLLOW')
  t.is(backend.opens.length, before, 'the FIFO was never opened (no hang)')
  // Without O_NONBLOCK nothing is emulated: the caller asked to block.
  // (Not opened here: it would hang. Only the lstat-free path is checked
  // by the directory and regular-file cases below.)
  const sub = path.join(dir, 'sub')
  nodeFs.mkdirSync(sub)
  const dfd = fs.openSync(sub, O_RDONLY | O_NONBLOCK)
  t.ok(fs.fstatSync(dfd).isDirectory(), 'a directory opens read-only (fsyncDir)')
  fs.closeSync(dfd)
  const dfd2 = fs.openSync(sub, O_RDONLY)
  fs.fsyncSync(dfd2)
  fs.closeSync(dfd2)
  t.is(codeOf(() => fs.openSync(sub, O_WRONLY | O_NONBLOCK)), 'ENXIO', 'a directory is not opened for writing')
  const file = path.join(dir, 'reg')
  nodeFs.writeFileSync(file, '')
  fs.closeSync(fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600))
  fs.closeSync(fs.openSync(path.join(dir, 'fresh'), O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600))
  t.ok(nodeFs.existsSync(path.join(dir, 'fresh')), 'a missing file is created')
  assertBackendOpens(t, backend)
})

test('O_NONBLOCK: a unix socket is refused too', async (t) => {
  const backend = fakeBackend()
  const fs = createFs(backend)
  const { O_RDONLY, O_WRONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  const dir = tmpDir(t)
  const sock = path.join(dir, 's')
  const server = net.createServer()
  await new Promise((resolve, reject) => server.listen(sock, resolve).once('error', reject))
  t.teardown(() => new Promise((resolve) => server.close(resolve)), { force: true })
  t.ok(nodeFs.lstatSync(sock).isSocket())
  const before = backend.opens.length
  t.is(codeOf(() => fs.openSync(sock, O_WRONLY | O_NOFOLLOW | O_NONBLOCK)), 'ENXIO')
  t.is(codeOf(() => fs.openSync(sock, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)), 'ELOOP')
  t.is(backend.opens.length, before)
})

test('readFileSync: fd form reads from the current position and leaves the fd open', (t) => {
  const backend = fakeBackend()
  const fs = createFs(backend)
  const dir = tmpDir(t)
  const file = path.join(dir, 'f')
  nodeFs.writeFileSync(file, 'hello world')
  const fd = nodeFs.openSync(file, 'r')
  const head = Buffer.alloc(6)
  t.is(nodeFs.readSync(fd, head, 0, 6), 6)
  t.is(fs.readFileSync(fd, 'utf8'), 'world')
  t.ok(fs.fstatSync(fd).isFile(), 'fd still open')
  t.is(nodeFs.readSync(fd, Buffer.alloc(4), 0, 4), 0, 'position is at EOF')
  t.is(fs.readFileSync(fd, 'utf8'), '', 'a second read at EOF is empty')
  const buf = fs.readFileSync(fd)
  t.ok(Buffer.isBuffer(buf) && buf.length === 0)
  nodeFs.closeSync(fd)
  // Path form: Buffer by default, encoding from a string or { encoding }.
  t.alike(fs.readFileSync(file), Buffer.from('hello world'))
  t.is(fs.readFileSync(file, 'utf8'), 'hello world')
  t.is(fs.readFileSync(file, { encoding: 'utf8' }), 'hello world')
  t.is(fs.readFileSync(file, { encoding: 'hex' }), Buffer.from('hello world').toString('hex'))
  t.is(fs.readFileSync(file, { flag: 'r' }).toString(), 'hello world')
  t.is(codeOf(() => fs.readFileSync(path.join(dir, 'missing'), 'utf8')), 'ENOENT')
  // Large content crosses the chunk size.
  const big = require('node:crypto').randomBytes(100003)
  nodeFs.writeFileSync(file, big)
  t.alike(fs.readFileSync(file), big)
  const fd2 = nodeFs.openSync(file, 'r')
  t.is(nodeFs.readSync(fd2, Buffer.alloc(3), 0, 3), 3)
  t.alike(fs.readFileSync(fd2), big.subarray(3))
  nodeFs.closeSync(fd2)
  // Empty file.
  nodeFs.writeFileSync(file, '')
  t.is(fs.readFileSync(file, 'utf8'), '')
  // JSON text as lib/store.js readJson reads it.
  nodeFs.writeFileSync(file, '{"v":1}\n')
  t.alike(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1 })
  assertBackendOpens(t, backend)
})

test('writeFileSync: fd form writes at the current position and leaves the fd open', (t) => {
  const backend = fakeBackend()
  const fs = createFs(backend)
  const dir = tmpDir(t)
  const file = path.join(dir, 'f')
  const fd = nodeFs.openSync(file, 'w')
  fs.writeFileSync(fd, 'abc')
  fs.writeFileSync(fd, Buffer.from('def'))
  fs.writeFileSync(fd, new Uint8Array([0x67]))
  fs.fsyncSync(fd)
  t.ok(fs.fstatSync(fd).isFile(), 'fd still open')
  fs.closeSync(fd)
  t.is(nodeFs.readFileSync(file, 'utf8'), 'abcdefg')
  // Position: after a partial read the write lands there.
  const fd2 = nodeFs.openSync(file, 'r+')
  t.is(nodeFs.readSync(fd2, Buffer.alloc(2), 0, 2), 2)
  fs.writeFileSync(fd2, 'XY')
  nodeFs.closeSync(fd2)
  t.is(nodeFs.readFileSync(file, 'utf8'), 'abXYefg')
  // Strings are UTF-8; a big write loops on partial writes.
  const fd3 = nodeFs.openSync(file, 'w')
  fs.writeFileSync(fd3, 'olá\n')
  nodeFs.closeSync(fd3)
  t.alike(nodeFs.readFileSync(file), Buffer.from('olá\n', 'utf8'))
  const big = 'x'.repeat(300000)
  fs.writeFileSync(file, big)
  t.is(nodeFs.readFileSync(file, 'utf8'), big)
  t.exception.all(() => fs.writeFileSync(file, 42), /string or an instance of Uint8Array/)
  // Path form: 'w' truncates, flag 'wx' is exclusive, mode is honoured.
  fs.writeFileSync(file, 'short')
  t.is(nodeFs.readFileSync(file, 'utf8'), 'short')
  const excl = path.join(dir, 'excl')
  fs.writeFileSync(excl, 'first', { mode: 0o600, flag: 'wx' })
  t.is(nodeFs.statSync(excl).mode & 0o777, 0o600)
  let err = null
  try { fs.writeFileSync(excl, 'second', { mode: 0o600, flag: 'wx' }) } catch (e) { err = e }
  t.is(err.code, 'EEXIST')
  t.is(nodeFs.readFileSync(excl, 'utf8'), 'first', 'the existing file is untouched')
  const tok = path.join(dir, 'tok')
  fs.writeFileSync(tok, 'token', { flag: 'wx', mode: 0o600 })
  t.is(codeOf(() => fs.writeFileSync(tok, 'other', { flag: 'wx', mode: 0o600 })), 'EEXIST')
  fs.writeFileSync(path.join(dir, 'append'), 'a', { flag: 'a' })
  fs.writeFileSync(path.join(dir, 'append'), 'b', { flag: 'a' })
  t.is(nodeFs.readFileSync(path.join(dir, 'append'), 'utf8'), 'ab')
  assertBackendOpens(t, backend)
})

test('lib/store.js writeJsonAtomic and the lock owner write work through the facade shape', (t) => {
  // The exact sequence of lib/store.js writeLockOwner and writeJsonAtomic,
  // replayed against the facade (the core itself resolves #fs to node:fs
  // on Node; the sequence is what the Bare smoke runs for real).
  const backend = fakeBackend()
  const fs = createFs(backend)
  const dir = tmpDir(t)
  const tmp = path.join(dir, 'pid.tok.tmp')
  fs.writeFileSync(tmp, '123 abc\n', { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, path.join(dir, 'pid'))
  t.is(fs.readFileSync(path.join(dir, 'pid'), 'utf8'), '123 abc\n')
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  const tmp2 = path.join(dir, '.config.json.1.aaaaaaaaaaaa.tmp')
  const fd = fs.openSync(tmp2, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o666)
  fs.writeFileSync(fd, JSON.stringify({ v: 1 }, null, 2) + '\n')
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  fs.renameSync(tmp2, path.join(dir, 'config.json'))
  const dfd = fs.openSync(dir, fs.constants.O_RDONLY)
  fs.fsyncSync(dfd)
  fs.closeSync(dfd)
  t.alike(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), { v: 1 })
  assertBackendOpens(t, backend)
})
