const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir } = require('./helpers/net')
const cert = require('@varanda/core/lib/cert')

const LF = '\n'
const MEMBER = 'ab'.repeat(32)
const SEEDER = 'ef'.repeat(32)
const DATE = '2026-10-19T00:00:00.000Z'

function fixture () {
  const kp = crypto.keyPair()
  return { kp, assocHex: b4a.toString(kp.publicKey, 'hex') }
}

test('createCert and verifyCert round trip', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const c = cert.createCert({ member: MEMBER }, kp)
  t.alike(Object.keys(c).sort(), ['ageBand', 'association', 'date', 'member', 'method', 'signature', 'v'])
  t.is(c.v, 1)
  t.is(c.ageBand, '18+')
  t.is(c.method, 'stub')
  t.is(c.association, assocHex)
  t.is(cert.validateCertShape(c), null)
  t.alike(cert.verifyCert(c, assocHex), { ok: true })
  t.alike(cert.verifyCert(c, assocHex.toUpperCase()), { ok: true })
  t.alike(cert.certForKey(c, MEMBER, assocHex), { ok: true })
})

test('malformed certificates', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const c = cert.createCert({ member: MEMBER, date: DATE }, kp)
  const without = { ...c }
  delete without.method
  const variants = {
    'missing key': without,
    'extra key': { ...c, extra: 1 },
    'v 2': { ...c, v: 2 },
    'uppercase hex': { ...c, member: c.member.toUpperCase() },
    'truncated signature': { ...c, signature: c.signature.slice(0, 126) },
    'ageBand with a space': { ...c, ageBand: '18 +' },
    'bad method': { ...c, method: 'Stub!' },
    'date without milliseconds': { ...c, date: '2026-10-19T00:00:00Z' },
    'invalid month': { ...c, date: '2026-13-01T00:00:00.000Z' },
    'numeric date': { ...c, date: 1760832000000 },
    array: [],
    string: 'cert'
  }
  for (const [name, v] of Object.entries(variants)) {
    t.is(cert.validateCertShape(v), 'malformed', name + ' shape')
    t.alike(cert.verifyCert(v, assocHex), { ok: false, reason: 'malformed' }, name)
    t.alike(cert.certForKey(v, MEMBER, assocHex), { ok: false, reason: 'malformed' }, name + ' certForKey')
  }
})

test('untrusted association, tampering and member mismatch', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const other = fixture()
  const c = cert.createCert({ member: MEMBER, date: DATE }, kp)
  t.alike(cert.verifyCert(c, other.assocHex), { ok: false, reason: 'untrusted-association' })
  t.alike(cert.verifyCert({ ...c, date: '2026-10-20T00:00:00.000Z' }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.verifyCert({ ...c, ageBand: '16-17' }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.certForKey(c, 'cd'.repeat(32), assocHex), { ok: false, reason: 'member-mismatch' })
  t.alike(cert.certForKey(c, MEMBER, other.assocHex), { ok: false, reason: 'untrusted-association' })
})

test('verifyCert never throws', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const c = cert.createCert({ member: MEMBER }, kp)
  const hostile = {}
  for (const k of Object.keys(c)) {
    Object.defineProperty(hostile, k, { enumerable: true, get () { throw new Error('boom') } })
  }
  for (const v of [null, undefined, 0, 'x', [], hostile, { ...c, date: '2026-13-01T00:00:00.000Z' }]) {
    t.is(cert.verifyCert(v, assocHex).ok, false)
    t.is(cert.certForKey(v, MEMBER, assocHex).ok, false)
    t.is(cert.validateCertShape(v), 'malformed')
  }
  t.alike(cert.verifyCert(c, 'zz'), { ok: false, reason: 'malformed' })
  t.alike(cert.verifyCert(c, null), { ok: false, reason: 'malformed' })
  t.is(cert.certForKey(c, null, assocHex).ok, false)
})

test('member certificate payload is exact', async (t) => {
  await testnet(t)
  const association = 'cd'.repeat(32)
  const c = { v: 1, member: MEMBER, ageBand: '18+', method: 'stub', date: DATE, association, signature: '' }
  const expected = b4a.from('varanda-cert-v1' + LF + MEMBER + LF + '18+' + LF + 'stub' + LF + DATE + LF + association, 'utf8')
  t.ok(b4a.equals(cert.certPayload(c), expected))
})

