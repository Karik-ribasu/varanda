#!/usr/bin/env node
// Non-interactive phase 0 demo (npm run demo): an in-process DHT testnet on
// 127.0.0.1 (the public DHT is never contacted), every command run through
// bin/varanda.js as a child process. Exit 0 on success ('DEMO OK'); on the first
// failure prints 'DEMO FALHOU: <passo>' plus the child's output and exits 1.
// Flags: --keep (or VARANDA_DEMO_KEEP=1) keeps the data directory.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const BIN = path.join(ROOT, 'bin', 'varanda.js')
const WATCHDOG_MS = 150000
const STEP_TIMEOUT_MS = 60000
const READY_TIMEOUT_MS = 20000
const EXIT_TIMEOUT_MS = 10000
const STRAGGLER_MS = 5000
const SYNC_TIMEOUT_MS = 30000

const keep = process.argv.includes('--keep') || process.env.VARANDA_DEMO_KEEP === '1'
const dir = path.join(os.tmpdir(), 'varanda-demo-' + process.pid)
const children = new Set()
let net = null
let env = null

class StepError extends Error {
  constructor (step, detail, output = '') {
    super(detail ? step + ': ' + detail : step)
    this.step = step
    this.output = output
  }
}

function say (line) {
  process.stdout.write(line + '\n')
}

function short (hex) {
  return String(hex).slice(0, 8)
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function outputOf (r) {
  return '--- stdout ---\n' + (r.stdout || '') + '\n--- stderr ---\n' + (r.stderr || '') + '\n'
}

// Every child (short execFile commands and long spawns) is registered in
// `children` until it exits, so cleanup can terminate whatever is still
// running before the data directory is removed.
function register (name, child) {
  const proc = { name, child, exit: null }
  proc.exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      proc.exit = { code, signal }
      children.delete(proc)
      resolve(proc.exit)
    })
  })
  child.on('error', () => {})
  children.add(proc)
  return proc
}

// Runs one short CLI command with --json and parses the LAST stdout line.
function run (args) {
  return new Promise((resolve) => {
    const opts = { cwd: ROOT, env, timeout: STEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
    const child = execFile(process.execPath, [BIN, ...args, '--json'], opts, (err, stdout, stderr) => {
      let code = 0
      if (err) code = typeof err.code === 'number' ? err.code : null
      const lines = stdout.trim().split('\n')
      let json = null
      try {
        json = JSON.parse(lines[lines.length - 1])
      } catch {}
      resolve({ code, stdout, stderr, json, killed: Boolean(err && err.killed) })
    })
    register('varanda ' + args[0], child)
  })
}

// A short command that must exit 0 with a JSON result.
async function ok (step, args) {
  const r = await run(args)
  if (r.killed) throw new StepError(step, 'tempo esgotado', outputOf(r))
  if (r.code !== 0) throw new StepError(step, 'saída ' + r.code, outputOf(r))
  if (r.json === null || typeof r.json !== 'object') throw new StepError(step, 'sem resultado JSON', outputOf(r))
  return r
}

// A short command that must fail with exit `code` and `text` on stderr.
async function refused (step, args, code, text) {
  const r = await run(args)
  if (r.killed) throw new StepError(step, 'tempo esgotado', outputOf(r))
  if (r.code !== code) throw new StepError(step, 'saída ' + r.code + ' (esperava ' + code + ')', outputOf(r))
  if (!r.stderr.includes(text)) throw new StepError(step, 'stderr sem "' + text + '"', outputOf(r))
  return r
}

function check (step, condition, detail, output) {
  if (!condition) throw new StepError(step, detail, output)
}

// A long-running child (seed): stdin ignored, both pipes consumed
// continuously, stdout split into lines for waitLine().
function spawnLong (name, args) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const proc = register(name, child)
  Object.assign(proc, { stdout: '', stderr: '', lines: [], waiters: new Set() })
  proc.exited.then(() => { for (const w of proc.waiters) w() })
  let partial = ''
  child.stdout.on('data', (d) => {
    proc.stdout += d
    partial += d
    const parts = partial.split('\n')
    partial = parts.pop()
    for (const line of parts) proc.lines.push(line)
    if (parts.length) for (const w of proc.waiters) w()
  })
  child.stderr.on('data', (d) => { proc.stderr += d })
  return proc
}

