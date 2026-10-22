'use strict'

// Dependency-free static server for local preview of apps/site/public.
// Usage: node scripts/serve.js [--port 4173] [--prefix /varanda]

const http = require('http')
const fs = require('fs')
const path = require('path')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json'
}

function parseArgs (argv) {
  const out = { port: 4173, prefix: '' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('invalid --port')
      out.port = n
    } else if (argv[i] === '--prefix') {
      const p = String(argv[++i] || '').replace(/\/+$/, '')
      if (p && !/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(p)) throw new Error('invalid --prefix')
      out.prefix = p
    } else {
      throw new Error('unknown argument: ' + argv[i])
    }
  }
  return out
}

const root = path.resolve(__dirname, '..', 'public')

function send (res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store' }, headers))
  res.end(body)
}

function notFound (res, head) {
  send(res, 404, head ? undefined : 'not found\n', { 'Content-Type': 'text/plain; charset=utf-8' })
}

function resolveTarget (pathname, prefix) {
  let rel = pathname
  if (prefix) {
    if (rel !== prefix && !rel.startsWith(prefix + '/')) return null
    rel = rel.slice(prefix.length) || '/'
  }
  if (rel.includes('\0') || rel.includes('\\')) return null
  if (rel.split('/').includes('..')) return null
  return path.join(root, rel)
}

function handler (prefix) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed\n', {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8'
      })
    }
    const head = req.method === 'HEAD'
    let pathname
    try {
      // the raw (still encoded) path, decoded exactly once
      const raw = new URL(req.url, 'http://localhost').pathname
      pathname = decodeURIComponent(raw)
    } catch (e) {
      return notFound(res, head)
    }
    const target = resolveTarget(pathname, prefix)
    if (!target) return notFound(res, head)

    let real, rootReal
    try {
      rootReal = fs.realpathSync(root)
      real = fs.realpathSync(target)
    } catch (e) {
      return notFound(res, head)
    }
    const inside = (p) => p === rootReal || p.startsWith(rootReal + path.sep)
    if (!inside(real)) return notFound(res, head)

    let file = real
    try {
      if (fs.statSync(file).isDirectory()) {
        // A directory URL needs its trailing slash, or relative assets resolve
        // one level up (e.g. /varanda -> /varanda/).
        if (!pathname.endsWith('/')) {
          return send(res, 301, undefined, { Location: new URL(req.url, 'http://localhost').pathname + '/' })
        }
        // The index is resolved again: it may itself be a symlink out of root.
        file = fs.realpathSync(path.join(file, 'index.html'))
        if (!inside(file)) return notFound(res, head)
      }
      if (!fs.statSync(file).isFile()) return notFound(res, head)
    } catch (e) {
      return notFound(res, head)
    }

    fs.readFile(file, (err, data) => {
      if (err) return notFound(res, head)
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
      send(res, 200, head ? undefined : data, {
        'Content-Type': type,
        'Content-Length': data.length
      })
    })
  }
}

function main () {
  const { port, prefix } = parseArgs(process.argv.slice(2))
  const server = http.createServer(handler(prefix))
  server.listen(port, '127.0.0.1', () => {
    console.log('varanda site em http://127.0.0.1:' + server.address().port + prefix + '/')
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main()
