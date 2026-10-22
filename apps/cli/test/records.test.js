'use strict'

const test = require('brittle')
const b4a = require('b4a')
const records = require('../lib/records')
const { testnet } = require('./helpers/net')

const {
  MAX_NAME, MAX_BIO, MAX_TEXT, MAX_BLOCK_BYTES, MAX_LOG_BLOCKS, MAX_LOG_BYTES,
  nowIso, isHex64, isCanonicalIso, decodeBlock,
  memberCertRecord, profileRecord, postRecord, validateRecord, parseRef, formatRef,
  latestProfile, genesisCert
} = records

const K1 = 'a'.repeat(64)
const K2 = 'b'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'

function cert (over = {}) {
  return {
    v: 1,
    member: K1,
    ageBand: '18+',
    method: 'stub',
    date: AT,
    association: K2,
    signature: 'c'.repeat(128),
    ...over
  }
}

test('records', async (t) => {
  await testnet(t)

  t.is(MAX_NAME, 80)
  t.is(MAX_BIO, 280)
  t.is(MAX_TEXT, 1000)
  t.is(MAX_BLOCK_BYTES, 16384)
  t.is(MAX_LOG_BLOCKS, 100000)
  t.is(MAX_LOG_BYTES, 64 * 1024 * 1024)
  t.ok(isCanonicalIso(nowIso()))
  t.ok(isHex64(K1))
  t.absent(isHex64('A'.repeat(64)))
  t.absent(isHex64('a'.repeat(63)))
  t.absent(isHex64(5))
})

test('isCanonicalIso never throws', async (t) => {
  await testnet(t)
  t.ok(isCanonicalIso(AT))
  t.absent(isCanonicalIso('2026-13-01T00:00:00.000Z'))
  t.absent(isCanonicalIso('2026-01-01'))
  t.absent(isCanonicalIso(123))
  t.absent(isCanonicalIso(null))
  t.absent(isCanonicalIso({}))
})

test('decodeBlock', async (t) => {
  await testnet(t)
  t.alike(decodeBlock(b4a.from('{"a":1}')), { a: 1 })
  t.is(decodeBlock(b4a.from('not json')), null)
  t.is(decodeBlock(b4a.from('null')), null)
  t.is(decodeBlock(b4a.from('[1]')), null)
  t.is(decodeBlock(b4a.from('"x"')), null)
  t.is(decodeBlock(b4a.from('5')), null)
  t.is(decodeBlock('{"a":1}'), null)
  t.is(decodeBlock(undefined), null)
  t.alike(decodeBlock(new Uint8Array(b4a.from('{"a":1}'))), { a: 1 })
  // A block over MAX_BLOCK_BYTES is never parsed (S3).
  const padding = ' '.repeat(MAX_BLOCK_BYTES - '{"a":1}'.length)
  t.alike(decodeBlock(b4a.from('{"a":1}' + padding)), { a: 1 }, 'exactly MAX_BLOCK_BYTES is parsed')
  t.is(decodeBlock(b4a.from('{"a":1}' + padding + ' ')), null, 'MAX_BLOCK_BYTES + 1 is null')
  t.is(decodeBlock(b4a.alloc(MAX_BLOCK_BYTES + 1, 0x20)), null)
})

