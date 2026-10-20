'use strict'

const { Seeder } = require('../seeder')
const { UsageError } = require('../cli')
const { safe, jsonLine } = require('../safe')

function print (flags, result, line) {
  process.stdout.write((flags.json ? jsonLine(result) : line) + '\n')
}

function short (hex) {
  return safe(String(hex).slice(0, 8))
}

function eventLine (event) {
  switch (event.event) {
    case 'ready': return 'seed ready'
    case 'peer': return 'peer ' + safe(event.role) + ' ' + short(event.peerKey)
    case 'admitted': return 'admitted ' + safe(event.key) + ' ' + safe(event.length)
    case 'rejected': return 'rejected ' + safe(event.key) + ' ' + safe(event.reason)
    case 'have': return 'have ' + safe(event.key) + ' ' + safe(event.length)
    case 'fatal': return 'fatal ' + safe(event.key) + ' ' + safe(event.reason)
    default: return safe(event.event)
  }
}

async function runSeeder (flags) {
  const log = (event) => {
    process.stdout.write((flags.json ? jsonLine(event) : eventLine(event)) + '\n')
  }
  const seeder = new Seeder({
    dataDir: flags.dataDir,
    associationKey: flags.association,
    bootstrap: flags.bootstrap,
    host: flags.dhtHost || undefined,
    log
  })
  // Handlers go in BEFORE start(): a signal during startup (DHT join) must not
  // take Node's default terminate path; the seeder is closed once start settles.
  let onSignal
  const stopped = new Promise((resolve) => {
    onSignal = () => resolve()
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  })
  try {
    await seeder.start()
  } catch (err) {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    throw err
  }
  try {
    // A fatal purge failure closes the seeder by itself.
    await Promise.race([stopped, seeder.closed])
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await seeder.close()
  }
  return seeder.fatal ? 1 : 0
}

async function run (flags) {
  const [sub, subsub] = flags.positionals
  if (sub === undefined) return runSeeder(flags)

  if (sub === 'key' && subsub === undefined) {
    Seeder.ensureConfig(flags.dataDir, flags.association)
    const { publicKey } = Seeder.createKey(flags.dataDir)
    print(flags, { publicKey }, 'chave do semeador: ' + publicKey)
    return 0
  }

  if (sub === 'cert' && subsub === 'add' && flags.positionals.length === 2) {
    if (!flags.certFile) throw new UsageError('informe --cert-file <arquivo>')
    const association = Seeder.ensureConfig(flags.dataDir, flags.association)
    const result = Seeder.addCert(flags.dataDir, flags.certFile, association)
    print(flags, result, 'certificado do semeador gravado')
    return 0
  }

  throw new UsageError('node bin/somos.js seed [key|cert add]')
}

module.exports = {
  commands: {
    seed: { summary: 'semeador sempre ligado', run }
  }
}
