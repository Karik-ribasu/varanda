'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const b4a = require('b4a')
const { discoveryKey } = require('hypercore-crypto')
const { testnet, tmpDir } = require('./helpers/net')
const { verifySeederCert, verifyCert } = require('../lib/cert')
const { openStore, openDiary, appendRecord } = require('../lib/store')
const { postRecord } = require('../lib/records')

const BIN = path.join(__dirname, '..', 'bin', 'somos.js')
const HEX64 = /^[0-9a-f]{64}$/

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('SOMOS_')) env[k] = v

const outputs = []

function somos (dataDir, args) {
  const r = spawnSync(process.execPath, [BIN, ...args, '--data', dataDir], { env, encoding: 'utf8', timeout: 60000 })
  outputs.push(r.stdout)
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function somosAsync (dataDir, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args, '--data', dataDir], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => { outputs.push(stdout); resolve({ code, stdout, stderr }) })
  })
}

async function hasCoreFor (dataDir, hexKey) {
  const store = await openStore(dataDir)
  try {
    return await store.storage.hasCore(discoveryKey(b4a.from(hexKey, 'hex')))
  } finally {
    await store.close()
  }
}

function lastJson (r) {
  const lines = r.stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

test('assoc commands', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const dir2 = tmpDir(t)

  const init = somos(dir, ['assoc', 'init', '--json'])
  t.is(init.code, 0)
  const pub = lastJson(init).publicKey
  t.ok(HEX64.test(pub), 'public key is hex64')
  t.is(somos(dir, ['assoc', 'init']).code, 1, 'second init fails')
  t.is(lastJson(somos(dir, ['assoc', 'show', '--json'])).publicKey, pub, 'show returns the same key')
  t.is(somos(dir, ['assoc', 'show']).stdout.trim(), 'chave pública da associação: ' + pub)
  t.is(somos(dir, ['assoc', 'certify']).code, 2, 'certify without --member is a usage error')
  t.is(somos(dir, ['assoc', 'bogus']).code, 2, 'unknown subcommand is a usage error')

  // certify-seeder (R5.2 f)
  const seeder = crypto.randomBytes(32).toString('hex')
  const out = path.join(dir2, 'seeder-cert.json')
  const r = somos(dir, ['assoc', 'certify-seeder', '--seeder', seeder, '--out', out, '--json'])
  t.is(r.code, 0)
  t.is(lastJson(r).out, out)
  const cert = JSON.parse(fs.readFileSync(out, 'utf8'))
  t.ok(fs.readFileSync(out, 'utf8').endsWith('}\n'), 'pretty JSON with LF')
  t.is(cert.seeder, seeder)
  t.alike(verifySeederCert(cert, pub), { ok: true }, 'seeder certificate verifies')
  const lines = fs.readFileSync(path.join(dir, 'seeders.jsonl'), 'utf8').trim().split('\n')
  t.is(lines.length, 1)
  const row = JSON.parse(lines[0])
  t.alike(Object.keys(row).sort(), ['date', 'seeder'])
  t.is(row.seeder, seeder)
  t.is(somos(dir, ['assoc', 'certify-seeder']).code, 2, 'certify-seeder without --seeder is a usage error')
  const plain = somos(dir, ['assoc', 'certify-seeder', '--seeder', seeder])
  t.is(plain.code, 0)
  t.is(JSON.parse(plain.stdout.trim().split('\n')[0]).seeder, seeder, 'without --out prints the cert')

  const secret = JSON.parse(fs.readFileSync(path.join(dir, 'association.json'), 'utf8')).secretKey
  t.absent(outputs.some((o) => o.includes(secret)), 'stdout never contains the secret key')
})

