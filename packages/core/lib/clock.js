'use strict'

// Monotonic milliseconds for rate limits: performance.now() where the runtime
// has it (Node), else the process hrtime (Bare defines no `performance`
// global). A wall-clock step must never drain or stall a token bucket.
const process = require('#process')

const hasPerformance = typeof performance === 'object' && performance !== null && typeof performance.now === 'function'

function now () {
  return hasPerformance ? performance.now() : Number(process.hrtime.bigint()) / 1e6
}

module.exports = { now }