test('builders', async (t) => {
  await testnet(t)
  t.alike(memberCertRecord(cert()), { type: 'member-cert', cert: cert() })
  t.alike(profileRecord({ name: 'Ana', at: AT }), { type: 'profile', name: 'Ana', bio: '', at: AT })
  t.alike(postRecord({ text: 'oi', at: AT }), { type: 'post', text: 'oi', at: AT, replyTo: null })
  t.ok(isCanonicalIso(profileRecord({ name: 'Ana' }).at))
  t.ok(isCanonicalIso(postRecord({ text: 'oi' }).at))
  const reply = postRecord({ text: 'oi', at: AT, replyTo: { author: K1, seq: 1 } })
  t.alike(reply.replyTo, { author: K1, seq: 1 })

  await t.exception.all(async () => memberCertRecord({}), /malformed/)
  await t.exception.all(async () => memberCertRecord(cert({ v: 2 })), TypeError)
  await t.exception.all(async () => profileRecord({ name: '' }), TypeError)
  await t.exception.all(async () => profileRecord({ name: 'Ana', bio: 'x'.repeat(MAX_BIO + 1) }), /bio-length/)
  await t.exception.all(async () => postRecord({ text: '' }), /text-length/)
  await t.exception.all(async () => postRecord({ text: 'x', replyTo: { author: K1, seq: 0 } }), /reply-invalid/)
  await t.exception.all(async () => postRecord({ text: 'x', at: 'nope' }), /date-invalid/)
  await t.exception.all(async () => postRecord(), TypeError)
})

test('validateRecord: shape and ordering', async (t) => {
  await testnet(t)
  t.is(validateRecord(null, 1), 'malformed')
  t.is(validateRecord('x', 1), 'malformed')
  t.is(validateRecord([], 1), 'malformed')
  t.is(validateRecord({ type: 'other' }, 1), 'malformed')
  t.is(validateRecord(undefined, 0), 'malformed')

  const profile = { type: 'profile', name: 'Ana', bio: '', at: AT }
  const post = { type: 'post', text: 'oi', at: AT, replyTo: null }
  const certRec = { type: 'member-cert', cert: cert() }
  t.is(validateRecord(profile, 0), 'genesis-required')
  t.is(validateRecord(post, 0), 'genesis-required')
  t.is(validateRecord(certRec, 0), null)
  t.is(validateRecord(certRec, 1), 'cert-not-first')
  t.is(validateRecord(profile, 1), null)
  t.is(validateRecord(post, 2), null)
})

test('validateRecord: member-cert shape', async (t) => {
  await testnet(t)
  const rec = (c) => ({ type: 'member-cert', cert: c })
  t.is(validateRecord(rec(cert()), 0), null)
  t.is(validateRecord(rec(null), 0), 'malformed')
  t.is(validateRecord(rec([]), 0), 'malformed')
  t.is(validateRecord(rec(cert({ extra: 1 })), 0), 'malformed')
  const missing = cert()
  delete missing.method
  t.is(validateRecord(rec(missing), 0), 'malformed')
  t.is(validateRecord(rec(cert({ v: 2 })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ member: 'A'.repeat(64) })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ association: 'z'.repeat(64) })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ signature: 'c'.repeat(127) })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ signature: 'C'.repeat(128) })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ ageBand: '' })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ method: 5 })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ date: '' })), 0), 'malformed')
})

test('validateRecord: profile rules', async (t) => {
  await testnet(t)
  const p = (over) => ({ type: 'profile', name: 'Ana', bio: '', at: AT, ...over })
  t.is(validateRecord(p({ name: '' }), 1), 'name-length')
  t.is(validateRecord(p({ name: 5 }), 1), 'name-length')
  t.is(validateRecord(p({ name: 'x'.repeat(MAX_NAME) }), 1), null)
  t.is(validateRecord(p({ name: 'x'.repeat(MAX_NAME + 1) }), 1), 'name-length')
  t.is(validateRecord(p({ bio: 'x'.repeat(MAX_BIO) }), 1), null)
  t.is(validateRecord(p({ bio: 'x'.repeat(MAX_BIO + 1) }), 1), 'bio-length')
  t.is(validateRecord(p({ bio: null }), 1), 'bio-length')
  t.is(validateRecord(p({ name: 'a\nb' }), 1), 'control-chars')
  t.is(validateRecord(p({ name: 'a\tb' }), 1), 'control-chars')
  t.is(validateRecord(p({ bio: 'a\nb' }), 1), null)
  t.is(validateRecord(p({ bio: 'a\rb' }), 1), 'control-chars')
  t.is(validateRecord(p({ bio: 'a\u0000b' }), 1), 'control-chars')
  t.is(validateRecord(p({ at: '2026-13-01T00:00:00.000Z' }), 1), 'date-invalid')
  t.is(validateRecord(p({ at: 12345 }), 1), 'date-invalid')
  t.is(validateRecord(p({ at: undefined }), 1), 'date-invalid')
  t.is(validateRecord(p({ at: '2026-01-01' }), 1), 'date-invalid')
})