test('member commands', async (t) => {
  await testnet(t)
  const assocDir = tmpDir(t)
  const assoc2Dir = tmpDir(t)
  const aDir = tmpDir(t)
  const bDir = tmpDir(t)
  const files = tmpDir(t)

  const pub = lastJson(somos(assocDir, ['assoc', 'init', '--json'])).publicKey
  const pub2 = lastJson(somos(assoc2Dir, ['assoc', 'init', '--json'])).publicKey

  // identity
  t.is(somos(aDir, ['id', 'create']).code, 2, 'id create without --association is a usage error')
  t.is(somos(aDir, ['id', 'show']).code, 1, 'id show without identity fails')
  const created = somos(aDir, ['id', 'create', '--association', pub, '--json'])
  t.is(created.code, 0)
  const A = lastJson(created).publicKey
  t.ok(HEX64.test(A))
  t.is(lastJson(created).association, pub)
  t.is(lastJson(somos(aDir, ['id', 'create', '--association', pub, '--json'])).publicKey, A, 'idempotent')
  t.is(lastJson(somos(aDir, ['id', 'create', '--json'])).publicKey, A, 'association optional later')
  t.is(somos(aDir, ['id', 'create', '--association', pub2]).code, 1, 'another association is an error')
  t.is(lastJson(somos(aDir, ['id', 'show', '--json'])).publicKey, A)
  t.is(somos(aDir, ['id', 'bogus']).code, 2)
  const B = lastJson(somos(bDir, ['id', 'create', '--association', pub, '--json'])).publicKey

  // publishing before the certificate
  const early = somos(aDir, ['profile', 'set', '--name', 'Ana'])
  t.is(early.code, 1)
  t.ok(early.stderr.includes('grave o certificado'), 'genesis-required message')
  t.is(somos(aDir, ['profile', 'set']).code, 2, 'profile set needs --name')
  t.is(somos(aDir, ['post']).code, 2, 'post needs --text')
  t.is(somos(aDir, ['reply', '--text', 'x']).code, 2, 'reply needs --to')

  // certificates
  const certFile = path.join(files, 'a.json')
  t.is(somos(assocDir, ['assoc', 'certify', '--member', A, '--out', certFile]).code, 0)
  const certB = path.join(files, 'b.json')
  somos(assocDir, ['assoc', 'certify', '--member', B, '--out', certB])
  const certOther = path.join(files, 'other.json')
  somos(assoc2Dir, ['assoc', 'certify', '--member', A, '--out', certOther])

  t.is(somos(aDir, ['cert', 'add']).code, 2, 'cert add needs --cert-file')
  const wrongKey = somos(aDir, ['cert', 'add', '--cert-file', certB])
  t.is(wrongKey.code, 1)
  t.ok(wrongKey.stderr.includes('member-mismatch'))
  const untrusted = somos(aDir, ['cert', 'add', '--cert-file', certOther])
  t.is(untrusted.code, 1)
  t.ok(untrusted.stderr.includes('untrusted-association'))
  const added = somos(aDir, ['cert', 'add', '--cert-file', certFile, '--json'])
  t.is(added.code, 0)
  t.alike(lastJson(added), { seq: 0 })
  t.is(somos(aDir, ['cert', 'add', '--cert-file', certFile]).code, 0, 'identical cert is ok again')
  t.is(somos(aDir, ['cert', 'bogus']).code, 2)

  // publishing
  t.alike(lastJson(somos(aDir, ['profile', 'set', '--name', 'Ana', '--bio', 'oi', '--json'])), { seq: 1 })
  const post = lastJson(somos(aDir, ['post', '--text', 'olá', '--json']))
  t.is(post.seq, 2)
  t.is(post.ref, A + ':2')
  t.is(somos(aDir, ['post', '--text', 'olá']).stdout.trim(), 'publicado #3')
  const reply = lastJson(somos(aDir, ['reply', '--to', A + ':2', '--text', 'concordo', '--json']))
  t.is(reply.seq, 4)
  t.is(somos(aDir, ['reply', '--to', A + ':0', '--text', 'x']).code, 2, 'reply to block 0 is a usage error')

  const feed = lastJson(somos(aDir, ['feed', '--json']))
  const replyItem = feed.items.find((i) => i.seq === 4)
  t.alike(replyItem.replyTo, { author: A, seq: 2 })
  t.is(replyItem.name, 'Ana')
  t.alike(feed.skipped, [])
  t.alike(feed.future, [])
  t.is(lastJson(somos(aDir, ['feed', '--limit', '1', '--json'])).items.length, 1)
  t.ok(somos(aDir, ['feed']).stdout.includes('concordo'))

  // log
  const log = lastJson(somos(aDir, ['log', '--json']))
  t.is(log.key, A)
  t.is(log.entries[0].record.type, 'member-cert')
  t.is(log.entries.length, 5)

  // follows
  t.alike(lastJson(somos(aDir, ['follows', '--json'])), { follows: [] })
  const f1 = lastJson(somos(aDir, ['follow', '--author', B, '--json']))
  t.alike(f1, { follows: [B], changed: true })
  t.alike(lastJson(somos(aDir, ['follow', '--author', B, '--json'])), { follows: [B], changed: false })
  t.alike(lastJson(somos(aDir, ['follows', '--json'])), { follows: [B] })
  t.is(somos(aDir, ['follows']).stdout.trim(), B)
  t.is(somos(aDir, ['follow', '--author', A]).code, 1, 'following self fails')
  t.is(somos(aDir, ['follow']).code, 2)
  t.alike(lastJson(somos(aDir, ['unfollow', '--author', B, '--json'])), { follows: [], changed: true })
  t.alike(lastJson(somos(aDir, ['unfollow', '--author', B, '--json'])), { follows: [], changed: false })

  // B follows A with no local data
  t.is(somos(bDir, ['follow', '--author', A]).code, 0)
  const feedB = somos(bDir, ['feed', '--json'])
  t.is(feedB.code, 0)
  t.alike(lastJson(feedB).skipped, [{ key: A, reason: 'no-cert' }])
  t.ok(feedB.stderr.includes('aviso: diário ' + A.slice(0, 8) + ' ignorado (no-cert)'))
  t.alike(lastJson(somos(bDir, ['feed', '--json'])).skipped, [{ key: A, reason: 'no-cert' }], 'second feed')
  t.absent(await hasCoreFor(bDir, A), 'feed leaves no core for a key with no local data')
  const logA = somos(bDir, ['log', '--author', A, '--json'])
  t.is(logA.code, 1, 'log of a key with no local data is refused')
  t.ok(logA.stderr.includes('sem dados locais'))

  t.is(somos(bDir, ['unfollow', '--author', A]).code, 0)
  t.absent(await hasCoreFor(bDir, A), 'no orphan core after unfollow')

  // future-dated post (R5.10)
  const store = await openStore(aDir)
  try {
    const diary = await openDiary(store)
    const at = new Date(Date.now() + 25 * 3600 * 1000).toISOString()
    await appendRecord(diary, postRecord({ text: 'do futuro', at }))
  } finally {
    await store.close()
  }
  const futureFeed = somos(aDir, ['feed', '--json'])
  const ref = A + ':5'
  const fj = lastJson(futureFeed)
  t.alike(fj.future, [ref])
  t.absent(fj.items.some((i) => i.text === 'do futuro'), 'future post is not in items')
  t.ok(futureFeed.stderr.includes('aviso: publicação ' + ref + ' ignorada (future)'))

  // a member certificate verifies with its own association only
  t.alike(verifyCert(JSON.parse(fs.readFileSync(certFile, 'utf8')), pub), { ok: true })

  const secret = JSON.parse(fs.readFileSync(path.join(assocDir, 'association.json'), 'utf8')).secretKey
  t.absent(outputs.some((o) => o.includes(secret)), 'stdout never contains the secret key')
})

