'use strict'

// Defence in depth (security audit S4, H4): every string printed that did not
// originate in this process (names, texts, reasons, keys from peers or from a
// followed log) has its C0/C1 controls, DEL, U+2028/U+2029 and the bidi
// controls escaped, so a peer can never forge or hide a terminal line.

function isUnsafe (cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true
  if (cp === 0x2028 || cp === 0x2029) return true
  if (cp >= 0x202a && cp <= 0x202e) return true
  return cp >= 0x2066 && cp <= 0x2069
}

// Human-text escaper: unsafe code points become \u{xx}.
function safe (value) {
  let out = ''
  for (const ch of String(value)) {
    const cp = ch.codePointAt(0)
    out += isUnsafe(cp) ? '\\u{' + cp.toString(16) + '}' : ch
  }
  return out
}

// JSON.stringify already escapes C0, quote and backslash; the remaining
// unsafe code points are escaped as \uXXXX (still valid JSON, same value).
// Raw such code points can only occur inside strings, so a global replace is exact.
const EXTRA = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

function jsonLine (value) {
  return JSON.stringify(value).replace(EXTRA, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
}

// Terminal columns of a code point, deliberately over-estimated: every code
// point >= U+1100 counts 2 columns, except an explicit narrow allowlist of
// ranges common in Portuguese text. Over-estimating is safe, under-estimating
// lets a line soft-wrap. Residual: East Asian "ambiguous" characters below
// U+1100 (and inside the allowlist) count 1, which under-measures only on
// terminals configured to draw ambiguous characters wide.
const NARROW = [
  [0x2000, 0x206f], // general punctuation: em dash, ellipsis, curly quotes
  [0x20a0, 0x20cf] // currency symbols: euro sign
]

function cpWidth (cp) {
  if (cp < 0x1100) return 1
  for (const [lo, hi] of NARROW) if (cp >= lo && cp <= hi) return 1
  return 2
}

function displayWidth (str) {
  let n = 0
  for (const ch of String(str)) n += cpWidth(ch.codePointAt(0))
  return n
}

module.exports = { safe, jsonLine, isUnsafe, cpWidth, displayWidth }