function waitLine (proc, predicate, timeoutMs, step) {
  return new Promise((resolve, reject) => {
    let timer = null
    const done = (fn) => {
      proc.waiters.delete(check)
      if (timer) clearTimeout(timer)
      fn()
    }
    const check = () => {
      const line = proc.lines.find(predicate)
      if (line !== undefined) return done(() => resolve(line))
      if (proc.exit) return done(() => reject(new StepError(step, proc.name + ' terminou antes da hora', outputOf(proc))))
    }
    timer = setTimeout(() => done(() => reject(new StepError(step, 'tempo esgotado à espera de ' + proc.name, outputOf(proc)))), timeoutMs)
    proc.waiters.add(check)
    check()
  })
}

async function stop (proc, step) {
  if (!proc.exit) {
    proc.child.kill('SIGTERM')
    const result = await Promise.race([proc.exited, sleep(EXIT_TIMEOUT_MS).then(() => null)])
    if (result === null) {
      proc.child.kill('SIGKILL')
      await proc.exited
      throw new StepError(step, proc.name + ' não terminou com SIGTERM', outputOf(proc))
    }
  }
  return proc.exit
}

async function killStragglers () {
  const alive = [...children]
  if (alive.length === 0) return
  for (const p of alive) {
    try { p.child.kill('SIGTERM') } catch {}
  }
  await Promise.race([Promise.all(alive.map((p) => p.exited)), sleep(STRAGGLER_MS)])
  for (const p of alive) {
    if (!p.exit) {
      try { p.child.kill('SIGKILL') } catch {}
    }
  }
}

async function startSeeder (step, args) {
  const proc = spawnLong('semeador', ['seed', ...args])
  await waitLine(proc, (l) => l === 'seed ready', READY_TIMEOUT_MS, step)
  return proc
}

