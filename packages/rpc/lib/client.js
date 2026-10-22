'use strict'

const { PROTOCOL, MAX_ID, MAX_PENDING, MAX_REQUEST, DEFAULT_TIMEOUT_MS } = require('./limits')
const { RpcError, USAGE, TIMEOUT, CLOSED, GENERIC_MESSAGES } = require('./errors')
const { utf8ByteLength } = require('./text')
const { validateRequest, validateResponse, validateEvent } = require('./envelope')
const { isMutating, hasOwn, isPlainObject } = require('./methods')

// One client per connection (docs/rpc.md section 9). It never retries and
// never resends a request on its own.
//   send(message, text): delivers one request envelope; `text` is its JSON
function createClient ({ send, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof send !== 'function') throw new TypeError('send required')
  const wait = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  const pending = new Map() // id -> { method, resolve, reject, timer }
  const listeners = new Map() // event -> Set of fn
  let nextId = 1
  let closed = false

  function allocateId () {
    for (;;) {
      const id = nextId
      nextId = nextId >= MAX_ID ? 1 : nextId + 1
      if (!pending.has(id)) return id
    }
  }

  function lost (method, code) {
    return new RpcError(code, GENERIC_MESSAGES[code], { uncertain: isMutating(method) })
  }

  function request (method, params = {}) {
    if (closed) return Promise.reject(new RpcError(CLOSED, GENERIC_MESSAGES.CLOSED))
    if (pending.size >= MAX_PENDING) return Promise.reject(new RpcError(USAGE, 'pedidos demais em andamento'))
    const id = allocateId()
    const r = validateRequest({ v: PROTOCOL, id, method, params })
    if (!r.ok) return Promise.reject(new RpcError(USAGE, r.message))
    // The params as given are sent (defaults are filled in by the server).
    const message = { v: PROTOCOL, id, method, params }
    let text
    try {
      text = JSON.stringify(message)
    } catch {
      return Promise.reject(new RpcError(USAGE, 'params inválidos'))
    }
    if (utf8ByteLength(text) > MAX_REQUEST) return Promise.reject(new RpcError(USAGE, 'pedido grande demais'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(lost(method, TIMEOUT))
      }, wait)
      pending.set(id, { method, resolve, reject, timer })
      try {
        send(message, text)
      } catch {
        // Whether the bytes left is unknown: same rule as a lost connection.
        clearTimeout(timer)
        pending.delete(id)
        reject(lost(method, CLOSED))
      }
    })
  }

  // Routes one decoded envelope. Returns false when it was ignored (invalid,
  // unknown id, after close). A response is never matched to a timed-out or
  // closed request: its id is no longer pending.
  function receive (obj) {
    if (closed) return false
    if (isPlainObject(obj) && hasOwn(obj, 'event')) {
      const r = validateEvent(obj)
      if (!r.ok) return false
      const fns = listeners.get(r.value.event)
      if (fns) {
        for (const fn of [...fns]) {
          try { fn(r.value.data, r.value) } catch {}
        }
      }
      return true
    }
    const r = validateResponse(obj)
    if (!r.ok) return false
    const p = pending.get(r.value.id)
    if (!p) return false
    pending.delete(r.value.id)
    clearTimeout(p.timer)
    if (r.value.ok) p.resolve(r.value.result)
    else p.reject(new RpcError(r.value.error.code, r.value.error.message, { uncertain: false }))
    return true
  }

  // on(event, fn) -> off(); fn(data, envelope).
  function on (event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function')
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    set.add(fn)
    return () => { set.delete(fn) }
  }

  // Connection lost: every pending request rejects with CLOSED.
  function close () {
    if (closed) return
    closed = true
    const all = [...pending.values()]
    pending.clear()
    for (const p of all) {
      clearTimeout(p.timer)
      p.reject(lost(p.method, CLOSED))
    }
    listeners.clear()
  }

  return {
    request,
    receive,
    on,
    close,
    get closed () { return closed },
    get pending () { return pending.size }
  }
}

module.exports = { createClient }
