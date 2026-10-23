const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '../../..')
const readme = path.join(repoRoot, 'README.md')
const bin = path.join(repoRoot, 'bin/varanda.js')

// Returns the first fenced block after the "### Ajuda" heading, or null.
function extractHelpBlock (text) {
  const lines = text.split('\n')
  const heading = lines.indexOf('### Ajuda')
  if (heading === -1) return null
  const open = lines.indexOf('```', heading + 1)
  if (open === -1) return null
  const close = lines.indexOf('```', open + 1)
  if (close === -1) return null
  return lines.slice(open + 1, close).join('\n')
}

test('README "Ajuda" block matches `varanda help` output', (t) => {
  const block = extractHelpBlock(fs.readFileSync(readme, 'utf8'))
  if (block === null) {
    t.fail('README.md has no "### Ajuda" heading followed by a closed ``` block')
    return
  }
  const res = spawnSync(process.execPath, [bin, 'help'], { encoding: 'utf8' })
  t.is(res.status, 0, 'help exits with status 0')
  t.is(block + '\n', res.stdout, 'README help block equals the real help output')
})