test('validateRecord: post rules', async (t) => {
  await testnet(t)
  const p = (over) => ({ type: 'post', text: 'oi', at: AT, replyTo: null, ...over })
  t.is(validateRecord(p({ text: '' }), 1), 'text-length')
  t.is(validateRecord(p({ text: 7 }), 1), 'text-length')
  t.is(validateRecord(p({ text: 'x'.repeat(MAX_TEXT) }), 1), null)
  t.is(validateRecord(p({ text: 'x'.repeat(MAX_TEXT + 1) }), 1), 'text-length')
  t.is(validateRecord(p({ text: 'a\nb' }), 1), null)
  t.is(validateRecord(p({ text: 'a\tb' }), 1), 'control-chars')
  t.is(validateRecord(p({ at: '2026-13-01T00:00:00.000Z' }), 1), 'date-invalid')
  t.is(validateRecord(p({ at: null }), 1), 'date-invalid')
  t.is(validateRecord(p({ replyTo: { author: K1, seq: 1 } }), 1), null)
  t.is(validateRecord(p({ replyTo: { author: K1, seq: 0 } }), 1), 'reply-invalid')
  t.is(validateRecord(p({ replyTo: { author: K1, seq: 1.5 } }), 1), 'reply-invalid')
  t.is(validateRecord(p({ replyTo: { author: 'A'.repeat(64), seq: 1 } }), 1), 'reply-invalid')
  t.is(validateRecord(p({ replyTo: { author: K1, seq: 1, extra: 1 } }), 1), 'reply-invalid')
  t.is(validateRecord(p({ replyTo: { author: K1 } }), 1), 'reply-invalid')
  t.is(validateRecord(p({ replyTo: undefined }), 1), 'reply-invalid')
  t.is(validateRecord(p({ replyTo: 'x' }), 1), 'reply-invalid')
})

test('records have exactly their keys (S3)', async (t) => {
  await testnet(t)
  const post = { type: 'post', text: 'oi', at: AT, replyTo: null }
  const profile = { type: 'profile', name: 'Ana', bio: '', at: AT }
  t.is(validateRecord(post, 1), null)
  t.is(validateRecord(profile, 1), null)
  t.is(validateRecord({ ...post, extra: 'x'.repeat(10) }, 1), 'malformed', 'post with an extra key')
  t.is(validateRecord({ ...post, media: null }, 1), 'malformed')
  t.is(validateRecord({ ...profile, extra: 1 }, 1), 'malformed', 'profile with an extra key')
  const noReply = { ...post }
  delete noReply.replyTo
  t.is(validateRecord(noReply, 1), 'malformed', 'post without replyTo')
  const noBio = { ...profile }
  delete noBio.bio
  t.is(validateRecord(noBio, 1), 'malformed', 'profile without bio')
  // The builders always write every key (replyTo null when absent).
  t.alike(Object.keys(postRecord({ text: 'oi', at: AT })), ['type', 'text', 'at', 'replyTo'])
  t.alike(Object.keys(profileRecord({ name: 'Ana', at: AT })), ['type', 'name', 'bio', 'at'])
})

