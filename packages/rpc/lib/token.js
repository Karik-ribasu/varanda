'use strict'

// Constant-time string comparison: the loop always runs over the longer
// length and never exits early, neither on the first difference nor on a
// length mismatch (which still makes the result false). A charCodeAt past
// the end is NaN, and NaN | 0 is 0, so there is no branch on the index.
function tokensEqual (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0)
  }
  return diff === 0
}

module.exports = { tokensEqual }
