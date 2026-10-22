'use strict'
// bare-process 4.5.1 already has every member the core uses: pid, kill, on,
// once, removeListener (bare-events EventEmitter) and an 'exit' event
// forwarded from Bare (observed firing on a normal exit under bare-runtime
// 1.34.1), so no shim is needed.
module.exports = require('bare-process')
