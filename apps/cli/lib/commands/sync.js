const { runSync } = require('@varanda/core/lib/sync')
const { safe, jsonLine } = require('@varanda/core/lib/safe')

const LF = '\n'

function key8 (hex) {
  return safe(String(hex).slice(0, 8))
}

// Human stdout line for a sync event (docs §7); null = nothing on stdout.
function formatEvent (ev) {
  switch (ev.event) {
    case 'ready':
      return 'sync ready'
    case 'peer': {
      const unverified = ev.role === 'seeder' && !ev.verified ? ' não verificado' : ''
      return 'peer ' + safe(ev.role) + ' ' + key8(ev.peerKey) + unverified
    }
    case 'admitted':
      return 'admitted ' + safe(ev.key) + ' ' + safe(ev.length)
    case 'rejected':
      return 'rejected ' + safe(ev.key) + ' ' + safe(ev.reason)
    case 'withdrawn':
      return 'withdrawn ' + safe(ev.key) + ' ' + key8(ev.peerKey) + ' ' + safe(ev.reason)
    case 'have':
      return 'have ' + safe(ev.key) + ' ' + safe(ev.length)
    case 'downloaded':
      return 'downloaded ' + safe(ev.key) + ' ' + safe(ev.length)
    default:
      return null
  }
}

const commands = {
  sync: {
    summary: 'sincroniza com pares e com o semeador',
    async run (flags) {
      const onEvent = (ev) => {
        if (flags.json) {
          process.stdout.write(jsonLine(ev) + LF)
          return
        }
        if (ev.event === 'skipped') {
          process.stderr.write('aviso: diário ' + key8(ev.key) + ' ignorado (' + safe(ev.reason) + ')' + LF)
          return
        }
        const line = formatEvent(ev)
        if (line !== null) process.stdout.write(line + LF)
      }
      const result = await runSync({
        dataDir: flags.dataDir,
        associationKey: flags.association,
        bootstrap: flags.bootstrap,
        host: flags.dhtHost,
        once: flags.once,
        timeoutMs: flags.timeoutMs || 30000,
        log: (line) => process.stderr.write(safe(line) + LF),
        onEvent
      })
      if (flags.json) process.stdout.write(jsonLine(result) + LF)
      else if (result.ok) process.stdout.write((result.seederConfirmed === false ? 'sync done (sem confirmação de semeador)' : 'sync done') + LF)
      else process.stdout.write('sync failed: ' + safe(result.errors.join('; ')) + LF)
      return result.ok ? 0 : 1
    }
  }
}

module.exports = { commands, formatEvent, safe }
