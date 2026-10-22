'use strict'

const test = require('brittle')
const { encodeFrame, createFrameDecoder, parseMessage, MAX_MESSAGE } = require('..')

function collect (max) {
  const messages = []
  const errors = []
  const decoder = createFrameDecoder({ max, onMessage: (m) => messages.push(m), onError: (e) => errors.push(e) })
  return { decoder, messages, errors }
}

function header (len) {
  const h = new Uint8Array(4)
  new DataView(h.buffer).setUint32(0, len, false)
  return h
}

function concat (...parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.byteLength
  }
  return out
}

test('encodeFrame: big-endian length prefix', async (t) => {
  const f = encodeFrame({ a: 'é' })
  const body = new TextEncoder().encode('{"a":"é"}')
  t.is(f.byteLength, 4 + body.byteLength)
  t.is(new DataView(f.buffer).getUint32(0, false), body.byteLength)
  t.alike(f.subarray(4), body)
  await t.exception.all(() => encodeFrame([]), /objeto/)
  await t.exception.all(() => encodeFrame({ a: 'x'.repeat(100) }, 50), /grande demais/)
})

test('decoder: one byte at a time', (t) => {
  const { decoder, messages, errors } = collect(MAX_MESSAGE)
  const f = concat(encodeFrame({ a: 1 }), encodeFrame({ b: 'olá' }))
  for (let i = 0; i < f.byteLength; i++) decoder.push(f.subarray(i, i + 1))
  t.alike(messages, [{ a: 1 }, { b: 'olá' }])
  t.is(errors.length, 0)
})

test('decoder: several frames in one chunk, split header', (t) => {
  const { decoder, messages } = collect(MAX_MESSAGE)
  const a = encodeFrame({ n: 1 })
  const b = encodeFrame({ n: 2 })
  const c = encodeFrame({ n: 3 })
  const all = concat(a, b, c)
  // a + first 2 bytes of b's header, then the rest
  decoder.push(all.subarray(0, a.byteLength + 2))
  decoder.push(all.subarray(a.byteLength + 2))
  t.alike(messages, [{ n: 1 }, { n: 2 }, { n: 3 }])
})

test('decoder: accepts any ArrayBufferView with an offset', (t) => {
  const { decoder, messages } = collect(MAX_MESSAGE)
  const f = encodeFrame({ x: true })
  const padded = new Uint8Array(f.byteLength + 8)
  padded.set(f, 5)
  decoder.push(new DataView(padded.buffer, 5, f.byteLength))
  t.alike(messages, [{ x: true }])
})

test('decoder: oversized length rejected before any allocation', (t) => {
  const sizes = []
  const Real = globalThis.Uint8Array
  class Spy extends Real {
    constructor (...args) {
      if (typeof args[0] === 'number') sizes.push(args[0])
      super(...args)
    }
  }
  const { decoder, messages, errors } = collect(1024)
  globalThis.Uint8Array = Spy
  try {
    decoder.push(header(0xffffffff))
    decoder.push(new Real(10))
  } finally {
    globalThis.Uint8Array = Real
  }
  t.is(errors.length, 1, 'onError once')
  t.is(errors[0].code, 'USAGE')
  t.is(messages.length, 0)
  t.ok(sizes.every((n) => n <= 1024), 'never allocates more than max: ' + JSON.stringify(sizes))
})

test('decoder: allocation never exceeds max for a valid frame', (t) => {
  const sizes = []
  const Real = globalThis.Uint8Array
  class Spy extends Real {
    constructor (...args) {
      if (typeof args[0] === 'number') sizes.push(args[0])
      super(...args)
    }
  }
  const frame = encodeFrame({ a: 'x'.repeat(100) })
  const { decoder, messages } = collect(200)
  globalThis.Uint8Array = Spy
  try {
    decoder.push(frame)
  } finally {
    globalThis.Uint8Array = Real
  }
  t.is(messages.length, 1)
  t.ok(sizes.every((n) => n <= 200))
})

test('decoder: length exactly max is accepted, max + 1 is not', (t) => {
  const body = new TextEncoder().encode('{"a":"' + 'x'.repeat(10) + '"}')
  const ok = collect(body.byteLength)
  ok.decoder.push(concat(header(body.byteLength), body))
  t.is(ok.messages.length, 1)
  const ko = collect(body.byteLength - 1)
  ko.decoder.push(concat(header(body.byteLength), body))
  t.is(ko.errors.length, 1)
})

test('decoder: protocol errors and failed state', (t) => {
  const cases = {
    'length 0': header(0),
    'invalid utf-8': concat(header(4), new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])),
    'invalid json': concat(header(3), new TextEncoder().encode('{a:')),
    'array top level': concat(header(2), new TextEncoder().encode('[]')),
    'null top level': concat(header(4), new TextEncoder().encode('null')),
    bom: concat(header(5), new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))
  }
  for (const [label, bytes] of Object.entries(cases)) {
    const { decoder, messages, errors } = collect(1024)
    decoder.push(bytes)
    t.is(errors.length, 1, label + ': one error')
    t.is(errors[0].code, 'USAGE')
    t.ok(decoder.failed)
    decoder.push(encodeFrame({ later: true }))
    t.is(messages.length, 0, label + ': later pushes ignored')
    t.is(errors.length, 1)
  }
  const { decoder, errors } = collect(1024)
  decoder.push('not bytes')
  t.is(errors.length, 1)
})

test('decoder: a frame after a good one, then an error, stops there', (t) => {
  const { decoder, messages, errors } = collect(1024)
  decoder.push(concat(encodeFrame({ a: 1 }), header(0), encodeFrame({ b: 2 })))
  t.alike(messages, [{ a: 1 }])
  t.is(errors.length, 1)
})

test('parseMessage', (t) => {
  t.alike(parseMessage('{"a":1}'), { ok: true, value: { a: 1 } })
  t.is(parseMessage('[]').code, 'USAGE')
  t.is(parseMessage('null').code, 'USAGE')
  t.is(parseMessage('{').code, 'USAGE')
  t.is(parseMessage('').code, 'USAGE')
  t.is(parseMessage(new Uint8Array(2)).code, 'USAGE', 'binary is not text')
  const s = '{"a":"' + 'é'.repeat(10) + '"}' // 28 bytes, 18 code units
  t.ok(parseMessage(s, 28).ok)
  t.absent(parseMessage(s, 27).ok, 'byte length, not string length')
  t.absent(parseMessage('{"a":"' + 'x'.repeat(MAX_MESSAGE) + '"}').ok)
})
