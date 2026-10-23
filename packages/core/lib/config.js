'use strict'

// Node configuration checks shared by the CLI (apps/cli/lib/cli.js) and the
// node session (lib/session.js): one implementation of the bootstrap rule.

// Hostname or IPv4, exactly one colon, port 1..65535 with no leading zeros.
function validBootstrap (entry) {
  const match = /^([A-Za-z0-9.-]+):([0-9]+)$/.exec(entry)
  if (!match) return false
  const portText = match[2]
  const port = Number(portText)
  return String(port) === portText && Number.isSafeInteger(port) && port >= 1 && port <= 65535
}

// A loopback address: 'localhost' (any case), a dotted IPv4 address in
// 127.0.0.0/8, or the IPv6 loopback ::1 (with or without brackets).
function isLoopbackAddress (host) {
  const text = String(host).toLowerCase()
  if (text === 'localhost' || text === '::1' || text === '[::1]') return true
  const m = /^127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(text)
  return m !== null && m.slice(1).every((octet) => Number(octet) <= 255)
}

// The host of a valid bootstrap entry is a loopback address.
function isLoopbackBootstrap (entry) {
  const text = String(entry)
  return isLoopbackAddress(text.slice(0, text.lastIndexOf(':')))
}

module.exports = { validBootstrap, isLoopbackAddress, isLoopbackBootstrap }
