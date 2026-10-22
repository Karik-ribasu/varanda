'use strict'

// fs facade for Bare (docs/protocol.md "Runtimes"). bare-fs 4.8.4 has no
// O_EXCL, O_NOFOLLOW or O_NONBLOCK (its 'wx' flag is NOT exclusive) and its
// readFileSync/writeFileSync take only a path. createFs(backend) wraps such
// a backend so the core's fs surface (lib/store.js, lib/cert.js,
// lib/assoc.js, the CLI's member.js) behaves as on Node: every backend
// function is passed through and constants, openSync, readFileSync and
// writeFileSync are overridden. Pure: the backend is injected, so Node unit
// tests drive it with a fake backend (test/bare-fs.test.js).
//
// Emulation and its residual: a flag the backend lacks is emulated with an
// lstat of the path BEFORE the open (O_CREAT|O_EXCL -> EEXIST when the path
// exists in any form, O_NOFOLLOW -> ELOOP on a symlink, O_NONBLOCK -> a
// non-regular file is refused without opening it). lstat-then-open is a
// TOCTOU window: a path replaced between the two calls is followed or
// clobbered. Accepted because the app's data dir is private to one worklet
// inside the app sandbox (no other writer races it); on Node the real
// kernel flags apply (lib/node/fs.js) and nothing here runs.

const STRING_FLAGS = {
  r: ['O_RDONLY'],
  'r+': ['O_RDWR'],
  w: ['O_TRUNC', 'O_CREAT', 'O_WRONLY'],
  'w+': ['O_TRUNC', 'O_CREAT', 'O_RDWR'],
  a: ['O_APPEND', 'O_CREAT', 'O_WRONLY'],
  'a+': ['O_APPEND', 'O_CREAT', 'O_RDWR'],
  wx: ['O_TRUNC', 'O_CREAT', 'O_WRONLY', 'O_EXCL'],
  xw: ['O_TRUNC', 'O_CREAT', 'O_WRONLY', 'O_EXCL'],
  'wx+': ['O_TRUNC', 'O_CREAT', 'O_RDWR', 'O_EXCL'],
  'xw+': ['O_TRUNC', 'O_CREAT', 'O_RDWR', 'O_EXCL'],
  ax: ['O_APPEND', 'O_CREAT', 'O_WRONLY', 'O_EXCL'],
  xa: ['O_APPEND', 'O_CREAT', 'O_WRONLY', 'O_EXCL'],
  'ax+': ['O_APPEND', 'O_CREAT', 'O_RDWR', 'O_EXCL'],
  'xa+': ['O_APPEND', 'O_CREAT', 'O_RDWR', 'O_EXCL']
}

const EMULATED = ['O_EXCL', 'O_NOFOLLOW', 'O_NONBLOCK']
const CHUNK = 8192

function invalidFlags (flags) {
  const shown = typeof flags === 'string' ? "'" + flags + "'" : String(flags)
  const err = new TypeError("The argument 'flags' is invalid. Received " + shown)
  err.code = 'ERR_INVALID_ARG_VALUE'
  return err
}

function outOfRangeFlags (flags) {
  const err = new RangeError('The value of "flags" is out of range. It must be an integer. Received ' + String(flags))
  err.code = 'ERR_OUT_OF_RANGE'
  return err
}

// Same shape as the backend's open errors: code, syscall (and bare-fs's
// operation alias), path.
function openError (code, detail, filepath) {
  const err = new Error(code + ': ' + detail + ", open '" + filepath + "'")
  err.code = code
  err.syscall = 'open'
  err.operation = 'open'
  err.path = filepath
  return err
}

function isUint8Array (v) {
  return v instanceof Uint8Array
}

