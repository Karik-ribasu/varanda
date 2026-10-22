'use strict'

const { MAX_MESSAGE } = require('./limits')
const { RpcError, USAGE } = require('./errors')
const { utf8ByteLength, utf8Encode, utf8Decode } = require('./text')
const { isPlainObject } = require('./methods')

const HEADER = 4

function fail (message) {
  return { ok: false, code: USAGE, message }
}

// Text -> top-level plain object (the JSON step shared by both framings).
function parseJsonObject (text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return fail('JSON inválido')
  }
  if (!isPlainObject(value)) return fail('mensagem não é um objeto')
  return { ok: true, value }
}

// IPC: 4-byte unsigned big-endian length + that many bytes of UTF-8 JSON.
// Throws RpcError USAGE for a non-object or a message over `max` bytes.
function encodeFrame (obj, max = MAX_MESSAGE) {
  if (!isPlainObject(obj)) throw new RpcError(USAGE, 'mensagem não é um objeto')
  const body = utf8Encode(JSON.stringify(obj))
  if (body.byteLength > max) throw new RpcError(USAGE, 'mensagem grande demais')
  const frame = new Uint8Array(HEADER + body.byteLength)
  new DataView(frame.buffer).setUint32(0, body.byteLength, false)
  frame.set(body, HEADER)
  return frame
}

// Incremental decoder for any chunking. The length is checked against `max`
// BEFORE the body buffer is allocated; a protocol error (length 0, length >
// max, invalid UTF-8, invalid JSON, non-object top level, non-byte chunk)
// calls onError once and every later push is ignored: the transport must
// close the stream.
function createFrameDecoder ({ max = MAX_MESSAGE, onMessage, onError } = {}) {
  const header = new Uint8Array(HEADER)
  let headerFill = 0
  let body = null
  let bodyFill = 0
  let failed = false

  function error (message) {
    failed = true
    body = null
    try { onError({ code: USAGE, message }) } catch {}
  }

  function deliver (bytes) {
    let text
    try {
      text = utf8Decode(bytes)
    } catch {
      return error('UTF-8 inválido')
    }
    const r = parseJsonObject(text)
    if (!r.ok) return error(r.message)
    try { onMessage(r.value) } catch {}
  }

  function push (chunk) {
    if (failed) return
    if (!ArrayBuffer.isView(chunk)) return error('bloco inválido')
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let i = 0
    while (i < bytes.byteLength && !failed) {
      if (body === null) {
        const take = Math.min(HEADER - headerFill, bytes.byteLength - i)
        header.set(bytes.subarray(i, i + take), headerFill)
        headerFill += take
        i += take
        if (headerFill < HEADER) return
        const len = new DataView(header.buffer).getUint32(0, false)
        headerFill = 0
        if (len === 0) return error('quadro vazio')
        if (len > max) return error('mensagem grande demais')
        body = new Uint8Array(len)
        bodyFill = 0
      } else {
        const take = Math.min(body.byteLength - bodyFill, bytes.byteLength - i)
        body.set(bytes.subarray(i, i + take), bodyFill)
        bodyFill += take
        i += take
        if (bodyFill === body.byteLength) {
          const full = body
          body = null
          deliver(full)
        }
      }
    }
  }

  return { push, get failed () { return failed } }
}

// WebSocket: one text frame per message, no length prefix. Binary frames are
// a protocol error enforced by the transport. Never throws.
function parseMessage (text, max = MAX_MESSAGE) {
  if (typeof text !== 'string') return fail('mensagem não é texto')
  // Every UTF-16 unit is at least one UTF-8 byte: reject early when longer.
  if (text.length > max || utf8ByteLength(text) > max) return fail('mensagem grande demais')
  return parseJsonObject(text)
}

module.exports = { HEADER, encodeFrame, createFrameDecoder, parseMessage }
