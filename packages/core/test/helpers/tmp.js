'use strict'

// Temp directories for core tests: created under VARANDA_TEST_TMPDIR when the
// runner sets it (a per-file root it removes after the child exits), else
// under os.tmpdir(). Each directory is removed by a forced teardown, and a
// single process 'exit' handler removes whatever is left (brittle's timeout
// path runs no teardown), so a file run alone with node test/<file> is clean.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tmpDirs = new Set()
let exitHandlerArmed = false

function removeTmpDirsSync () {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
    tmpDirs.delete(dir)
  }
}

function tmpDir (t, prefix = 'varanda-core-') {
  const base = process.env.VARANDA_TEST_TMPDIR || os.tmpdir()
  const dir = fs.mkdtempSync(path.join(base, prefix))
  tmpDirs.add(dir)
  if (!exitHandlerArmed) {
    exitHandlerArmed = true
    process.once('exit', removeTmpDirsSync)
  }
  t.teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    tmpDirs.delete(dir)
  }, { order: 100, force: true })
  return dir
}

module.exports = { tmpDir }