test('follow refuses when follows.json already holds MAX_INVENTORY - 1 keys (item 4b)', async (t) => {
  await testnet(t)
  const { MAX_INVENTORY } = require('../lib/net')
  const dir = tmpDir(t)
  t.is(somos(dir, ['id', 'create', '--association', 'c'.repeat(64)]).code, 0)
  const follows = []
  for (let i = 0; i < MAX_INVENTORY - 1; i++) follows.push(i.toString(16).padStart(64, '0'))
  fs.writeFileSync(path.join(dir, 'follows.json'), JSON.stringify({ v: 1, follows }))
  const r = somos(dir, ['follow', '--author', 'ab'.repeat(32)])
  t.is(r.code, 1)
  t.ok(r.stderr.includes('erro: limite de diários seguidos atingido'), r.stderr)
  t.is(lastJson(somos(dir, ['follows', '--json'])).follows.length, MAX_INVENTORY - 1, 'unchanged')
  t.is(somos(dir, ['follow', '--author', follows[0]]).code, 0, 'an already followed key is still idempotent')
  t.is(somos(dir, ['unfollow', '--author', follows[0]]).code, 0)
  t.is(somos(dir, ['follow', '--author', 'ab'.repeat(32)]).code, 0, 'room again after an unfollow')
})

test('concurrent id create keeps one trust root', async (t) => {
  await testnet(t)
  const assocDir = tmpDir(t)
  const assoc2Dir = tmpDir(t)
  const dir = tmpDir(t)
  const pub = lastJson(somos(assocDir, ['assoc', 'init', '--json'])).publicKey
  const pub2 = lastJson(somos(assoc2Dir, ['assoc', 'init', '--json'])).publicKey

  for (let round = 0; round < 3; round++) {
    const d = path.join(dir, 'r' + round)
    const results = await Promise.all([
      somosAsync(d, ['id', 'create', '--association', pub, '--json']),
      somosAsync(d, ['id', 'create', '--association', pub2, '--json'])
    ])
    const winners = results.filter((r) => r.code === 0)
    t.is(winners.length, 1, 'exactly one id create succeeds (round ' + round + ')')
    const loser = results.find((r) => r.code !== 0)
    t.is(loser.code, 1, 'the loser exits 1')
    const winner = lastJson(winners[0]).association
    const config = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'))
    t.is(config.association, winner, 'config.json holds the winner association')
    t.absent(fs.readdirSync(d).some((f) => f.endsWith('.tmp')), 'no temp file left')
    t.is(lastJson(somos(d, ['id', 'show', '--json'])).association, winner)
  }
})

