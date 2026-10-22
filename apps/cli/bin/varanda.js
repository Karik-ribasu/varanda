#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { parseArgs, HELP } = require('../lib/cli')

function loadCommands () {
  const directory = path.join(__dirname, '../lib/commands')
  let files
  try {
    files = fs.readdirSync(directory)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return new Map()
  }
  const commands = new Map()
  for (const file of files.sort()) {
    if (!file.endsWith('.js')) continue
    const module = require(path.join(directory, file))
    for (const [name, command] of Object.entries(module.commands)) {
      if (commands.has(name)) throw new Error('comando duplicado: ' + name)
      commands.set(name, command)
    }
  }
  return commands
}

async function main () {
  const commands = loadCommands()
  let flags
  try {
    flags = parseArgs(process.argv.slice(2))
  } catch (err) {
    if (err.code !== 'USAGE') throw err
    process.stderr.write('uso: ' + err.message + '\n' + HELP + '\n')
    process.exitCode = 2
    return
  }
  if (flags.help || flags.command === null || flags.command === 'help') {
    process.stdout.write(HELP + '\n')
    process.exitCode = 0
    return
  }
  const command = commands.get(flags.command)
  if (!command) {
    process.stderr.write('erro: comando desconhecido: ' + flags.command + '\n')
    process.exitCode = 2
    return
  }

  // Command modules never call process.exit; the router lets cleanup drain.
  try {
    const code = await command.run(flags)
    process.exitCode = typeof code === 'number' ? code : 0
  } catch (err) {
    reportError(err)
  } finally {
    // Bound shutdown if a socket or timer survives the command's close().
    setTimeout(() => process.exit(process.exitCode), 2000).unref()
  }
}

function reportError (err) {
  const usage = err.code === 'USAGE'
  process.stderr.write((usage ? 'uso: ' : 'erro: ') + err.message + '\n')
  process.exitCode = usage ? 2 : 1
}

main().catch(reportError)
