/* global location, history, WebSocket */

// Web client: the page talks to varanda-serve on the person's own computer
// over a loopback WebSocket at /rpc on the page's own host (docs/rpc.md
// section 3). The session token comes in the URL fragment (#token=...) that
// varanda-serve prints. It is read once, removed from the address bar and the
// history, and kept only in this module's memory: never in storage, cookies
// or the DOM, never logged.

import { createClient, parseMessage, EVENTS, MAX_MESSAGE } from '@varanda/rpc'

let token = null
let tokenRead = false

function takeToken () {
  if (tokenRead) return
  tokenRead = true
  const match = /(?:^#|&)token=([^&]+)/.exec(location.hash)
  if (match) {
    try { token = decodeURIComponent(match[1]) } catch { token = null }
    try {
      history.replaceState(null, '', location.pathname + location.search)
    } catch {}
  }
}

function fail (message) {
  const err = new Error(message)
  err.code = 'CLOSED'
  return err
}

// -> { request(method, params), close(), kind } after session.open.
// onClose({ code }) is called when the socket closes after that. There is no
// automatic reconnection: the UI offers a button.
export function connectNode (config, { onEvent, onClose } = {}) {
  takeToken()
  const local = location.hostname === '127.0.0.1' || location.hostname === 'localhost'
  if (!local || token === null) return Promise.reject(fail('abra o endereço impresso pelo varanda-serve'))

  return new Promise((resolve, reject) => {
    let settled = false
    let ws
    try {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/rpc')
    } catch {
      reject(fail('não foi possível conectar ao varanda-serve'))
      return
    }
    const client = createClient({
      send: (message) => { ws.send(JSON.stringify(message)) }
    })
    if (typeof onEvent === 'function') {
      for (const name of EVENTS) client.on(name, (data) => onEvent(name, data))
    }
    ws.onmessage = (ev) => {
      // One text frame per message; a binary frame or bad JSON ends the connection.
      const parsed = typeof ev.data === 'string' ? parseMessage(ev.data, MAX_MESSAGE) : { ok: false }
      if (!parsed.ok) {
        try { ws.close() } catch {}
        return
      }
      client.receive(parsed.value)
    }
    ws.onerror = () => {}
    ws.onclose = (ev) => {
      client.close()
      if (!settled) {
        settled = true
        reject(fail(ev.code === 4000 ? 'outra aba assumiu a conexão' : 'não foi possível abrir a conexão com o varanda-serve'))
      } else if (typeof onClose === 'function') {
        onClose({ code: ev.code })
      }
    }
    ws.onopen = () => {
      client.request('session.open', { token }).then(() => {
        settled = true
        resolve({
          kind: 'web',
          request: (method, params = {}) => client.request(method, params),
          close: async () => { try { ws.close() } catch {} }
        })
      }, (err) => {
        if (!settled) {
          settled = true
          reject(err)
        }
        try { ws.close() } catch {}
      })
    }
  })
}