test('log --author and follows reject a mismatching association', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const pub = 'c'.repeat(64)
  const other = 'e'.repeat(64)
  const author = 'ab'.repeat(32)
  t.is(somos(dir, ['id', 'create', '--association', pub]).code, 0)
  t.is(somos(dir, ['follow', '--author', author]).code, 0)

  for (const args of [['log', '--author', author], ['follows']]) {
    const flag = somos(dir, [...args, '--association', other])
    t.is(flag.code, 1, args[0] + ' with --association of another association fails')
    t.ok(flag.stderr.includes('associação diferente da configurada'))
    const r = spawnSync(process.execPath, [BIN, ...args, '--data', dir], {
      env: { ...env, SOMOS_ASSOCIATION: other },
      encoding: 'utf8',
      timeout: 60000
    })
    t.is(r.status, 1, args[0] + ' with SOMOS_ASSOCIATION of another association fails')
    t.ok(r.stderr.includes('associação diferente da configurada'))
    const ok = somos(dir, [...args, '--association', pub])
    if (args[0] === 'log') {
      // The association passes; the key has no local data (D).
      t.ok(ok.stderr.includes('sem dados locais'), 'log gets past the association check')
    } else {
      t.is(ok.code, 0, args[0] + ' with the configured association')
    }
  }
  t.alike(lastJson(somos(dir, ['follows', '--json'])), { follows: [author] })
})

