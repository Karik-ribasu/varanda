#!/usr/bin/env node
// Local DHT bootstrap node for manual tests on one machine without internet:
//   node scripts/local-dht.js [--port 49737]
// Prints the VARANDA_BOOTSTRAP export line and runs until SIGINT/SIGTERM.
// HyperDHT.bootstrapper requires an IPv4 host and rejects 0.0.0.0, so the
// node binds 127.0.0.1 only; point every varanda process at it with
// VARANDA_BOOTSTRAP and VARANDA_DHT_HOST=127.0.0.1.
const HyperDHT = require('hyperdht')

const DEFAULT_PORT = 49737
const HOST = '127.0.0.1'

function portArg (argv) {
  const i = argv.indexOf('--port')
  if (i === -1) return DEFAULT_PORT
  const value = argv[i + 1]
  if (value === undefined || !/^[0-9]+$/.test(value)) throw new Error('uso: node scripts/local-dht.js [--port <porta>]')
  const port = Number(value)
  if (port < 1 || port > 65535) throw new Error('porta inválida: ' + value)
  return port
}

async function main () {
  const port = portArg(process.argv.slice(2))
  const node = HyperDHT.bootstrapper(port, HOST)
  await node.ready()
  const bound = node.address().port
  process.stdout.write('export VARANDA_BOOTSTRAP=' + HOST + ':' + bound + '\n')
  process.stderr.write('DHT local em ' + HOST + ':' + bound + ' (Ctrl-C para encerrar)\n')
  await new Promise((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  await node.destroy()
  process.exitCode = 0
}

main().catch((err) => {
  process.stderr.write('erro: ' + err.message + '\n')
  process.exitCode = 1
}).finally(() => {
  setTimeout(() => process.exit(process.exitCode), 2000).unref()
})
