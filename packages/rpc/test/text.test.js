'use strict'

const test = require('brittle')
const {
  tokensEqual,
  displayText,
  capList,
  capSyncResult,
  utf8ByteLength,
  MAX_LIST,
  MAX_SYNC_RESULT
} = require('..')

test('tokensEqual', (t) => {
  t.ok(tokensEqual('abc', 'abc'))
  t.ok(tokensEqual('', ''))
  t.absent(tokensEqual('abc', 'abd'))
  t.absent(tokensEqual('abc', 'ab'))
  t.absent(tokensEqual('ab', 'abc'))
  t.absent(tokensEqual('abc\u0000', 'abc'), 'NUL padding is not equal')
  t.absent(tokensEqual('abc', 'abc\u0000'))
  t.absent(tokensEqual(undefined, 'abc'))
  t.absent(tokensEqual('abc', null))
  t.absent(tokensEqual(1, 1))
  t.ok(tokensEqual('😀é', '😀é'))
  t.absent(tokensEqual('😀', '😁'))
})

test('tokensEqual has no early exit', (t) => {
  // Every index of the longer string is read on both sides, whatever differs.
  const real = String.prototype.charCodeAt
  const count = (a, b) => {
    let n = 0
    String.prototype.charCodeAt = function (i) { n++; return real.call(this, i) } // eslint-disable-line no-extend-native
    try {
      tokensEqual(a, b)
    } finally {
      String.prototype.charCodeAt = real // eslint-disable-line no-extend-native
    }
    return n
  }
  t.is(count('abcdef', 'abcdef'), 12)
  t.is(count('abcdef', 'xbcdef'), 12, 'first char differs')
  t.is(count('abcdef', 'a'), 12, 'length mismatch')
  t.is(count('a', 'abcdef'), 12)
  t.is(count('', 'abcdef'), 12)
})

test('displayText: unsafe set becomes U+FFFD', (t) => {
  const R = '\ufffd'
  t.is(displayText('olá'), 'olá')
  t.is(displayText('a\nb'), 'a' + R + 'b', 'LF replaced by default')
  t.is(displayText('a\nb', { multiline: true }), 'a\nb', 'LF kept in multiline')
  t.is(displayText('a\rb', { multiline: true }), 'a' + R + 'b', 'CR always replaced')
  t.is(displayText('\t\u0000\u001b[31m'), R + R + R + '[31m')
  t.is(displayText('\u007f\u0080\u009f'), R + R + R)
  t.is(displayText('\u2028\u2029'), R + R)
  t.is(displayText('\u202a\u202b\u202c\u202d\u202e'), R.repeat(5))
  t.is(displayText('a\ud800b\udfffc'), 'a' + R + 'b' + R + 'c', 'lone surrogates replaced')
  t.is(displayText('\ud83d\ude00'), '\ud83d\ude00', 'a surrogate pair is kept')
  t.is(displayText('\u2066\u2067\u2068\u2069'), R.repeat(4))
  t.is(displayText('\u200e\u200f\u061c'), R.repeat(3), 'direction marks')
  t.is(displayText('\u200d\u00a0\u2065\u206a'), '\u200d\u00a0\u2065\u206a', 'neighbours kept')
  t.is(displayText('😀'), '😀')
})

test('displayText: total, never throws', (t) => {
  t.is(displayText(42), '42')
  t.is(displayText(null), 'null')
  t.is(displayText(undefined), 'undefined')
  t.is(displayText({ toString () { return 'a\u0007' } }), 'a\ufffd')
  t.is(displayText({ toString () { throw new Error('x') } }), '')
  t.is(displayText(Object.create(null)), '')
  t.is(displayText('a\nb', null), 'a\ufffdb')
  t.is(displayText('a\nb', { multiline: 'yes' }), 'a\ufffdb')
})

test('capList', (t) => {
  t.alike(capList([1, 2, 3]), { list: [1, 2, 3], truncated: 0 })
  t.alike(capList([1, 2, 3], 2), { list: [1, 2], truncated: 1 })
  t.alike(capList([], 0), { list: [], truncated: 0 })
  t.alike(capList(null), { list: [], truncated: 0 })
  const big = Array.from({ length: 4000 }, (_, i) => i)
  const r = capList(big)
  t.is(r.list.length, MAX_LIST)
  t.is(r.truncated, 4000 - MAX_LIST)
  t.is(big.length, 4000, 'input not mutated')
  const small = [1]
  t.not(capList(small).list, small, 'always a copy')
})

test('capSyncResult', (t) => {
  const keys = Array.from({ length: 4095 }, (_, i) => i.toString(16).padStart(64, '0'))
  const downloaded = {}
  for (const k of keys) downloaded[k] = 3
  const input = {
    ok: false,
    peers: 2,
    seeders: 1,
    admitted: true,
    rejected: null,
    downloaded,
    unadvertised: keys,
    skipped: keys.map((key) => ({ key, reason: 'no-cert' })),
    errors: ['tempo esgotado: ' + keys.map((k) => k + ':0/1').join(', ')],
    errorsSoft: [],
    seederConfirmed: false
  }
  const out = capSyncResult(input)
  t.is(Object.keys(out.downloaded).length, MAX_LIST)
  t.is(out.downloadedTruncated, 4095 - MAX_LIST)
  t.is(out.unadvertised.length, MAX_LIST)
  t.is(out.unadvertisedTruncated, 4095 - MAX_LIST)
  t.is(out.skipped.length, MAX_LIST)
  t.is(out.skippedTruncated, 4095 - MAX_LIST)
  t.is(out.errors.length, 1)
  t.is(Array.from(out.errors[0]).length, 512)
  t.is(out.errorsTruncated, 0)
  t.is(out.errorsSoftTruncated, 0)
  t.is(out.ok, false)
  t.is(out.peers, 2)
  t.is(out.admitted, true)
  t.is(out.rejected, null)
  t.is(out.seederConfirmed, false)
  t.ok(utf8ByteLength(JSON.stringify(out)) <= MAX_SYNC_RESULT)
  t.is(Object.keys(input.downloaded).length, 4095, 'input not mutated')

  const huge = capSyncResult({ errors: Array(100).fill('😀'.repeat(600)), errorsSoft: Array(100).fill('😀'.repeat(600)) })
  t.ok(utf8ByteLength(JSON.stringify(huge)) <= MAX_SYNC_RESULT, 'fits even in the worst case')
  t.is(huge.errorsSoft.length, 0)
  t.is(huge.errorsSoftTruncated, 100)
  t.is(huge.errors.length, 100)
})
