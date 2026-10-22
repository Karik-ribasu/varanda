'use strict'

// Error codes of the contract (docs/rpc.md section 7).
const USAGE = 'USAGE'
const UNAUTHORIZED = 'UNAUTHORIZED'
const LOCKED = 'LOCKED'
const NOT_FOUND = 'NOT_FOUND'
const INTERNAL = 'INTERNAL'
// Client-side only: never sent on the wire.
const TIMEOUT = 'TIMEOUT'
const CLOSED = 'CLOSED'

const WIRE_CODES = Object.freeze([USAGE, UNAUTHORIZED, LOCKED, NOT_FOUND, INTERNAL])
const CLIENT_CODES = Object.freeze([TIMEOUT, CLOSED])
const ERROR_CODES = Object.freeze({ USAGE, UNAUTHORIZED, LOCKED, NOT_FOUND, INTERNAL, TIMEOUT, CLOSED })

// Generic pt-BR message per code: used for INTERNAL always, and for any other
// code whose message fails the safety check below.
const GENERIC_MESSAGES = Object.freeze({
  USAGE: 'pedido inválido',
  UNAUTHORIZED: 'não autorizado',
  LOCKED: 'diretório de dados em uso',
  NOT_FOUND: 'não encontrado',
  INTERNAL: 'erro interno',
  TIMEOUT: 'tempo esgotado',
  CLOSED: 'conexão encerrada'
})

const MAX_ERROR_MESSAGE = 200

// A wire message must be short and must not look like it carries a path or
// key material (A6): no slash or backslash, no run of 16+ hex digits.
function isSafeMessage (message) {
  return typeof message === 'string' &&
    message.length >= 1 &&
    message.length <= MAX_ERROR_MESSAGE &&
    !/[/\\]/.test(message) &&
    !/[0-9a-fA-F]{16,}/.test(message)
}

class RpcError extends Error {
  constructor (code, message, { uncertain = false } = {}) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.uncertain = uncertain
  }
}

// Maps anything a handler threw to the wire error object. Never throws.
function toWireError (err) {
  let code = INTERNAL
  let message = null
  try {
    if (err !== null && typeof err === 'object') {
      if (typeof err.code === 'string' && WIRE_CODES.includes(err.code)) code = err.code
      message = err.message
    }
  } catch {
    code = INTERNAL
  }
  if (code === INTERNAL || !isSafeMessage(message)) message = GENERIC_MESSAGES[code]
  return { code, message }
}

module.exports = {
  ...ERROR_CODES,
  ERROR_CODES,
  WIRE_CODES,
  CLIENT_CODES,
  GENERIC_MESSAGES,
  MAX_ERROR_MESSAGE,
  RpcError,
  isSafeMessage,
  toWireError
}