test('feed reports an empty forked replica as fork', async (t) => {
  await testnet(t)
  const authorDir = tmpDir(t)
  const bDir = tmpDir(t)
  const pub = 'c'.repeat(64)
  t.is(somos(bDir, ['id', 'create', '--association', pub]).code, 0)

  const certRecord = (member) => ({
    type: 'member-cert',
    cert: { v: 1, member, ageBand: '18+', method: 'stub', date: '2026-01-01T00:00:00.000Z', association: pub, signature: 'd'.repeat(128) }
  })
  const aStore = await openStore(authorDir)
  const bStore = await openStore(bDir)
  let A
  try {
    const aDiary = await openDiary(aStore)
    A = b4a.toString(aDiary.key, 'hex')
    await appendRecord(aDiary, certRecord(A))

    const s1 = aStore.replicate(true)
    const s2 = bStore.replicate(false)
    s1.pipe(s2).pipe(s1)
    const replica = bStore.get({ key: aDiary.key, valueEncoding: 'json' })
    await replica.ready()
    await replica.get(0, { timeout: 30000 })
    t.is(replica.contiguousLength, 1, 'the 1-block author core is replicated')

    // The author rewrites history: truncate to 0, then append again.
    await aDiary.truncate(0)
    await appendRecord(aDiary, certRecord(A))
    const deadline = Date.now() + 30000
    while (replica.fork === 0 && Date.now() < deadline) {
      await replica.update({ wait: true }).catch(() => {})
      if (replica.fork === 0) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    t.is(replica.fork, 1, 'the replica followed the fork')
    s1.destroy()
    s2.destroy()
    // The rewritten block may have been fetched along with the fork proof:
    // clear it locally (the fork number stays) to get an empty forked replica.
    if (replica.contiguousLength > 0) await replica.clear(0, replica.length)
    t.is(replica.contiguousLength, 0, 'the forked replica is empty locally')
  } finally {
    await bStore.close()
    await aStore.close()
  }

  t.is(somos(bDir, ['follow', '--author', A]).code, 0)
  const feed = somos(bDir, ['feed', '--json'])
  t.is(feed.code, 0)
  t.alike(lastJson(feed).skipped, [{ key: A, reason: 'fork' }])
  t.ok(feed.stderr.includes('ignorado (fork)'))
})

test('publishConfig fsyncs the file and the directory and leaves no temp (B)', async (t) => {
  const { publishConfig } = require('../lib/commands/member')
  const dir = tmpDir(t)
  const config = { v: 1, role: 'member', association: 'c'.repeat(64) }
  const origFsync = fs.fsyncSync
  const kinds = []
  fs.fsyncSync = (fd) => {
    kinds.push(fs.fstatSync(fd).isDirectory() ? 'dir' : 'file')
    return origFsync(fd)
  }
  try {
    t.is(publishConfig(dir, config), true)
  } finally {
    fs.fsyncSync = origFsync
  }
  t.alike(kinds, ['file', 'dir'], 'file fsync, then directory fsync after the link')
  t.alike(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), config)
  t.alike(fs.readdirSync(dir), ['config.json'], 'no temp file left')
  t.is(publishConfig(dir, config), false, 'EEXIST: another writer published first')
  t.alike(fs.readdirSync(dir), ['config.json'], 'no temp file after EEXIST')

  const dir2 = tmpDir(t)
  const origWrite = fs.writeFileSync
  fs.writeFileSync = () => { throw new Error('disco cheio') }
  try {
    t.exception(() => publishConfig(dir2, config), /disco cheio/)
  } finally {
    fs.writeFileSync = origWrite
  }
  t.alike(fs.readdirSync(dir2), [], 'a failing write leaves no temp file')
})

test('feed skips own key, bad entries and duplicates in follows.json (C)', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  const own = lastJson(somos(dir, ['id', 'create', '--association', 'c'.repeat(64), '--json'])).publicKey
  const other = 'ab'.repeat(32)
  const bad64 = 'g'.repeat(64)
  fs.writeFileSync(path.join(dir, 'follows.json'), JSON.stringify({
    v: 1,
    follows: [own, 'zz', bad64, other, other.toUpperCase(), other]
  }))
  const r = somos(dir, ['feed', '--json'])
  t.is(r.code, 0, r.stderr)
  const out = lastJson(r)
  t.alike(out.items, [])
  t.alike(out.skipped, [{ key: other, reason: 'no-cert' }], 'the duplicate is handled once')
  t.is(r.stderr.split('entrada inválida').length - 1, 2, 'one warning per bad entry')
  t.ok(await hasCoreFor(dir, own), 'the diary core was not purged')
  t.absent(await hasCoreFor(dir, other), 'no core created')
})

test('log --author refuses a key with no local data and creates nothing (D)', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  t.is(somos(dir, ['id', 'create', '--association', 'c'.repeat(64)]).code, 0)
  const other = 'cd'.repeat(32)
  const r = somos(dir, ['log', '--author', other])
  t.is(r.code, 1)
  t.ok(r.stderr.includes('sem dados locais'), r.stderr)
  t.absent(await hasCoreFor(dir, other), 'no core created')
})

test('log never prints C1, DEL or bidi controls raw (H4)', async (t) => {
  await testnet(t)
  const dir = tmpDir(t)
  t.is(somos(dir, ['id', 'create', '--association', 'c'.repeat(64)]).code, 0)
  const hostile = 'a\u009b31m\u009d0;x\u009c\u007f\u2028\u2029\u202e\u2066z'
  const store = await openStore(dir)
  try {
    const diary = await openDiary(store)
    await diary.append({ type: 'post', text: hostile, extra: hostile })
  } finally {
    await store.close()
  }
  const unsafe = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
  for (const args of [['log'], ['log', '--json']]) {
    const r = somos(dir, args)
    t.is(r.code, 0)
    t.absent(unsafe.test(r.stdout), args.join(' ') + ' prints no raw control')
  }
  const entries = lastJson(somos(dir, ['log', '--json'])).entries
  t.is(entries[entries.length - 1].record.text, hostile, 'escaped output parses back to the same text')
})
