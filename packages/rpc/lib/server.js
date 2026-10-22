'use strict'

const { PROTOCOL, MAX_MESSAGE, MAX_PENDING } = require('./limits')
const { USAGE, UNAUTHORIZED, INTERNAL, GENERIC_MESSAGES, toWireError } = require('./errors')
const { utf8ByteLength } = require('./text')
const { tokensEqual } = require('./token')
const { validateRequest, validateEvent } = require('./envelope')
const { isPlainObject, isId } = require('./methods')

const noop = () => {}

// One dispatcher per connection (docs/rpc.md section 8).
//   handlers: { [method]: async (params) => result } (session.open is
//             handled here and never reaches a handler)
//   send(message, text): delivers one envelope; `text` is its JSON
//   token: a string (WebSocket) or null (IPC: the open carries no token)
//   onProtocolError({ code, message }): the transport must close the
//             connection (malformed envelope without a usable id, failed
//             session.open)
function createServerDispatcher ({ handlers, send, token = null, onProtocolError = noop } = {}) {
  if (handlers === null || typeof handlers !== 'object') throw new TypeError('handlers required')
  if (typeof send !== 'function') throw new TypeError('send required')
  if (token !== null && (typeof token !== 'string' || token.length === 0)) throw new TypeError('token must be a non-empty string or null')

  let opened = false
  let closed = false
  let seq = 0
  const pending = new Set()

  // -> 'sent' | 'closed' | 'invalid' (not serializable) | 'too-big'
  function write (message) {
    if (closed) return 'closed'
    let text
    try {
      text = JSON.stringify(message)
    } catch {
      return 'invalid'
    }
    if (typeof text !== 'string') return 'invalid'
    if (utf8ByteLength(text) > MAX_MESSAGE) return 'too-big'
    try {
      send(message, text)
    } catch {}
    return 'sent'
  }

  function respondError (id, code, message) {
    write({ v: PROTOCOL, id, ok: false, error: { code, message } })
  }

  function respond (id, result) {
    const message = { v: PROTOCOL, id, ok: true, result: result === undefined ? null : result }
    // A hostile result (e.g. a Proxy whose traps throw) must not escape.
    let plain = false
    try { plain = isPlainObject(message.result) } catch {}
    if (!plain) return respondError(id, INTERNAL, GENERIC_MESSAGES.INTERNAL)
    const status = write(message)
    if (status === 'too-big') respondError(id, USAGE, 'resposta grande demais')
    else if (status === 'invalid') respondError(id, INTERNAL, GENERIC_MESSAGES.INTERNAL)
  }

  function protocolError (code, message) {
    try { onProtocolError({ code, message }) } catch {}
  }

  function receive (obj) {
    if (closed) return
    const r = validateRequest(obj)
    if (!r.ok) {
      let id = null
      try { id = isPlainObject(obj) && isId(obj.id) ? obj.id : null } catch {}
      if (id !== null && !pending.has(id)) respondError(id, USAGE, r.message)
      else protocolError(USAGE, r.message)
      return
    }
    const { id, method, params } = r.value
    if (pending.has(id)) return respondError(id, USAGE, 'id repetido')

    if (method === 'session.open') {
      if (opened) return respondError(id, USAGE, 'sessão já aberta')
      const given = params.token
      const good = token === null ? given === undefined : tokensEqual(given, token)
      if (!good) {
        respondError(id, UNAUTHORIZED, 'token inválido')
        close()
        protocolError(UNAUTHORIZED, 'token inválido')
        return
      }
      opened = true
      return respond(id, { protocol: PROTOCOL })
    }
    if (!opened) return respondError(id, UNAUTHORIZED, 'sessão não aberta')
    if (pending.size >= MAX_PENDING) return respondError(id, USAGE, 'pedidos demais em andamento')

    const handler = handlers[method]
    if (typeof handler !== 'function') return respondError(id, INTERNAL, GENERIC_MESSAGES.INTERNAL)
    pending.add(id)
    Promise.resolve()
      // A request queued before close() never starts its handler.
      .then(() => closed ? undefined : handler(params))
      .then(
        (result) => {
          pending.delete(id)
          respond(id, result)
        },
        (err) => {
          pending.delete(id)
          const e = toWireError(err)
          respondError(id, e.code, e.message)
        }
      )
  }

  // Sends an event with the next seq once the session is open. An oversized
  // event is dropped and replaced by a `warning` 'evento grande demais'; an
  // invalid one is dropped. Returns true when an event was sent.
  function emit (event, data) {
    if (closed || !opened) return false
    const message = { v: PROTOCOL, event, seq: seq + 1, data }
    if (!validateEvent(message).ok) return false
    let text
    try {
      text = JSON.stringify(message)
    } catch {
      return false
    }
    if (utf8ByteLength(text) > MAX_MESSAGE) {
      message.event = 'warning'
      message.data = { line: 'evento grande demais' }
      text = JSON.stringify(message)
    }
    seq++
    try {
      send(message, text)
    } catch {}
    return message.event === event
  }

  function close () {
    closed = true
    pending.clear()
  }

  return {
    receive,
    emit,
    close,
    get opened () { return opened },
    get closed () { return closed },
    get pending () { return pending.size }
  }
}

module.exports = { createServerDispatcher }
