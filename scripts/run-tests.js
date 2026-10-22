// Runs brittle test files one per child process, sequentially.
// Each child is spawned detached so it leads its own process group; on
// timeout (VARANDA_TEST_TIMEOUT_MS, default 180000) or on the runner's own
// SIGINT/SIGTERM the whole group is killed with SIGKILL, so grandchildren
// spawned by a test never outlive it (process groups are POSIX only).
// Each file gets its own temp root (VARANDA_TEST_TMPDIR, under os.tmpdir(),
// prefix 'varanda-run-') that the runner removes after the child exits for
// any reason, so a SIGKILLed test (no 'exit' handler runs) leaves nothing.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

let files = process.argv.slice(2)
if (files.length === 0) {
  const dir = 'test'
  files = fs.existsSync(dir)
    ? fs.readdirSync(dir)
      .filter((name) => name.endsWith('.test.js'))
      .sort()
      .map((name) => path.join(dir, name))
    : []
}

if (files.length === 0) {
  console.log('# nenhum arquivo de teste')
  process.exit(1)
}

// Only a finite positive value is accepted: setTimeout throws on Infinity or
// negative delays, which would crash the runner after a detached spawn.
const requested = Number(process.env.VARANDA_TEST_TIMEOUT_MS)
const timeout = Number.isFinite(requested) && requested > 0 && requested <= 2147483647 ? requested : 180000
let current = null
let currentRoot = null

function killGroup (child) {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch {}
  }
}

function onSignal (signal, code) {
  process.once(signal, () => {
    if (current) killGroup(current)
    // The child's 'exit' handler never runs once we exit here, so remove the
    // current file's temp root synchronously first.
    if (currentRoot) {
      try { fs.rmSync(currentRoot, { recursive: true, force: true }) } catch {}
    }
    process.exit(code)
  })
}
onSignal('SIGINT', 130)
onSignal('SIGTERM', 143)

// Resolves true when the file passed.
function runFile (file) {
  return new Promise((resolve) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-run-'))
    const env = { ...process.env, VARANDA_TEST_TMPDIR: root }
    currentRoot = root
    const child = spawn(process.execPath, [file], { stdio: 'inherit', detached: true, env })
    current = child
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child)
      console.log('# tempo esgotado: ' + file)
    }, timeout)
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      current = null
      currentRoot = null
      try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
      resolve(ok)
    }
    child.on('error', () => finish(false))
    child.on('exit', (status, signal) => {
      if (timedOut) return finish(false)
      // The test exited; make sure nothing it spawned keeps running.
      killGroup(child)
      if (signal) {
        console.log('# encerrado pelo sinal ' + signal + ': ' + file)
        return finish(false)
      }
      finish(status === 0)
    })
  })
}

async function main () {
  let failures = 0
  for (const file of files) {
    console.log('# ' + file)
    if (!(await runFile(file))) failures++
  }
  console.log('# ' + files.length + ' arquivo(s) de teste, ' + failures + ' falha(s)')
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((err) => {
  if (current) killGroup(current)
  if (currentRoot) {
    try { fs.rmSync(currentRoot, { recursive: true, force: true }) } catch {}
  }
  console.log('# erro no executor de testes: ' + err.message)
  process.exit(1)
})