function createFs (backend) {
  if (backend === null || typeof backend !== 'object' || !backend.constants) {
    throw new TypeError('createFs: backend with constants required')
  }
  const real = backend.constants
  const required = ['O_RDONLY', 'O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_TRUNC', 'O_APPEND']
  for (const name of required) {
    if (!Number.isInteger(real[name])) throw new TypeError('createFs: backend constants lack ' + name)
  }

  // Synthetic bits: above every real O_* bit of the backend, one per
  // emulated flag the backend does not define; asserted never to collide.
  let highest = 0
  for (const [name, value] of Object.entries(real)) {
    if (name.startsWith('O_') && Number.isInteger(value) && value > 0) {
      highest = Math.max(highest, 1 << (31 - Math.clz32(value)))
    }
  }
  let next = highest === 0 ? 1 : highest * 2
  const constants = { ...real }
  const emulated = {}
  for (const name of EMULATED) {
    if (Number.isInteger(real[name]) && real[name] > 0) continue
    if (next >= 0x40000000) throw new Error('createFs: no free bit for ' + name)
    constants[name] = next
    emulated[name] = next
    next *= 2
  }
  let synthetic = 0
  for (const bit of Object.values(emulated)) synthetic |= bit
  for (const [name, value] of Object.entries(real)) {
    if (name.startsWith('O_') && Number.isInteger(value) && (value & synthetic) !== 0) {
      throw new Error('createFs: synthetic bit collides with ' + name)
    }
  }
  Object.freeze(constants)
  const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT } = constants
  const ACCESS_MASK = O_RDONLY | O_WRONLY | O_RDWR

  function toFlags (flags) {
    if (typeof flags === 'string') {
      const names = STRING_FLAGS[flags]
      if (!names) throw invalidFlags(flags)
      let bits = 0
      for (const name of names) bits |= constants[name]
      return bits
    }
    if (typeof flags !== 'number') throw invalidFlags(flags)
    if (!Number.isInteger(flags)) throw outOfRangeFlags(flags)
    return flags
  }

  function lstatOrNull (filepath) {
    try {
      return backend.lstatSync(filepath)
    } catch (err) {
      if (err && err.code === 'ENOENT') return null
      throw err
    }
  }

  // String flags are parsed here (never handed to the backend); the
  // emulated bits are checked against an lstat of the path and stripped, so
  // only real backend bits reach backend.openSync.
  function openSync (filepath, flags = 'r', mode = 0o666) {
    const bits = toFlags(flags)
    const wantsExcl = (bits & constants.O_EXCL) !== 0 && (bits & O_CREAT) !== 0
    const wantsNoFollow = (bits & constants.O_NOFOLLOW) !== 0
    const wantsNonBlock = (bits & constants.O_NONBLOCK) !== 0
    const emulateExcl = wantsExcl && emulated.O_EXCL !== undefined
    const emulateNoFollow = wantsNoFollow && emulated.O_NOFOLLOW !== undefined
    const emulateNonBlock = wantsNonBlock && emulated.O_NONBLOCK !== undefined
    if (emulateExcl || emulateNoFollow || emulateNonBlock) {
      const st = lstatOrNull(filepath)
      if (st !== null) {
        if (emulateExcl) throw openError('EEXIST', 'file already exists', filepath)
        if (emulateNoFollow && st.isSymbolicLink()) {
          throw openError('ELOOP', 'too many symbolic links encountered', filepath)
        }
        if (emulateNonBlock && !st.isFile()) {
          const readOnly = (bits & ACCESS_MASK) === O_RDONLY
          // A directory opened read-only is allowed (fsync of a directory,
          // and a caller's own fstat check refuses it as on Node).
          if (!(readOnly && st.isDirectory())) {
            // A FIFO, socket or device would block or hang the open. For a
            // write open Node reports ENXIO (FIFO without reader); for a
            // read open Node opens it and the caller's fstat check refuses
            // it, which lib/cert.js readKeyFile only does for ELOOP/EMLINK
            // from open, so the refusal is reported under ELOOP: same
            // caller-visible outcome ('arquivo de chave inválido').
            throw openError(readOnly ? 'ELOOP' : 'ENXIO', 'not a regular file (' + kind(st) + ')', filepath)
          }
        }
      }
    }
    return backend.openSync(filepath, bits & ~synthetic, mode)
  }

  function kind (st) {
    if (st.isDirectory()) return 'directory'
    if (st.isFIFO()) return 'fifo'
    if (st.isSocket()) return 'socket'
    if (st.isCharacterDevice()) return 'character device'
    if (st.isBlockDevice()) return 'block device'
    if (st.isSymbolicLink()) return 'symbolic link'
    return 'special file'
  }

  function normalizeOpts (opts) {
    if (typeof opts === 'string') return { encoding: opts }
    if (opts === null || opts === undefined) return {}
    if (typeof opts !== 'object') throw invalidFlags(opts)
    return opts
  }

  // Reads from the current position until EOF; a regular file's size is
  // only a hint for the first chunk.
  function readAllFrom (fd) {
    let hint = 0
    try {
      hint = backend.fstatSync(fd).size
    } catch {}
    const chunks = []
    let buffer = Buffer.allocUnsafe(Math.max(Number.isInteger(hint) && hint > 0 ? hint : 0, CHUNK))
    let filled = 0
    for (;;) {
      const r = backend.readSync(fd, buffer, filled, buffer.byteLength - filled)
      if (r === 0) break
      filled += r
      if (filled === buffer.byteLength) {
        chunks.push(buffer)
        buffer = Buffer.allocUnsafe(CHUNK)
        filled = 0
      }
    }
    if (filled > 0) chunks.push(buffer.subarray(0, filled))
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
  }

  function readFileSync (pathOrFd, opts) {
    opts = normalizeOpts(opts)
    const encoding = opts.encoding === undefined || opts.encoding === null ? 'buffer' : opts.encoding
    let buffer
    if (typeof pathOrFd === 'number') {
      buffer = readAllFrom(pathOrFd)
    } else {
      const fd = openSync(pathOrFd, opts.flag || 'r')
      try {
        buffer = readAllFrom(fd)
      } finally {
        backend.closeSync(fd)
      }
    }
    return encoding === 'buffer' ? buffer : buffer.toString(encoding)
  }

  function writeAllTo (fd, data) {
    let written = 0
    while (written < data.byteLength) {
      written += backend.writeSync(fd, data, written, data.byteLength - written)
    }
  }

  function writeFileSync (pathOrFd, data, opts) {
    opts = normalizeOpts(opts)
    if (typeof data === 'string') data = Buffer.from(data, opts.encoding || 'utf8')
    else if (!isUint8Array(data)) throw new TypeError('The "data" argument must be a string or an instance of Uint8Array')
    if (typeof pathOrFd === 'number') {
      writeAllTo(pathOrFd, data)
      return
    }
    const fd = openSync(pathOrFd, opts.flag || 'w', opts.mode || 0o666)
    try {
      writeAllTo(fd, data)
    } finally {
      backend.closeSync(fd)
    }
  }

  const fs = {}
  for (const key of Object.keys(backend)) fs[key] = backend[key]
  fs.constants = constants
  fs.openSync = openSync
  fs.readFileSync = readFileSync
  fs.writeFileSync = writeFileSync
  return fs
}

module.exports = { createFs, STRING_FLAGS }
