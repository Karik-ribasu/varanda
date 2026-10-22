'use strict'

// Scans a packed worklet bundle (bare-pack, format bundle.cjs or raw
// .bundle) and fails when it could reach a Node built-in at runtime:
//   - any specifier starting with `node:` (in the resolution map or in a
//     require()/import of a bundled source);
//   - a bare Node built-in name (fs, path, crypto, ...) that a bundled source
//     requires but the bundle does not resolve to a bundled file (Bare has no
//     such built-ins: it would throw MODULE_NOT_FOUND inside the worklet).
// Usage: node scripts/check-bundle.js <bundle> -> prints a summary, exit 0/1.

const fs = require('fs')
const path = require('path')
const { builtinModules } = require('module')

const NODE_BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')))
const REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)|\bimport\s*(?:[^'"\n;]*\bfrom\s*)?(['"])([^'"\n]+)\3/g

function readBundle (file) {
  if (file.endsWith('.js') || file.endsWith('.cjs')) {
    const text = require(path.resolve(file))
    if (typeof text !== 'string') throw new Error('bundle module does not export a string')
    return Buffer.from(text, 'utf8')
  }
  return fs.readFileSync(file)
}

// bare-bundle layout: "<len>\n" then <len> bytes of header JSON (starting
// at the newline), then the file data.
function parse (buf) {
  const nl = buf.indexOf(0x0a)
  if (nl <= 0) throw new Error('not a bare bundle')
  const len = parseInt(buf.toString('utf8', 0, nl), 10)
  if (!Number.isSafeInteger(len) || len <= 0) throw new Error('not a bare bundle')
  const header = JSON.parse(buf.toString('utf8', nl, nl + len))
  return { header, data: buf.subarray(nl + len) }
}

function main () {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: check-bundle.js <bundle>')
    process.exit(2)
  }
  const buf = readBundle(file)
  const { header, data } = parse(buf)
  const problems = []
  const resolutions = header.resolutions || {}

  for (const [from, map] of Object.entries(resolutions)) {
    for (const [spec, target] of Object.entries(map)) {
      if (spec.startsWith('node:')) problems.push(from + ': specifier ' + spec)
      const t = JSON.stringify(target)
      if (t.includes('"node:') || t.includes('builtin:')) problems.push(from + ': ' + spec + ' -> ' + t)
    }
  }

  for (const [name, entry] of Object.entries(header.files || {})) {
    if (!/\.(c|m)?js$/.test(name)) continue
    const source = data.toString('utf8', entry.offset, entry.offset + entry.length)
    const map = resolutions[name] || {}
    for (const m of source.matchAll(REQUIRE_RE)) {
      const spec = m[2] || m[4]
      if (spec.startsWith('node:')) {
        problems.push(name + ': requires ' + spec)
        continue
      }
      const base = spec.split('/')[0]
      if (!NODE_BUILTINS.has(spec) && !NODE_BUILTINS.has(base)) continue
      const target = map[spec]
      const resolved = typeof target === 'string'
        ? target
        : (target && typeof target === 'object' ? Object.values(target).find((v) => typeof v === 'string') : undefined)
      if (typeof resolved !== 'string' || !(resolved in header.files)) {
        problems.push(name + ': requires Node built-in ' + spec + ' (unresolved)')
      }
    }
  }

  const addons = Array.isArray(header.addons) ? header.addons : []
  console.log('bundle ' + file + ': ' + buf.byteLength + ' bytes, ' + Object.keys(header.files || {}).length +
    ' files, ' + addons.length + ' linked addon entries, main ' + header.main)
  if (problems.length > 0) {
    for (const p of problems.slice(0, 50)) console.error('node scan: ' + p)
    console.error('node scan: FAIL (' + problems.length + ' problem(s))')
    process.exit(1)
  }
  console.log('node scan: clean (no node: specifier, no unresolved Node built-in)')
}

main()