async function main () {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  say('Demo da fase 0 em ' + dir)
  say('Rede: DHT local em 127.0.0.1 (3 nós em processo); a DHT pública nunca é usada')
  net = await require('hyperdht/testnet')(3)
  const bootstrap = net.bootstrap.map((b) => '127.0.0.1:' + b.port).join(',')
  env = { ...process.env, VARANDA_BOOTSTRAP: bootstrap, VARANDA_DHT_HOST: '127.0.0.1' }
  delete env.VARANDA_DATA
  delete env.VARANDA_ASSOCIATION
  say('VARANDA_BOOTSTRAP=' + bootstrap)

  const assocDir = path.join(dir, 'assoc')
  const outraDir = path.join(dir, 'outra')
  const aDir = path.join(dir, 'a')
  const bDir = path.join(dir, 'b')
  const cDir = path.join(dir, 'c')
  const seedDir = path.join(dir, 'seeder')
  const seed2Dir = path.join(dir, 'seeder-sem-certificado')
  const certs = path.join(dir, 'certs')
  fs.mkdirSync(certs, { recursive: true })

  // 1. Associations.
  let step = '1 associação'
  say('\n[1] Associação de teste e uma segunda associação')
  const PUB = (await ok(step, ['assoc', 'init', '--data', assocDir])).json.publicKey
  const OUTRA = (await ok(step, ['assoc', 'init', '--data', outraDir])).json.publicKey
  check(step, /^[0-9a-f]{64}$/.test(PUB) && /^[0-9a-f]{64}$/.test(OUTRA), 'chaves inválidas')
  say('associação: ' + PUB)
  say('outra associação: ' + OUTRA)

  // 2. Identities.
  step = '2 identidades'
  say('\n[2] Identidades de A (Ana) e B')
  const A = (await ok(step, ['id', 'create', '--data', aDir, '--association', PUB])).json.publicKey
  const B = (await ok(step, ['id', 'create', '--data', bDir, '--association', PUB])).json.publicKey
  say('A = ' + A)
  say('B = ' + B)

  // 3. Member certificates.
  step = '3 certificados'
  say('\n[3] A associação certifica A e B; cada um grava o certificado no bloco 0')
  for (const [name, key, dataDir] of [['A', A, aDir], ['B', B, bDir]]) {
    const out = path.join(certs, name.toLowerCase() + '.json')
    await ok(step, ['assoc', 'certify', '--data', assocDir, '--member', key, '--out', out])
    const added = await ok(step, ['cert', 'add', '--data', dataDir, '--cert-file', out])
    check(step, added.json.seq === 0, 'bloco 0 esperado', outputOf(added))
    say('certificado de ' + name + ' gravado (bloco 0)')
  }

  // 3b. Seeder key and certificate.
  step = '3 semeador: chave e certificado'
  say('\n[3b] Semeador: chave Noise, certificado da associação, gravação')
  const SEEDER = (await ok(step, ['seed', 'key', '--data', seedDir, '--association', PUB])).json.publicKey
  check(step, /^[0-9a-f]{64}$/.test(SEEDER), 'chave do semeador inválida')
  const seederCert = path.join(certs, 'seeder.json')
  await ok(step, ['assoc', 'certify-seeder', '--data', assocDir, '--seeder', SEEDER, '--out', seederCert])
  const added = await ok(step, ['seed', 'cert', 'add', '--data', seedDir, '--cert-file', seederCert])
  check(step, added.json.seeder === SEEDER, 'certificado para outra chave', outputOf(added))
  say('semeador ' + short(SEEDER) + ' certificado pela associação')

  // 4. Profile and follow.
  step = '4 perfil e follow'
  say('\n[4] Ana define o perfil; B segue A (B ainda não está na rede)')
  await ok(step, ['profile', 'set', '--data', aDir, '--name', 'Ana'])
  const follow = await ok(step, ['follow', '--data', bDir, '--author', A])
  check(step, follow.json.follows.includes(A), 'B não segue A', outputOf(follow))
  say('B segue ' + short(A))

  // 5. Seeder.
  step = '5 semeador'
  say('\n[5] Semeador ligado')
  let seeder = await startSeeder(step, ['--data', seedDir, '--association', PUB])
  say('seed ready')

  // 6. A publishes, syncs once and goes offline.
  step = '6 A publica e sincroniza'
  say('\n[6] Ana publica e sincroniza uma vez com o semeador')
  const text = 'Olá! Primeira publicação da Ana.'
  const posted = await ok(step, ['post', '--data', aDir, '--text', text])
  const seq = posted.json.seq
  check(step, Number.isInteger(seq) && seq >= 1, 'seq inválido', outputOf(posted))
  say('publicado ' + A + ':' + seq)
  const syncA = await ok(step, ['sync', '--data', aDir, '--once', '--timeout-ms', String(SYNC_TIMEOUT_MS)])
  check(step, syncA.json.ok === true && syncA.json.admitted === true, 'A não foi admitida: ' + JSON.stringify(syncA.json), outputOf(syncA))
  await waitLine(seeder, (l) => l.startsWith('have ' + A + ' ') && Number(l.split(' ')[2]) >= seq + 1, READY_TIMEOUT_MS, step)
  say('A publicou e ficou offline')

  // 7. Seeder restart from disk.
  step = '7 reinício do semeador'
  say('\n[7] Semeador reiniciado (SIGTERM e novo processo no mesmo diretório)')
  const exit1 = await stop(seeder, step)
  check(step, exit1.code === 0, 'semeador saiu com ' + JSON.stringify(exit1), outputOf(seeder))
  seeder = await startSeeder(step, ['--data', seedDir])
  say('semeador reiniciado a partir do disco')

  // 8. B receives A's post through the seeder.
  step = '8 B recebe a publicação'
  say('\n[8] B sincroniza: a publicação de Ana chega pelo semeador, com Ana offline')
  const running = [...children].map((p) => p.name)
  check(step, running.length === 1 && running[0] === 'semeador', 'processos de rede ativos: ' + running.join(', '))
  const syncB = await ok(step, ['sync', '--data', bDir, '--once', '--timeout-ms', String(SYNC_TIMEOUT_MS)])
  const gotA = syncB.json.downloaded && syncB.json.downloaded[A]
  check(step, syncB.json.ok === true && gotA >= seq + 1, 'B não baixou A: ' + JSON.stringify(syncB.json), outputOf(syncB))
  check(step, syncB.json.peers === 1 && syncB.json.seeders === 1, 'B viu outros pares além do semeador: ' + JSON.stringify(syncB.json), outputOf(syncB))
  say('B baixou ' + gotA + ' blocos de A (pares: só o semeador)')
  const feedB = await ok(step, ['feed', '--data', bDir])
  const item = feedB.json.items.find((i) => i.author === A && i.text === text)
  check(step, item, 'publicação de A ausente do feed de B', outputOf(feedB))
  say('feed de B: [' + item.at + '] ' + item.name + ' (' + short(item.author) + ') #' + item.seq + ': ' + item.text)

  // 9. Reply.
  step = '9 resposta'
  say('\n[9] B responde; Ana volta, segue B e lê a resposta')
  const replied = await ok(step, ['reply', '--data', bDir, '--to', A + ':' + seq, '--text', 'Oi, Ana!'])
  const rseq = replied.json.seq
  const syncB2 = await ok(step, ['sync', '--data', bDir, '--once', '--timeout-ms', String(SYNC_TIMEOUT_MS)])
  check(step, syncB2.json.ok === true && syncB2.json.admitted === true, 'B não foi admitido: ' + JSON.stringify(syncB2.json), outputOf(syncB2))
  await ok(step, ['follow', '--data', aDir, '--author', B])
  const syncA2 = await ok(step, ['sync', '--data', aDir, '--once', '--timeout-ms', String(SYNC_TIMEOUT_MS)])
  check(step, syncA2.json.ok === true && syncA2.json.downloaded[B] >= rseq + 1, 'A não baixou B: ' + JSON.stringify(syncA2.json), outputOf(syncA2))
  const feedA = await ok(step, ['feed', '--data', aDir])
  const reply = feedA.json.items.find((i) => i.author === B && i.seq === rseq)
  check(step, reply && reply.text === 'Oi, Ana!' && reply.replyTo && reply.replyTo.author === A && reply.replyTo.seq === seq, 'resposta ausente do feed de A', outputOf(feedA))
  say('feed de A: ' + short(reply.author) + ' #' + reply.seq + ' ↳ ' + short(reply.replyTo.author) + '#' + reply.replyTo.seq + ': ' + reply.text)

  // 10. Gate: another association's certificate, and a seeder without one.
  step = '10 certificado de outra associação'
  say('\n[10] C traz um certificado de outra associação')
  const C = (await ok(step, ['id', 'create', '--data', cDir, '--association', PUB])).json.publicKey
  const certC = path.join(certs, 'c.json')
  await ok(step, ['assoc', 'certify', '--data', outraDir, '--member', C, '--out', certC])
  await refused(step, ['cert', 'add', '--data', cDir, '--cert-file', certC], 1, 'untrusted-association')
  say('certificado de outra associação recusado')
  const syncC = await ok(step, ['sync', '--data', cDir, '--once', '--timeout-ms', String(SYNC_TIMEOUT_MS)])
  check(step, syncC.json.admitted === false, 'C foi admitido: ' + JSON.stringify(syncC.json), outputOf(syncC))
  check(step, !seeder.lines.some((l) => l.startsWith('admitted ' + C + ' ')), 'o semeador admitiu C', outputOf(seeder))
  say('C sincronizou sem certificado: não admitido (semeador nunca imprimiu "admitted ' + short(C) + '…")')

  step = '10 semeador sem certificado'
  say('\n[10b] Um semeador sem certificado da associação não liga')
  await ok(step, ['seed', 'key', '--data', seed2Dir, '--association', PUB])
  await refused(step, ['seed', '--data', seed2Dir], 1, 'certificado do semeador')
  say('semeador sem certificado recusado')

  // 11. Shutdown.
  step = '11 encerramento'
  say('\n[11] Encerramento')
  const exit2 = await stop(seeder, step)
  check(step, exit2.code === 0, 'semeador saiu com ' + JSON.stringify(exit2), outputOf(seeder))
  const n = net
  net = null
  await n.destroy()
  say('\nDEMO OK')
}

async function cleanup () {
  await killStragglers()
  if (net) {
    try { await net.destroy() } catch {}
    net = null
  }
  if (keep) say('dados mantidos em ' + dir)
  else fs.rmSync(dir, { recursive: true, force: true })
}

const watchdog = setTimeout(() => {
  process.stdout.write('DEMO FALHOU: tempo esgotado (' + WATCHDOG_MS / 1000 + ' s)\n')
  process.exitCode = 1
  cleanup().finally(() => process.exit(1))
}, WATCHDOG_MS)

main().then(() => {
  process.exitCode = 0
}, (err) => {
  const step = err instanceof StepError ? err.step : 'erro inesperado'
  process.stdout.write('DEMO FALHOU: ' + step + '\n')
  process.stdout.write((err instanceof StepError ? err.message : (err && err.stack) || String(err)) + '\n')
  if (err instanceof StepError && err.output) process.stdout.write(err.output)
  process.exitCode = 1
}).then(cleanup).finally(() => {
  clearTimeout(watchdog)
  // A referenced DHT timer can never keep the process alive.
  setTimeout(() => process.exit(process.exitCode), 2000).unref()
})
