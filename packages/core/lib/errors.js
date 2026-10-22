'use strict'

class UsageError extends Error {
  constructor (message) {
    super(message)
    this.code = 'USAGE'
  }
}

module.exports = { UsageError }
