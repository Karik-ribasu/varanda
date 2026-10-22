// The node configuration the person chooses on the native "Conectar" screen.
// It holds NO secret (an association public key, bootstrap addresses, the DHT
// choice). The rules mirror packages/core/lib/session.js checkConfig and
// packages/core/lib/config.js validBootstrap, so a bad value is caught before
// the node starts; the node still has the last word.

const HEX64 = /^[0-9a-fA-F]{64}$/

// Hostname or IPv4, exactly one colon, port 1..65535 with no leading zeros.
export function validBootstrap (entry) {
  const match = /^([A-Za-z0-9.-]+):([0-9]+)$/.exec(entry)
  if (!match) return false
  const port = Number(match[2])
  return String(port) === match[2] && Number.isSafeInteger(port) && port >= 1 && port <= 65535
}

export function parseBootstrapText (text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
}

// form: { association, bootstrapText, publicDht, dhtHost }
// -> { config } with { association, bootstrap (array or null), dhtHost (string
// or null), allowPublicDht }, or { error } (pt-BR).
export function checkForm (form) {
  const association = String(form.association || '').trim()
  if (!HEX64.test(association)) return { error: 'chave da associação inválida (64 dígitos hexadecimais)' }
  const list = parseBootstrapText(form.bootstrapText || '')
  for (const entry of list) {
    if (!validBootstrap(entry)) return { error: 'bootstrap inválido: use host:porta, um por linha' }
  }
  const publicDht = form.publicDht === true
  if (publicDht && list.length > 0) return { error: 'bootstrap e DHT pública são exclusivos' }
  if (!publicDht && list.length === 0) return { error: 'informe ao menos um bootstrap ou ligue a DHT pública' }
  const host = String(form.dhtHost || '').trim()
  if (/\s/.test(host)) return { error: 'endereço da DHT inválido' }
  return {
    config: {
      association: association.toLowerCase(),
      bootstrap: publicDht ? null : list,
      dhtHost: host === '' ? null : host,
      allowPublicDht: publicDht
    }
  }
}

export function formOf (config) {
  if (config === null || config === undefined) {
    return { association: '', bootstrapText: '', publicDht: false, dhtHost: '' }
  }
  return {
    association: config.association,
    bootstrapText: Array.isArray(config.bootstrap) ? config.bootstrap.join('\n') : '',
    publicDht: config.allowPublicDht === true,
    dhtHost: config.dhtHost || ''
  }
}

// A stored value is only trusted after the same check (a hand-edited file).
export function revive (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const checked = checkForm({
    association: value.association,
    bootstrapText: Array.isArray(value.bootstrap) ? value.bootstrap.filter((e) => typeof e === 'string').join('\n') : '',
    publicDht: value.allowPublicDht === true,
    dhtHost: typeof value.dhtHost === 'string' ? value.dhtHost : ''
  })
  return checked.config || null
}
