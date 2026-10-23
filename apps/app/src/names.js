// Per-session cache: author key -> display name. The RPC has no key-to-name
// method (feed items carry the author's current name, follow.list carries keys
// only), so names are learned from the feed and looked up with log.read.
// Every name is peer-derived and the SCREENS render it through displayText.
// One log.read reads the whole diary before slicing, so lookups are
// serialized (one in flight) and never issued during a sync (a member request
// preempts a running sync, docs/rpc.md 6.1).
// A lookup that answers (with or without a profile) or fails with NOT_FOUND
// (no local data for that diary) is cached for the session, until a completed
// sync re-queues the null entries; any other failure (connection lost, timeout,
// uncertain) stores nothing and the key is retried once after a reconnection
// or after a sync that ended (not preempted), never on a screen reload.
// log.read returns only the newest 42 blocks of a diary (docs/rpc.md 5.12), so
// a profile older than that is not found here; the feed still names authors
// from their full diary.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { isKey, LOG_LIMIT_MAX, NOT_FOUND } from '@varanda/rpc'
import { useNode } from './node'

const NamesContext = createContext(null)

export function useNames () {
  return useContext(NamesContext)
}

export function NamesProvider ({ children }) {
  const { phase, sync, request } = useNode()
  // lowercase hex key -> string | null (null = looked up, no name found)
  const [names, setNames] = useState(() => new Map())
  const namesRef = useRef(names)
  const queueRef = useRef([])
  const queuedRef = useRef(new Set())
  const busyRef = useRef(false)
  const timerRef = useRef(null)
  const mountedRef = useRef(true)
  // Keys whose lookup failed transiently: skipped by resolve(), re-queued
  // once on a reconnection or when a sync ends (not preempted).
  const retryRef = useRef(new Set())
  const canPump = phase === 'ready' && sync.active === null && !sync.starting
  const canPumpRef = useRef(canPump)
  canPumpRef.current = canPump

  // Applies changes ([[key, value]]) copy-on-write. A null never overwrites a
  // known non-empty string; `fromLookup` lets a lookup's negative result
  // replace undefined or null only.
  const apply = useCallback((entries) => {
    const next = new Map(namesRef.current)
    let changed = false
    for (const [rawKey, rawName] of entries) {
      if (typeof rawKey !== 'string') continue
      const key = rawKey.toLowerCase()
      const value = typeof rawName === 'string' && rawName !== '' ? rawName : null
      const known = next.get(key)
      if (value === null && typeof known === 'string') continue
      if (known === value) continue
      next.set(key, value)
      changed = true
    }
    if (!changed) return
    namesRef.current = next
    setNames(next)
  }, [])

  const learn = useCallback((key, name) => apply([[key, name]]), [apply])
  const learnMany = useCallback((entries) => apply(entries), [apply])

  const pump = useCallback(async () => {
    if (busyRef.current || !canPumpRef.current) return
    const key = queueRef.current.shift()
    if (key === undefined) return
    busyRef.current = true
    try {
      let found = null
      let definitive = true
      try {
        const res = await request('log.read', { author: key, limit: LOG_LIMIT_MAX })
        let best = -1
        for (const entry of res.entries || []) {
          const record = entry.record
          if (record && record.type === 'profile' && entry.seq > best) {
            best = entry.seq
            found = typeof record.name === 'string' && record.name !== '' ? record.name : null
          }
        }
      } catch (err) {
        // NOT_FOUND = the node has no local data for this diary: an answer.
        if (!err || err.code !== NOT_FOUND) definitive = false
      }
      if (definitive) {
        retryRef.current.delete(key)
        apply([[key, found]])
      } else {
        retryRef.current.add(key)
      }
    } finally {
      queuedRef.current.delete(key)
      busyRef.current = false
    }
    // Next tick, not inline: a response delivered with a sync restart in the
    // same chunk must not send a lookup before the gating ref is re-rendered.
    if (mountedRef.current && timerRef.current === null) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        pump()
      }, 0)
    }
  }, [request, apply])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const enqueue = useCallback((key) => {
    if (queuedRef.current.has(key)) return
    queuedRef.current.add(key)
    queueRef.current.push(key)
  }, [])

  const resolve = useCallback((key) => {
    if (!isKey(key)) return
    const lower = key.toLowerCase()
    // Known, or failed transiently (retried on reconnection or after a sync).
    if (namesRef.current.get(lower) !== undefined || retryRef.current.has(lower)) return
    enqueue(lower)
    pump()
  }, [enqueue, pump])

  // Pump again when the node becomes ready or a sync ends.
  useEffect(() => {
    if (canPump) pump()
  }, [canPump, pump])

  // Queues the keys that failed transiently, once (the set is cleared).
  const requeueRetries = useCallback(() => {
    const keys = [...retryRef.current]
    retryRef.current.clear()
    for (const key of keys) enqueue(key)
  }, [enqueue])

  // A new connection: look up the keys that failed transiently, once.
  const prevPhaseRef = useRef(phase)
  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = phase
    if (phase !== 'ready' || prev === 'ready' || retryRef.current.size === 0) return
    requeueRetries()
    pump()
  }, [phase, requeueRetries, pump])

  // A stopped sync may have downloaded profiles: look the null entries up
  // again, and the keys that failed transiently (never after 'preempted').
  const stopped = sync.stopped
  useEffect(() => {
    if (!stopped || !['done', 'timeout', 'stopped'].includes(stopped.reason)) return
    for (const [key, value] of namesRef.current) {
      if (value === null) enqueue(key)
    }
    requeueRetries()
    pump()
  }, [stopped, enqueue, requeueRetries, pump])

  const nameOf = useCallback((key) => (typeof key === 'string' ? names.get(key.toLowerCase()) : undefined), [names])

  const value = useMemo(() => ({ nameOf, learn, learnMany, resolve }), [nameOf, learn, learnMany, resolve])

  return <NamesContext.Provider value={value}>{children}</NamesContext.Provider>
}