test('forbidden characters in name, bio and text (S5)', async (t) => {
  await testnet(t)
  const profile = (over) => ({ type: 'profile', name: 'Ana', bio: 'oi', at: AT, ...over })
  const post = (over) => ({ type: 'post', text: 'oi', at: AT, replyTo: null, ...over })
  const forbidden = {
    DEL: '\u007f',
    'C1 NEL': '\u0085',
    'C1 0x9f': '\u009f',
    'line separator': '\u2028',
    'paragraph separator': '\u2029',
    LRE: '\u202a',
    RLO: '\u202e',
    LRI: '\u2066',
    PDI: '\u2069',
    ESC: '\u001b',
    CR: '\r'
  }
  for (const [label, ch] of Object.entries(forbidden)) {
    t.is(validateRecord(profile({ name: 'a' + ch + 'b' }), 1), 'control-chars', 'name: ' + label)
    t.is(validateRecord(profile({ bio: 'a' + ch + 'b' }), 1), 'control-chars', 'bio: ' + label)
    t.is(validateRecord(post({ text: 'a' + ch + 'b' }), 1), 'control-chars', 'text: ' + label)
  }
  // Neighbours of the forbidden ranges and ordinary non-ASCII stay valid.
  for (const ch of [' ', '\u2027', '\u202f', '\u2065', '\u206a', 'é', '😀', 'ç']) {
    t.is(validateRecord(profile({ bio: 'a' + ch + 'b' }), 1), null, 'bio allows ' + JSON.stringify(ch))
    t.is(validateRecord(post({ text: 'a' + ch + 'b' }), 1), null, 'text allows ' + JSON.stringify(ch))
  }
  t.is(validateRecord(post({ text: 'a\nb' }), 1), null, 'LF stays allowed in text')
  t.is(validateRecord(profile({ name: 'a\nb' }), 1), 'control-chars', 'LF stays forbidden in name')
  await t.exception.all(async () => postRecord({ text: 'x\u202ey' }), /control-chars/)
  await t.exception.all(async () => profileRecord({ name: 'x\u007f' }), /control-chars/)
})

test('validateRecord never throws', async (t) => {
  await testnet(t)
  const hostile = {
    get type () { throw new Error('boom') }
  }
  t.is(validateRecord(hostile, 1), 'malformed')
  const hostileText = { type: 'post', get text () { throw new Error('boom') }, at: AT, replyTo: null }
  t.is(validateRecord(hostileText, 1), 'malformed')
  t.is(validateRecord(Object.create(null), 1), 'malformed')
  for (const v of [undefined, null, 0, 'x', true, Symbol('s'), () => {}, NaN]) {
    t.is(validateRecord(v, 1), 'malformed')
  }
})

test('parseRef and formatRef', async (t) => {
  await testnet(t)
  t.alike(parseRef(K1 + ':3'), { author: K1, seq: 3 })
  t.alike(parseRef('A'.repeat(64) + ':0'), { author: K1, seq: 0 })
  t.is(parseRef(K1), null)
  t.is(parseRef(K1 + ':'), null)
  t.is(parseRef(K1 + ':-1'), null)
  t.is(parseRef(K1 + ':1.5'), null)
  t.is(parseRef(K1 + ':1a'), null)
  t.is(parseRef('abc:1'), null)
  t.is(parseRef(null), null)
  t.is(formatRef({ author: K1, seq: 4 }), K1 + ':4')
  t.alike(parseRef(formatRef({ author: K2, seq: 9 })), { author: K2, seq: 9 })
})

test('latestProfile ignores invalid blocks', async (t) => {
  await testnet(t)
  const entries = [
    { seq: 0, record: { type: 'member-cert', cert: cert() } },
    { seq: 1, record: { type: 'profile', name: 'Ana', bio: 'um', at: AT } },
    { seq: 2, record: { type: 'post', text: 'oi', at: AT, replyTo: null } },
    { seq: 3, record: { type: 'profile', name: 'Ana Maria', bio: 'dois', at: AT } },
    { seq: 4, record: { type: 'profile', name: '', bio: '', at: AT } },
    { seq: 5, record: null }
  ]
  t.alike(latestProfile(entries), { name: 'Ana Maria', bio: 'dois' })
  t.is(latestProfile(entries.slice(0, 1)), null)
  t.is(latestProfile([]), null)
  // a profile at seq 0 is invalid (genesis-required)
  t.is(latestProfile([{ seq: 0, record: { type: 'profile', name: 'X', bio: '', at: AT } }]), null)
})