test('createCert normalizes and validates input', async (t) => {
  await testnet(t)
  const { kp } = fixture()
  const c = cert.createCert({ member: MEMBER.toUpperCase() }, kp)
  t.is(c.member, MEMBER)
  t.is(cert.validateCertShape(c), null)
  t.exception.all(() => cert.createCert({ member: 'abc' }, kp), TypeError)
  t.exception.all(() => cert.createCert({ member: MEMBER, ageBand: 'a b' }, kp), TypeError)
  t.exception.all(() => cert.createCert({ member: MEMBER, method: 'BAD' }, kp), TypeError)
  t.exception.all(() => cert.createCert({ member: MEMBER, date: '2026-10-19T00:00:00Z' }, kp), TypeError)
  t.exception.all(() => cert.createCert({ member: MEMBER, date: '2026-13-01T00:00:00.000Z' }, kp), TypeError)
  t.exception.all(() => cert.createCert({ member: MEMBER }, { publicKey: kp.publicKey, secretKey: b4a.alloc(32) }), TypeError)
})

test('isHex and normalizeHex', async (t) => {
  await testnet(t)
  t.ok(cert.isHex('aB'.repeat(32), 32))
  t.not(cert.isHex('ab', 32))
  t.not(cert.isHex(42, 1))
  t.not(cert.isHex('zz', 1))
  t.is(cert.normalizeHex('ABcd'), 'abcd')
  t.is(cert.normalizeHex('abc'), null)
  t.is(cert.normalizeHex('zz'), null)
  t.is(cert.normalizeHex(null), null)
})

test('seeder certificate round trip and payload', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const c = cert.createSeederCert({ seeder: SEEDER.toUpperCase() }, kp)
  t.alike(Object.keys(c).sort(), ['association', 'date', 'seeder', 'signature', 'v'])
  t.is(c.seeder, SEEDER)
  t.is(c.association, assocHex)
  t.is(cert.validateSeederCertShape(c), null)
  t.alike(cert.verifySeederCert(c, assocHex), { ok: true })
  t.alike(cert.seederCertForKey(c, SEEDER.toUpperCase(), assocHex), { ok: true })

  const association = 'cd'.repeat(32)
  const fixed = { v: 1, seeder: SEEDER, date: DATE, association, signature: '' }
  const expected = b4a.from('varanda-seeder-v1' + LF + SEEDER + LF + DATE + LF + association, 'utf8')
  t.ok(b4a.equals(cert.seederCertPayload(fixed), expected))

  t.exception.all(() => cert.createSeederCert({ seeder: 'abc' }, kp), TypeError)
  t.exception.all(() => cert.createSeederCert({ seeder: SEEDER, date: '2026-13-01T00:00:00.000Z' }, kp), TypeError)
  t.exception.all(() => cert.createSeederCert({ seeder: SEEDER }, { publicKey: kp.publicKey, secretKey: b4a.alloc(10) }), TypeError)
})

test('seeder certificate malformed, untrusted, tampered, mismatch', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const other = fixture()
  const c = cert.createSeederCert({ seeder: SEEDER, date: DATE }, kp)
  const without = { ...c }
  delete without.date
  const variants = {
    'missing key': without,
    'extra key': { ...c, extra: 1 },
    'v 2': { ...c, v: 2 },
    'uppercase seeder': { ...c, seeder: c.seeder.toUpperCase() },
    'uppercase signature': { ...c, signature: c.signature.toUpperCase() },
    'truncated signature': { ...c, signature: c.signature.slice(2) },
    'date without milliseconds': { ...c, date: '2026-10-19T00:00:00Z' },
    'invalid month': { ...c, date: '2026-13-01T00:00:00.000Z' },
    'four keys': { v: 1, seeder: c.seeder, date: c.date, association: c.association }
  }
  for (const [name, v] of Object.entries(variants)) {
    t.is(cert.validateSeederCertShape(v), 'malformed', name + ' shape')
    t.alike(cert.verifySeederCert(v, assocHex), { ok: false, reason: 'malformed' }, name)
    t.alike(cert.seederCertForKey(v, SEEDER, assocHex), { ok: false, reason: 'malformed' }, name + ' seederCertForKey')
  }
  t.alike(cert.verifySeederCert(c, other.assocHex), { ok: false, reason: 'untrusted-association' })
  t.alike(cert.verifySeederCert({ ...c, date: '2026-10-20T00:00:00.000Z' }, assocHex), { ok: false, reason: 'bad-signature' })
  t.alike(cert.seederCertForKey(c, 'cd'.repeat(32), assocHex), { ok: false, reason: 'seeder-mismatch' })
  t.alike(cert.seederCertForKey(c, SEEDER, other.assocHex), { ok: false, reason: 'untrusted-association' })
})

