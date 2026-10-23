// The node connection of the app: starts or connects, keeps the phase, the
// sync state (fed by the node's events, so no event is lost while another tab
// is shown) and hands the screens one `request` function.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { displayText } from '@varanda/rpc'
import { connectNode } from './client/connect'
import { loadConfig, saveConfig, canConfigure } from './configStore'
import { errorText } from './ui'

const MAX_SYNC_LINES = 200

const NodeContext = createContext(null)

export function useNode () {
  return useContext(NodeContext)
}

// A screen notice ('publicado', 'seguindo', ...) describes what the current
// node did in one context of the screen (the post being answered, the sync
// run; null when the screen has none). It is cleared when that node ends or
// is replaced, or when the context changes, so it never outlives what it
// describes. -> [text, set(text, context = the current one)]
export function useNotice (context = null) {
  const { epoch } = useContext(NodeContext)
  const [notice, setNotice] = useState(null)
  useEffect(() => {
    setNotice((n) => (n !== null && (n.epoch !== epoch || n.context !== context) ? null : n))
  }, [epoch, context])
  // A handler keeps the epoch of the render that made it: a response that
  // arrives after its node ended sets a notice that is never shown.
  const set = useCallback((text, ctx = context) => {
    setNotice(text ? { text, epoch, context: ctx } : null)
  }, [epoch, context])
  const shown = notice !== null && notice.epoch === epoch && notice.context === context ? notice.text : ''
  return [shown, set]
}

const noConnection = () => Promise.reject(Object.assign(new Error('sem conexão com o nó'), { code: 'CLOSED' }))

export function NodeProvider ({ children }) {
  // loading | config (native: the Conectar form) | connecting | ready | error
  const [phase, setPhase] = useState('loading')
  const [config, setConfig] = useState(null)
  const [error, setError] = useState('')
  const [sync, setSync] = useState({ active: null, lines: [], stopped: null })
  // Bumped when a connection starts and when one ends (useNotice).
  const [epoch, setEpoch] = useState(0)
  const connRef = useRef(null)
  const startedRef = useRef(false)
  const busyRef = useRef(false)

  const onEvent = useCallback((name, data) => {
    setSync((prev) => {
      if (name === 'sync.started') return { ...prev, active: { runId: data.runId, once: data.once }, stopped: null }
      if (name === 'sync.stopped') {
        const stopped = { runId: data.runId, reason: data.reason, result: data.result }
        // Keyed by runId: a stop of a run that is no longer the active one
        // does not clear the state of the newer run.
        const active = prev.active && prev.active.runId === data.runId ? null : prev.active
        return { ...prev, active, stopped }
      }
      const line = name === 'warning' ? 'aviso: ' + data.line : '#' + data.runId + ' ' + data.line
      const lines = prev.lines.concat([line])
      return { ...prev, lines: lines.length > MAX_SYNC_LINES ? lines.slice(lines.length - MAX_SYNC_LINES) : lines }
    })
  }, [])

  const connect = useCallback(async (cfg, { save = false } = {}) => {
    if (busyRef.current) return
    busyRef.current = true
    setPhase('connecting')
    setError('')
    setSync({ active: null, lines: [], stopped: null })
    setEpoch((e) => e + 1)
    const holder = {}
    try {
      const conn = await connectNode(cfg, {
        onEvent,
        onClose: ({ code }) => {
          if (connRef.current !== holder.conn) return
          connRef.current = null
          setSync({ active: null, lines: [], stopped: null })
          setEpoch((e) => e + 1)
          setError(code === 4000 ? 'outra aba assumiu a conexão' : 'a conexão com o nó foi encerrada')
          setPhase('error')
        }
      })
      holder.conn = conn
      connRef.current = conn
      if (save && cfg) {
        try { await saveConfig(cfg) } catch { setError('a configuração não pôde ser guardada neste aparelho') }
      }
      const status = await conn.request('sync.status')
      if (status.state === 'running') setSync((prev) => (prev.active ? prev : { ...prev, active: { runId: status.runId, once: status.once } }))
      setConfig(cfg)
      setPhase('ready')
    } catch (err) {
      connRef.current = null
      if (holder.conn) { try { await holder.conn.close() } catch {} }
      if (cfg) setConfig(cfg) // the form keeps what was tried
      setError(errorText(err))
      setPhase(canConfigure ? 'config' : 'error')
    } finally {
      busyRef.current = false
    }
  }, [onEvent])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    ;(async () => {
      const saved = await loadConfig()
      setConfig(saved)
      if (!canConfigure) await connect(null)
      else if (saved !== null) await connect(saved)
      else setPhase('config')
    })()
  }, [connect])

  // Native: apply a new configuration (bootstrap, DHT): stop the node
  // (node.close, then terminate) and start it again. The client module
  // handles recover.
  const restart = useCallback(async (cfg) => {
    const conn = connRef.current
    connRef.current = null
    if (conn) {
      setPhase('connecting')
      try { await conn.close() } catch {}
    }
    await connect(cfg, { save: true })
  }, [connect])

  const reconnect = useCallback(async () => {
    const conn = connRef.current
    connRef.current = null
    if (conn) { try { await conn.close() } catch {} }
    await connect(config)
  }, [connect, config])

  const request = useCallback((method, params) => {
    const conn = connRef.current
    return conn ? conn.request(method, params) : noConnection()
  }, [])

  const value = useMemo(() => ({
    phase, config, error, sync, epoch, request, restart, reconnect, connect, canConfigure
  }), [phase, config, error, sync, epoch, request, restart, reconnect, connect])

  return <NodeContext.Provider value={value}>{children}</NodeContext.Provider>
}

// 'hh:mm' style time for an ISO instant (peer-derived: falls back to the
// escaped raw text).
export function timeText (at) {
  const d = new Date(String(at))
  if (Number.isNaN(d.getTime())) return displayText(at)
  try {
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return displayText(d.toISOString())
  }
}
