'use strict'

// The pure-JS UTF-8 codec against Node's TextEncoder / TextDecoder (used
// here only as the reference; the package never uses them).

const test = require('brittle')
const { utf8Encode, utf8Decode, utf8ByteLength } = require('..')

const ref = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const refEncoder = new TextEncoder()

function both (bytes) {
  let mine
  let theirs
  try { mine = { ok: true, s: utf8Decode(bytes) } } catch { mine = { ok: false } }
  try { theirs = { ok: true, s: ref.decode(bytes) } } catch { theirs = { ok: false } }
  return { mine, theirs }
}

// Deterministic PRNG (mulberry32).
function rng (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = a
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

const EDGES = {
  empty: [],
  ascii: [0x41, 0x00, 0x7f],
  'two-byte min': [0xc2, 0x80],
  'two-byte max': [0xdf, 0xbf],
  'overlong 2 (c0)': [0xc0, 0x80],
  'overlong 2 (c1)': [0xc1, 0xbf],
  'three-byte min': [0xe0, 0xa0, 0x80],
  'overlong 3': [0xe0, 0x80, 0x80],
  'overlong 3 high': [0xe0, 0x9f, 0xbf],
  'last before surrogates': [0xed, 0x9f, 0xbf],
  'surrogate d800': [0xed, 0xa0, 0x80],
  'surrogate dfff': [0xed, 0xbf, 0xbf],
  'encoded pair': [0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80],
  'after surrogates': [0xee, 0x80, 0x80],
  bom: [0xef, 0xbb, 0xbf, 0x41],
  'U+FFFF': [0xef, 0xbf, 0xbf],
  'four-byte min': [0xf0, 0x90, 0x80, 0x80],
  'overlong 4': [0xf0, 0x80, 0x80, 0x80],
  'overlong 4 high': [0xf0, 0x8f, 0xbf, 0xbf],
  'U+10FFFF': [0xf4, 0x8f, 0xbf, 0xbf],
  'above U+10FFFF': [0xf4, 0x90, 0x80, 0x80],
  'f5 lead': [0xf5, 0x80, 0x80, 0x80],
  'ff byte': [0xff],
  'fe byte': [0xfe],
  'stray continuation': [0x80],
  'stray continuation after ascii': [0x41, 0xbf],
  'truncated 2': [0xc3],
  'truncated 3': [0xe2, 0x82],
  'truncated 4': [0xf0, 0x9f, 0x98],
  'truncated then ascii': [0xe2, 0x41, 0x41],
  'five-byte form': [0xf8, 0x88, 0x80, 0x80, 0x80],
  'six-byte form': [0xfc, 0x84, 0x80, 0x80, 0x80, 0x80],
  'mixed valid': [0x6f, 0x6c, 0xc3, 0xa1, 0xf0, 0x9f, 0x98, 0x80, 0xe2, 0x80, 0xa8]
}

test('decoder: edge cases match TextDecoder fatal', (t) => {
  for (const [label, arr] of Object.entries(EDGES)) {
    const { mine, theirs } = both(new Uint8Array(arr))
    t.alike(mine, theirs, label + (theirs.ok ? ' (accepted)' : ' (rejected)'))
  }
})

test('decoder: errors are TypeError', (t) => {
  try {
    utf8Decode(new Uint8Array([0xc0, 0x80]))
    t.fail('should throw')
  } catch (err) {
    t.ok(err instanceof TypeError)
  }
})

test('decoder: seeded fuzz matches TextDecoder fatal', (t) => {
  const rand = rng(0x5eed)
  const interesting = [0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xe1, 0xec, 0xed, 0xee, 0xef, 0xf0, 0xf1, 0xf3, 0xf4, 0xf5, 0xff]
  let accepted = 0
  let mismatches = 0
  const N = 5000
  for (let k = 0; k < N; k++) {
    const len = Math.floor(rand() * 12)
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
      bytes[i] = rand() < 0.6 ? interesting[Math.floor(rand() * interesting.length)] : Math.floor(rand() * 256)
    }
    const { mine, theirs } = both(bytes)
    if (theirs.ok) accepted++
    if (mine.ok !== theirs.ok || mine.s !== theirs.s) {
      mismatches++
      if (mismatches <= 5) t.fail('mismatch on ' + Array.from(bytes).map((b) => b.toString(16)).join(' '))
    }
  }
  t.is(mismatches, 0, N + ' byte strings, ' + accepted + ' accepted')
  t.ok(accepted > 100 && accepted < N - 100, 'both outcomes exercised')
})

test('decoder: round trip of valid random text, incl. long strings', (t) => {
  const rand = rng(42)
  for (let k = 0; k < 500; k++) {
    const s = randomString(rand, 40, false)
    t.is(utf8Decode(refEncoder.encode(s)), s)
  }
  const long = '\u{1f600}é'.repeat(20000)
  t.is(utf8Decode(refEncoder.encode(long)), long, 'chunked string building')
})

function randomString (rand, max, loneSurrogates) {
  const len = Math.floor(rand() * max)
  let s = ''
  for (let i = 0; i < len; i++) {
    const r = rand()
    if (r < 0.3) s += String.fromCharCode(Math.floor(rand() * 0x80))
    else if (r < 0.5) s += String.fromCharCode(0x80 + Math.floor(rand() * 0x780))
    else if (r < 0.7) s += String.fromCodePoint(0x10000 + Math.floor(rand() * 0x100000))
    else if (r < 0.85 && loneSurrogates) s += String.fromCharCode(0xd800 + Math.floor(rand() * 0x800))
    else {
      let cp = 0x800 + Math.floor(rand() * 0xf800)
      if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd
      s += String.fromCharCode(cp)
    }
  }
  return s
}

test('encoder: matches TextEncoder on random strings incl. lone surrogates', (t) => {
  const rand = rng(7)
  let mismatches = 0
  for (let k = 0; k < 3000; k++) {
    const s = randomString(rand, 30, true)
    const mine = utf8Encode(s)
    const theirs = refEncoder.encode(s)
    if (mine.length !== utf8ByteLength(s) || Buffer.compare(Buffer.from(mine), Buffer.from(theirs)) !== 0) mismatches++
  }
  t.is(mismatches, 0)
})

test('encoder: lone surrogates become U+FFFD', (t) => {
  t.alike(Array.from(utf8Encode('\ud800')), [0xef, 0xbf, 0xbd])
  t.alike(Array.from(utf8Encode('\udc00a')), [0xef, 0xbf, 0xbd, 0x61])
  t.alike(Array.from(utf8Encode('😀')), [0xf0, 0x9f, 0x98, 0x80], 'a pair is one 4-byte character')
  t.alike(Array.from(utf8Encode('\ude00\ud83d')), [0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd], 'reversed pair')
  t.ok(utf8Encode('') instanceof Uint8Array)
})
