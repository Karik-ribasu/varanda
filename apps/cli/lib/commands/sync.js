const { runSync } = require('@varanda/core/lib/sync')
const { safe, jsonLine } = require('@varanda/core/lib/safe')
const { key8, formatEvent } = require('@varanda/core/lib/sync-format')

const LF = '\n'

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