test('domain separation between member and seeder signatures', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  // A member signature over the member payload where member === seeder key and same date.
  const m = cert.createCert({ member: SEEDER, date: DATE }, kp)
  const forged = { v: 1, seeder: SEEDER, date: DATE, association: assocHex, signature: m.signature }
  t.is(cert.validateSeederCertShape(forged), null)
  t.alike(cert.verifySeederCert(forged, assocHex), { ok: false, reason: 'bad-signature' })
  // And a seeder signature placed in a member certificate.
  const s = cert.createSeederCert({ seeder: SEEDER, date: DATE }, kp)
  const forgedMember = { ...m, signature: s.signature }
  t.alike(cert.verifyCert(forgedMember, assocHex), { ok: false, reason: 'bad-signature' })
})

test('verifySeederCert never throws', async (t) => {
  await testnet(t)
  const { kp, assocHex } = fixture()
  const c = cert.createSeederCert({ seeder: SEEDER }, kp)
  const hostile = {}
  for (const k of Object.keys(c)) {
    Object.defineProperty(hostile, k, { enumerable: true, get () { throw new Error('boom') } })
  }
  for (const v of [null, undefined, 0, 'x', [], hostile, { ...c, date: '2026-13-01T00:00:00.000Z' }, { ...c, date: 5 }]) {
    t.is(cert.verifySeederCert(v, assocHex).ok, false)
    t.is(cert.seederCertForKey(v, SEEDER, assocHex).ok, false)
    t.is(cert.validateSeederCertShape(v), 'malformed')
  }
  t.alike(cert.verifySeederCert(c, 'zz'), { ok: false, reason: 'malformed' })
  t.is(cert.seederCertForKey(c, null, assocHex).ok, false)
})

test('key pair files: round trip, permissions, garbage', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const kp = cert.generateAssociationKeyPair()
  const file = path.join(dir, 'nested', 'deep', 'key.json')
  cert.saveKeyPairFile(file, kp)
  t.is(fs.statSync(file).mode & 0o077, 0)
  t.is(fs.statSync(path.dirname(file)).mode & 0o077, 0)
  t.absent(fs.existsSync(file + '.tmp'))
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  t.alike(Object.keys(stored), ['v', 'publicKey', 'secretKey'])
  t.is(stored.v, 1)
  const loaded = cert.loadKeyPairFile(file)
  t.ok(b4a.equals(loaded.publicKey, kp.publicKey))
  t.ok(b4a.equals(loaded.secretKey, kp.secretKey))

  const afile = path.join(dir, 'association.json')
  cert.saveAssociationKeyPair(afile, kp)
  t.is(fs.statSync(afile).mode & 0o077, 0)
  const aloaded = cert.loadAssociationKeyPair(afile)
  t.ok(b4a.equals(aloaded.publicKey, kp.publicKey))
  t.ok(b4a.equals(aloaded.secretKey, kp.secretKey))

  const garbage = [
    'not json',
    '[]',
    JSON.stringify({ v: 2, publicKey: stored.publicKey, secretKey: stored.secretKey }),
    JSON.stringify({ v: 1, publicKey: stored.publicKey }),
    JSON.stringify({ v: 1, publicKey: stored.publicKey.toUpperCase(), secretKey: stored.secretKey }),
    JSON.stringify({ v: 1, publicKey: stored.publicKey, secretKey: stored.secretKey.slice(2) })
  ]
  for (const text of garbage) {
    const bad = path.join(dir, 'bad.json')
    fs.writeFileSync(bad, text)
    t.exception(() => cert.loadKeyPairFile(bad), /arquivo de chave inválido/)
    t.exception(() => cert.loadAssociationKeyPair(bad), /chave da associação inválida/)
  }
})