test('genesisCert', async (t) => {
  await testnet(t)
  const c = cert()
  t.alike(genesisCert([{ seq: 0, record: { type: 'member-cert', cert: c } }]), c)
  t.is(genesisCert([{ seq: 0, record: { type: 'post', text: 'oi', at: AT, replyTo: null } }]), null)
  t.is(genesisCert([{ seq: 0, record: null }]), null)
  t.is(genesisCert([{ seq: 1, record: { type: 'member-cert', cert: c } }]), null)
  t.is(genesisCert([{ seq: 0, record: { type: 'member-cert', cert: cert({ v: 2 }) } }]), null)
  t.is(genesisCert([]), null)
})

test('member-cert shape matches cert.js field rules', async (t) => {
  await testnet(t)
  const rec = (c) => ({ type: 'member-cert', cert: c })
  t.is(validateRecord(rec(cert({ date: 'not-a-date' })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ date: '2026-13-01T00:00:00.000Z' })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ date: '2026-01-01' })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ ageBand: 'Adulto X' })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ method: 'Stub' })), 0), 'malformed')
  t.is(validateRecord(rec(cert({ method: 'x'.repeat(33) })), 0), 'malformed')
  await t.exception.all(async () => memberCertRecord(cert({ date: 'not-a-date' })), /malformed/)
})

test('parseRef rejects non-canonical and unsafe seqs; replies need safe seqs', async (t) => {
  await testnet(t)
  t.is(parseRef(K1 + ':9007199254740993'), null)
  t.is(parseRef(K1 + ':9007199254740992'), null)
  t.alike(parseRef(K1 + ':9007199254740991'), { author: K1, seq: 9007199254740991 })
  t.is(parseRef(K1 + ':01'), null)
  t.is(parseRef(K1 + ':00'), null)
  t.alike(parseRef(K1 + ':10'), { author: K1, seq: 10 })
  const p = (seq) => ({ type: 'post', text: 'oi', at: AT, replyTo: { author: K1, seq } })
  t.is(validateRecord(p(2 ** 53), 1), 'reply-invalid')
  t.is(validateRecord(p(Number.MAX_SAFE_INTEGER), 1), null)
})

test('latestProfile and genesisCert return copies', async (t) => {
  await testnet(t)
  const c = cert()
  const entries = [
    { seq: 0, record: { type: 'member-cert', cert: c } },
    { seq: 1, record: { type: 'profile', name: 'Ana', bio: 'um', at: AT } }
  ]
  const got = genesisCert(entries)
  t.alike(got, cert())
  t.not(got, c)
  got.member = K2
  t.is(entries[0].record.cert.member, K1)

  const prof = latestProfile(entries)
  prof.name = 'Outra'
  t.is(entries[1].record.name, 'Ana')

  // a profile whose name changes after the first read: the value read once
  // is the one validated and returned
  let reads = 0
  const shifty = { type: 'profile', get name () { return reads++ === 0 ? 'Ana' : 'x'.repeat(500) }, bio: '', at: AT }
  t.alike(latestProfile([{ seq: 1, record: shifty }]), { name: 'Ana', bio: '' })
})

test('validRecordCopy skips a revoked proxy or a throwing prototype trap', async (t) => {
  await testnet(t)
  const { proxy, revoke } = Proxy.revocable({ type: 'post', text: 'oi', at: AT, replyTo: null }, {})
  revoke()
  const trap = new Proxy({ type: 'post', text: 'oi', at: AT, replyTo: null }, {
    getPrototypeOf () { throw new Error('boom') }
  })
  for (const hostile of [proxy, trap]) {
    t.execution(() => records.validRecordCopy(hostile, 1))
    t.is(records.validRecordCopy(hostile, 1), null)
  }
  t.is(latestProfile([{ seq: 1, record: proxy }]), null)
})