test('saveKeyPairFile: no clobber by default, overwrite on request, private dir', async (t) => {
  await testnet(t)
  const dir = path.join(tmpDir(t), 'keys')
  fs.mkdirSync(dir, { mode: 0o755 })
  fs.chmodSync(dir, 0o755)
  const file = path.join(dir, 'seeder-key.json')
  const kp1 = cert.generateAssociationKeyPair()
  const kp2 = cert.generateAssociationKeyPair()
  cert.saveKeyPairFile(file, kp1)
  t.is(fs.statSync(dir).mode & 0o077, 0)
  try {
    cert.saveKeyPairFile(file, kp2)
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'EEXIST')
    t.is(err.message, 'arquivo de chave já existe')
  }
  t.ok(b4a.equals(cert.loadKeyPairFile(file).publicKey, kp1.publicKey))
  cert.saveKeyPairFile(file, kp2, { overwrite: true })
  t.ok(b4a.equals(cert.loadKeyPairFile(file).publicKey, kp2.publicKey))
  t.is(fs.statSync(file).mode & 0o077, 0)
  t.alike(fs.readdirSync(dir), ['seeder-key.json'])
})

test('key files: a symlinked key file or directory is refused', async (t) => {
  await testnet(t)
  const outside = tmpDir(t)
  const realDir = path.join(outside, 'real')
  const realFile = path.join(realDir, 'key.json')
  const kp = cert.generateAssociationKeyPair()
  cert.saveKeyPairFile(realFile, kp)
  const before = fs.readFileSync(realFile, 'utf8')
  fs.chmodSync(realDir, 0o755)

  // planted symlink as the key file: never followed on read
  const dir = tmpDir(t)
  const linked = path.join(dir, 'key.json')
  fs.symlinkSync(realFile, linked)
  t.exception(() => cert.loadKeyPairFile(linked), /arquivo de chave inválido/)
  t.exception(() => cert.loadAssociationKeyPair(linked), /chave da associação inválida/)

  // planted symlink as the directory: refused on save and on load
  const linkDir = path.join(tmpDir(t), 'keys')
  fs.symlinkSync(realDir, linkDir)
  t.exception(() => cert.saveKeyPairFile(path.join(linkDir, 'other.json'), kp), /diretório é um link simbólico/)
  t.exception(() => cert.saveKeyPairFile(path.join(linkDir, 'key.json'), kp, { overwrite: true }), /diretório é um link simbólico/)
  t.exception(() => cert.loadKeyPairFile(path.join(linkDir, 'key.json')), /diretório é um link simbólico/)

  t.is(fs.readFileSync(realFile, 'utf8'), before, 'target key untouched')
  t.alike(fs.readdirSync(realDir), ['key.json'], 'nothing written in the target dir')
  t.is(fs.statSync(realDir).mode & 0o777, 0o755, 'target dir mode untouched')
  // a missing key file keeps its ENOENT code
  try {
    cert.loadKeyPairFile(path.join(dir, 'missing.json'))
    t.fail('should throw')
  } catch (err) {
    t.is(err.code, 'ENOENT')
  }
})

test('key files: a FIFO at the key path is rejected at once', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const fifo = path.join(dir, 'key.json')
  const made = spawnSync('mkfifo', [fifo])
  if (made.error || made.status !== 0) {
    t.comment('mkfifo unavailable: FIFO test skipped')
    t.pass('skipped')
    return
  }
  // Nobody ever writes to the FIFO: without O_NONBLOCK the open would hang.
  const started = Date.now()
  t.exception(() => cert.loadKeyPairFile(fifo), /arquivo de chave inválido/)
  t.exception(() => cert.loadAssociationKeyPair(fifo), /chave da associação inválida/)
  t.ok(Date.now() - started < 2000, 'rejected immediately')
  t.ok(fs.lstatSync(fifo).isFIFO(), 'FIFO untouched')
})
