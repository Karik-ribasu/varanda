# varanda — Phase 0 protocol and formats (normative)

R6 wins over R5 wins over R4 wins over R3.

This document is the single normative reference for the Phase 0 prototype. Names, values, paths, shapes, reason strings, messages, flags, constants and stdout lines are exact. Amendments R3, R4, R5 and R6 are folded into the sections they affect; where they conflict, R6 wins over R5, R5 wins over R4, R4 wins over R3 and R3 wins over the base text. Text that R5 or R6 replaced has been removed.

Conventions: CommonJS (`require`), standard style (no semicolons, single quotes, 2-space indent), Node >= 20 built-ins with the `node:` prefix, no TypeScript, no build step. Code, identifiers and comments are in English; user-facing CLI text, help and README are in Brazilian Portuguese. Tests use brittle and run alone with `node test/<file>.test.js`; every network test uses `hyperdht/testnet` through `test/helpers/net.js` (never the public DHT) and binds the DHT to `127.0.0.1` (R5.11). Register teardowns of swarms, stores and seeders with `{ force: true }`.

## 1. Identity and storage

- `hex64` = exactly 64 lowercase hex characters (a 32-byte key).
- Identity = the key of the member's diary Hypercore, shown as hex64. Diary = `store.get({ name: 'diary', valueEncoding: 'json' })` on a Corestore at `<dataDir>/store`. The JSON value encoding is used only for appending; blocks are always read raw and decoded with `decodeBlock` (section 2, R4.1).
- Corestore 7 derives the diary's Ed25519 signing key pair from the store's primary key (generated on the device) and the core key from a one-signer manifest. The core key is the diary's public identifier; it is not byte-equal to the signer's raw public key. Only this device can append.
- TODO(phase2): threshold-key (FROST) recovery of this key.
- A Corestore directory is RocksDB-backed: ONE process at a time (RocksDB takes an OS lock). Short CLI commands open the store, work and close it in a `finally` block; `sync` and `seed` hold it while they run, so local commands must not run concurrently on the same `--data` (they fail with a lock error).

### Data-dir lock (`diretório de dados em uso`)

`openStore(dataDir)` (`lib/store.js`) takes an exclusive data-dir lock BEFORE the Corestore (and its RocksDB) is constructed, so a second opener fails fast without touching `<dataDir>/store`: `Error('diretório de dados em uso')` with `err.code = 'LOCKED'` (CLI: exit 1, `erro: diretório de dados em uso`). It applies to every data dir opened through `openStore` (members and seeders); the association dir has no store and no lock. Rules (security fix-up T13c):

1. Acquire: atomic `fs.mkdirSync(<dataDir>/.varanda-lock, { mode: 0o700 })`, then publish the owner file `pid` = `<pid> <32-hex random token>` (written to `pid.<token>.tmp` with flag `wx`, then renamed, so a reader never sees a partial owner) and read it back to confirm ownership. Each `openStore` remembers its own token.
2. The lock path is inspected with `lstat`: anything that is not a real directory (symlink, regular file, ...) fails at once with `code 'LOCK_INVALID'` (`lock inválido (não é um diretório): <path>`); a lock that vanished between the mkdir and the inspection is retried after a short sleep.
3. `EEXIST` with a live pid (this process included) -> `LOCKED`. A dead pid, or one `process.kill(pid, 0)` refuses (EPERM: another user's process, which cannot own a `0o700` data dir of ours), is stale at once.
4. A missing or garbage owner is stale only when the lock directory's own mtime is at least `LOCK_GRACE_MS` = 10000 ms in the past, or more than that in the future (clock-skew guard). Otherwise it is re-read for up to `LOCK_WAIT_MS` = 1000 ms and the call then fails with `LOCKED`.
5. Takeover runs only while holding `<dataDir>/.varanda-lock.takeover` (an exclusive file holding our token; a later opener removes it once its mtime is 10 s old). The holder re-checks that the lock is the exact stale snapshot it inspected (dev, ino, owner bytes), renames it aside and deletes the aside copy only if it still matches. A moved lock that does not match is renamed back; if that fails it stays at `.varanda-lock.stale-<hex>`, is never deleted, and the call throws `LOCKED`.
6. Release: each store releases only its own token, at most once, after a successful `store.close()`, and synchronously on process `'exit'`. Every removal (release, exit hook, owner-write failure) deletes the lock dir only when the token read back is ours. A failed Corestore close (also on the `ready()` failure path) keeps the lock until exit and rethrows.
7. `<dataDir>/store` must not be a symlink: `openStore` refuses it with `code 'STORE_INVALID'` before any chmod (the Corestore primary key, from which the diary signing key derives, lives there). The data dir itself may be a symlink the user chose.
8. Residual risk: a dead owner's pid reused by a live process of the same user keeps the lock `LOCKED`; recovery is to remove `<dataDir>/.varanda-lock` by hand after checking that no `varanda` process uses the data dir (README).

### Member data dir (`--data`, env `VARANDA_DATA`, default `./data`)

- `store/` (Corestore).
- `.varanda-lock/` (the data-dir lock above, present only while a process holds the store; owner file `pid` = `<pid> <token>` inside) and, transiently during a stale-lock takeover, `.varanda-lock.takeover`.
- `quarantine/` (separate Corestore used only by `sync` for block-0 fetches, R5.4): wiped at every `runSync` start, removed at close BEFORE the main store closes (shutdown order of section 6: the data-dir lock is released last); never state.
- `config.json` = `{ "v": 1, "role": "member", "association": "<hex64>" }`, written by `id create`.
- `follows.json` = `{ "v": 1, "follows": ["<hex64>", ...] }`, sorted, unique.

### Seeder data dir

- `store/` (main Corestore). Every core in it is listed in `admitted.json` at every instant (R5.7, R6.1).
- `.varanda-lock/` (the data-dir lock of section 1, held by `seed` while it runs; `seed key` and `seed cert add` never open the store and take no lock).
- `quarantine/` (separate Corestore for block-0 fetches during admission, R5.4): wiped at every `Seeder.start()` AFTER the main store has been opened (its RocksDB lock protects the running process, R6.2), removed at close BEFORE the main store closes (the data-dir lock is released last, section 5 "Seeder shutdown"); nothing in it is ever state.
- `config.json` = `{ "v": 1, "role": "seeder", "association": "<hex64>" }`, written by `Seeder.ensureConfig` on the first of `seed key`, `seed cert add` or `seed` (R5.2 f).
- `seeder-key.json` = `{ "v": 1, "publicKey": "<hex64>", "secretKey": "<128 lowercase hex>" }`, mode `0o600`: the seeder's Noise key pair, generated by `generateNoiseKeyPair()` (`require('hyperdht').keyPair()`: 32-byte public key, 64-byte secret key) and written by `seed key` through `saveKeyPairFile` (R5.2 a).
- `seeder-cert.json` = the SeederCertificate (section 3) as pretty JSON + LF, written by `seed cert add` (R5.2 e).
- `admitted.json` = `{ "v": 1, "admitted": { "<hex64>": Certificate } }` — the ONLY state file (R5.7). Its entries are the union of the two in-memory maps below (R6.1).
- R4.7 / R5.7 / R6.1: after `start()`, two in-memory maps are the source of truth: `admitted` (key -> Certificate, keys being served) and `dropping` (key -> Certificate, keys being purged). `admitted.json` is written only from those maps through ONE serialized writer (`persist()`: a single promise queue doing write-tmp-then-rename) as `{ "v": 1, "admitted": { ...entries of admitted, ...entries of dropping } }` — a dropping key stays in the file — never by re-reading the file. Ordering invariant: a key is persisted BEFORE its core is opened in the main store (section 5, R5.5 d) and a dropped key is purged BEFORE its entry leaves the maps and the file (R6.1: `drop` moves it from `admitted` to `dropping`, purges, and only on success deletes it from `dropping` and persists; startup drops purge first, then remove, then persist). Hence every core in the main store is listed in `admitted.json` at every instant, whatever other keys persist concurrently; a key whose purge failed stays in `dropping` and in the file and is re-gated and re-purged at the next start.

### Association data dir

- `association.json` = `{ "v": 1, "publicKey": "<hex64>", "secretKey": "<128 lowercase hex>" }`, written with mode `0o600`.
- `members.jsonl` = one JSON line per issued certificate with exactly `{ member, ageBand, method, date }` — never a signature, a secret, a face image or a document.
- `seeders.jsonl` = one JSON line `{ "seeder": hex64, "date": ISO }` + LF per issued seeder certificate (`issueSeederCertificate`, R5.2 d) — never a signature or a secret.

### Files and replicas

- JSON state files are written atomically (`writeJsonAtomic`, `lib/store.js`): the content goes to a UNIQUE temporary name in the same directory, `.<base>.<pid>.<6 random bytes hex>.tmp`, opened with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` and the target mode (so a planted symlink at any predictable name such as `<file>.tmp` is never followed and never created), fsynced, then `renameSync` over `<file>`; on any failure the temporary file is unlinked in a `finally`. Two concurrent writers (same or different processes) each use their own temporary file, so both succeed and the last rename wins (never `ENOENT` from a shared temp name).
- Followed logs (replicas) are `store.get({ key: b4a.from(hex, 'hex'), valueEncoding: 'json' })` (`openReplica`); they are never writable. Their blocks are read only with `core.get(i, { raw: true, ... })` followed by `decodeBlock` (R4.1), never through the JSON value encoding.
- A not-yet-accepted log is NEVER opened in the main Corestore; its block 0 is fetched through the quarantine store (section 4, R5.4). An empty core must not exist in the main store.
- R5.9 a: replicas and the diary keep hypercore's DEFAULT `allowFork: true`; the project never passes `allowFork: false` (with it a rewrite is silently ignored and undetectable through public API; with the default the rewrite is applied and surfaces as the `'truncate'` event and `core.fork !== 0`).
- Every purge in the project goes through `purgeReplica(store, hex)` or through `quarantineGet0` (R5.4 b, c).

### Trust root

Every node trusts exactly ONE association public key, persisted in `config.json` and immutable afterwards. `id create` and the first seeder command (`seed key`, `seed cert add` or `seed`, through `Seeder.ensureConfig`) require it (`--association <hex64>` or env `VARANDA_ASSOCIATION`; seeder USAGE `informe --association ou VARANDA_ASSOCIATION`). On every later command `--association`/`VARANDA_ASSOCIATION` is optional and, when given, must equal `config.json`'s value, else error `associação diferente da configurada`. A node never infers its trust root from a certificate it received.

## 2. Log records (JSON blocks; seq = block index, 0-based)

- Block 0 (genesis) MUST be `{ "type": "member-cert", "cert": Certificate }` with `cert.member` equal to the diary key; no other block may have this type; a diary without block 0 cannot receive other records.
- `{ "type": "profile", "name": <string 1..80 chars>, "bio": <string 0..280 chars>, "at": <ISO-8601 UTC string> }`
- `{ "type": "post", "text": <string 1..1000 chars>, "at": <ISO>, "replyTo": null | { "author": "<hex64>", "seq": <integer >= 1> } }` — a post with `replyTo` is a reply to block `seq` of `author` (`seq >= 1` because block 0 is never a post).

Example records:

```json
{ "type": "member-cert", "cert": { "v": 1, "member": "<hex64>", "ageBand": "18+", "method": "stub", "date": "2026-01-01T00:00:00.000Z", "association": "<hex64>", "signature": "<128 hex>" } }
{ "type": "profile", "name": "Ana", "bio": "", "at": "2026-01-01T00:00:00.000Z" }
{ "type": "post", "text": "olá", "at": "2026-01-01T00:00:00.000Z", "replyTo": null }
{ "type": "post", "text": "concordo", "at": "2026-01-01T00:00:00.000Z", "replyTo": { "author": "<hex64>", "seq": 1 } }
```

Rules:

- Forbidden characters (reason `control-chars`, security audit S5) in `name`, `bio` and `text`: every code point below 0x20 (LF, 0x0a, is allowed in `bio` and `text` only, never in `name`), DEL (0x7f), the C1 controls (0x80-0x9f), the line and paragraph separators U+2028 and U+2029, and the bidi embedding/override/isolate controls U+202A-U+202E and U+2066-U+2069.
- Exact keys (S3): a `profile` has exactly `type`, `name`, `bio`, `at` and a `post` exactly `type`, `text`, `at`, `replyTo` (`postRecord` always writes `replyTo`, `null` when absent); any other key set is `malformed`.
- Storage limits (S3, constants in `lib/records.js`): `MAX_BLOCK_BYTES = 16384` (`decodeBlock` returns `null` for a longer buffer, so an oversized block 0 is `not-in-log` and an oversized record is skipped), `MAX_LOG_BLOCKS = 100000` and `MAX_LOG_BYTES = 67108864` (64 MiB) per log (sections 5 and 6, reason `quota`).
- Feed rendering (S5): `formatFeedItem` indents EVERY line of the text with two spaces, so no line of a post can start at column 0 and pass for a `[date]` header.
- `at` = `new Date().toISOString()` at write time and must be canonical, checked with `isCanonicalIso(at)` (below, R4.3); it is untrusted presentation data (ordering only).
- Readers skip blocks that are not valid records and never renumber. Reference string: `'<hex64>:<seq>'`.
- Logs are append-only. No Phase 0 writer ever truncates, so `fork !== 0` on any log means its history was rewritten by the key holder (R5.9 a); such a log is dropped everywhere with reason `'fork'` (sections 5, 6, 7).
- Future-dated posts (R5.10): a valid post whose `Date.parse(at) - now > MAX_FUTURE_MS` (`86400000`, 24 h) is SKIPPED by readers (excluded from the feed and reported as future), not clamped. Clamping would give the post a different position on every reader and every run (non-deterministic across devices) and still let one author pin the page bottom by republishing; skipping keeps `(at, author, seq)` ordering deterministic for a given clock, and the post reappears by itself once the reader's clock reaches `at - 24h`. The 24 h margin tolerates ordinary clock skew; past-dated posts are harmless (they sink).
- TODO(later phases): media attachments, moderation lists.

### Canonical timestamps never throw (R4.3)

`isCanonicalIso(s)` = `typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s`, evaluated inside try/catch (false on any throw: `new Date(invalid).toISOString()` throws `RangeError`). It is used for certificate `date` fields and record `at` fields. `validateRecord` NEVER throws for any input (including hostile strings, getters and non-objects); tests cover `'2026-13-01T00:00:00.000Z'` and non-string values.

### Safe block decoding (R4.1, supersedes the R3 a wording)

`lib/records.js` exports `decodeBlock(buf)` -> a plain object or `null`. It returns `null` when `buf` is not a Buffer/Uint8Array, when `JSON.parse(b4a.toString(buf, 'utf8'))` throws, or when the result is not a plain object (`null`, array, string, number).

No code path in the project reads a diary block through the JSON value encoding: every read of a block that may come from another device is `core.get(i, { raw: true, ... })` followed by `decodeBlock`. (Hypercore 11 throws `DECODING_ERROR` from a JSON-encoded `get` on bad bytes, after the block is already stored; raw reads avoid that.)

`readAll(core)` (`lib/store.js`) reads every block `0..core.contiguousLength-1` with `core.get(i, { wait: false, raw: true })` + `decodeBlock`, and maps a `null` result to `{ seq: i, record: null }` (kept, never renumbered; `validateRecord(null, seq)` returns `'malformed'`). `readAll` never throws `DECODING_ERROR` and never stops early.

## 3. Certificates

### Membership certificate

```json
{
  "v": 1,
  "member": "<hex64, the diary key>",
  "ageBand": "18+",
  "method": "stub",
  "date": "2026-01-01T00:00:00.000Z",
  "association": "<hex64>",
  "signature": "<128 lowercase hex>"
}
```

Certificate fields (no other keys):

- `v`: `1`.
- `member`: hex64 (diary key).
- `ageBand`: string matching `/^[a-z0-9+-]{1,32}$/` (suggested values `'13-15'`, `'16-17'`, `'18+'`; default `'18+'`).
- `method`: string matching `/^[a-z0-9-]{1,32}$/` (`'stub'` in phase 0).
- `date`: canonical ISO-8601 UTC with milliseconds, checked with `isCanonicalIso(date)` (section 2, R4.3).
- `association`: hex64 (Ed25519 public key from hypercore-crypto `keyPair()`).
- `signature`: 128 lowercase hex (hypercore-crypto `sign(payload, associationSecretKey)`).

`payload` = UTF-8 bytes of the six strings `'varanda-cert-v1'`, `member`, `ageBand`, `method`, `date`, `association` joined by a single LF character (no trailing LF), hex always lowercase. Never sign `JSON.stringify` output.

`verifyCert(cert, associationHex)` returns `{ ok: true }` or `{ ok: false, reason }` with the FIRST failing reason in this order:

1. `'malformed'` (shape above, `v === 1`, no unknown keys).
2. `'untrusted-association'` (`cert.association !== associationHex` lowercase).
3. `'bad-signature'` (hypercore-crypto `verify(payload, signature, association)` is false).

`certForKey(cert, keyHex, associationHex)` inserts `'member-mismatch'` (`cert.member !== keyHex`) after `'malformed'`. Callers add `'no-cert'` (block 0 absent) and `'not-in-log'` (block 0 present but not a valid member-cert for that key).

R4.3: `verifyCert`, `certForKey` and `validateCertShape` NEVER throw for any input (including hostile strings such as a `date` of `'2026-13-01T00:00:00.000Z'`, getters and non-objects); an input that would make a check throw yields `'malformed'`. Tests cover `'2026-13-01T00:00:00.000Z'` and non-string values.

### Seeder certificate (R5.2)

```json
{
  "v": 1,
  "seeder": "<hex64 Noise public key>",
  "date": "2026-01-01T00:00:00.000Z",
  "association": "<hex64>",
  "signature": "<128 lowercase hex>"
}
```

`SeederCertificate` has exactly these 5 keys: `v` (`1`), `seeder` (hex64, the seeder's Noise static public key from `seeder-key.json`), `date` (canonical ISO, `isCanonicalIso`), `association` (hex64), `signature` (128 lowercase hex, hypercore-crypto `sign(payload, associationSecretKey)`).

`payload` = UTF-8 bytes of `'varanda-seeder-v1'`, `seeder`, `date`, `association` joined by a single LF (no trailing LF, hex lowercase). The prefix differs from `'varanda-cert-v1'`, so a member signature is never a valid seeder signature and vice versa.

- `seederCertPayload(cert)` -> Buffer.
- `createSeederCert({ seeder, date = new Date().toISOString() }, associationKeyPair)` -> SeederCertificate; TypeError unless `seeder` is hex64 in any case (stored lowercase), `date` is canonical and the secretKey is 64 bytes.
- `validateSeederCertShape(cert)` -> `null | 'malformed'`.
- `verifySeederCert(cert, associationHex)` -> `{ ok: true } | { ok: false, reason }` with reasons in order `'malformed'`, `'untrusted-association'`, `'bad-signature'`.
- `seederCertForKey(cert, noiseHex, associationHex)` inserts `'seeder-mismatch'` (`cert.seeder !== normalizeHex(noiseHex)`) after `'malformed'`.
- All four never throw (R4.3).

The association issues it with `assoc certify-seeder` (`issueSeederCertificate`, which appends the `seeders.jsonl` line). Members verify it against the Noise-authenticated `socket.remotePublicKey` of the connection that carried it (section 6, R5.3 c).

No expiry or revocation in phase 0 for either certificate (TODO phase 2: revocation and moderation lists). The age check is a stub: the operator of `assoc certify` asserts the age band (TODO phase 1: real age-verification vendor). The association stores only (public key, age band, method, date) for members and (seeder key, date) for seeders.

## 4. Network

- Rendezvous topic = hypercore-crypto `hash(b4a.from('varanda/rendezvous/v1:' + associationHex, 'utf8'))`, 32 bytes. Every member and seeder of an association joins it with `{ server: true, client: true }`.
- Members ALSO join their diary's `discoveryKey` and every followed key's `discoveryKey`; seeders ALSO join every admitted replica's `discoveryKey` (at startup and immediately after each admission).
- For topics joined before the first flush: `await discovery.flushed()` for each, then `await swarm.flush()`.
- Hyperswarm keeps one connection per peer pair regardless of how many topics match.

### Bootstrap and DHT binding (R5.11)

`--bootstrap host:port` (repeatable) or env `VARANDA_BOOTSTRAP` (comma-separated `host:port`). Unset = the public DHT (manual use only). A malformed value is a usage error (`bootstrap inválido <entry>`) and never falls back to the public DHT. Any `--bootstrap` flag wins over `VARANDA_BOOTSTRAP`. A bootstrap source that is PRESENT but yields no entry (an empty string, only commas or spaces, e.g. `VARANDA_BOOTSTRAP=` or `--bootstrap ''`) is also a usage error, `bootstrap inválido (vazio)`: silently falling back to the public DHT would move private-network traffic onto the internet; only an absent flag and an unset variable mean "public DHT". `bootstrap` is an array of `'host:port'` strings (HyperDHT also accepts the `{ host, port }` objects that `hyperdht/testnet` returns).

`createSwarm({ bootstrap, keyPair, host } = {})`: `const dhtOpts = bootstrap ? { bootstrap, port: [0, 0] } : {}`; `if (host) { dhtOpts.host = host; if (host === '127.0.0.1' || host === '::1') dhtOpts.firewalled = false }`; `return new Hyperswarm({ keyPair, dht: new HyperDHT(dhtOpts) })` (`keyPair` undefined lets hyperswarm generate one; the seeder passes its loaded `seeder-key.json` pair). With a private bootstrap the DHT therefore binds an ephemeral port (hyperdht rewrites `port: 0` to 49737; the range `[0, 0]` has no candidates and falls through to `bind(0)`); without a bootstrap (public DHT, manual use) hyperdht defaults stay. `firewalled: false` is set ONLY when the DHT host is a loopback address (tests, the demo and same-machine manual runs): there every node is directly reachable, and with hyperdht's default firewall probing a client-initiated connection between two processes that both bound ephemeral ports opened but carried no data until the other side reconnected (observed with hyperdht 6.34 on loopback; the demo's `sync --once` then waited on the seeder's re-discovery and took ~80 s instead of ~10 s). A private bootstrap on any other host says nothing about reachability (a peer behind NAT would fail to connect if forced unfirewalled), so hyperdht's own detection stays on. `--dht-host <ip>` / `VARANDA_DHT_HOST` is passed as `host` to `runSync` and `Seeder`. Every test and the demo use `host: '127.0.0.1'` / `--dht-host 127.0.0.1`. `swarm.destroy()` also destroys the DHT instance passed to it; never destroy it separately.

### Re-discovery (`startRediscovery`)

Hyperswarm refreshes a discovery only every 10 minutes, so two swarms whose first join of a topic happens at the same moment (each looks up before the other's announce is stored) would otherwise not find each other for that long. `startRediscovery(swarm, topics, { intervalMs, hasPeer, log })` (`lib/net.js`) -> `stop()`: every `intervalMs` it calls `discovery.refresh()` (announce + lookup) on each joined topic for which `hasPeer(topic)` is false; errors are logged as `{ event: 'rediscovery-error', topic, error }` and never thrown. `hasPeer` must reflect CURRENT live connections, so re-discovery resumes when the last peer of a topic disconnects: `runSync` counts open sockets per topic (from `info.topics` of client-side connections, incremented on connect and decremented on the socket's `'close'`) plus connected peers whose `remoteHave` holds the topic's key, and for the rendezvous topic the number of open sockets (`intervalMs` 1000 in `--once`, 10000 long-running); the seeder uses `swarm.connections.size > 0` for the rendezvous (10000 ms).

### findingPeers

`const done = store.findingPeers()` before joining; call `done()` exactly once in a `finally` block when `swarm.flush()` settles (success or failure).

### On EVERY connection, in this order

1. `store.replicate(socket)`: the main Corestore creates the Protomux muxer on `socket.userData` and attaches every open core; cores opened later are attached when they start downloading, and cores stored on disk are attached when the remote asks for them by discovery key. This is why a not-yet-accepted log is never opened in the main store (quarantine below).
2. `attachAdmission(socket, ...)` from `lib/net.js`, which takes the SAME muxer via `Hypercore.getProtocolMuxer(socket)` (a hyperswarm socket is its own noiseStream); never construct a second muxer.
3. Both sides open the admission channel immediately and send `hello` after `onopen` (followed by the overflow `have` messages of section 5, R4.4).

### Quarantine: no uploads during admission (R5.4)

- Why: the main Corestore serves ANY core present in its storage to ANY peer that asks by discovery key (`_attachMaybe`), `active: false` does not change that, and hypercore 11 has no upload switch (`uploading: true` hardcoded, `_handleRequest` answers from storage). Therefore a not-yet-accepted log is NEVER opened in the main Corestore.
- Mechanism: block 0 is fetched through a separate quarantine Corestore at `<dataDir>/quarantine` whose cores are attached ONLY to the socket(s) of the peer(s) that offered the key, with `core.replicate(socket)` at the hypercore level. This registers only the per-core `pair({ protocol: 'hypercore/alpha', id: discoveryKey })` and opens one unique channel on that muxer; it never calls `Corestore.replicate(socket)`, so the main store's protocol-wide `pair` handler on that socket is untouched (a second `Corestore.replicate` on the same socket would replace it — protomux `pair` is a Map.set).
- A third peer asking for the key reaches the main store's handler, which finds nothing (quarantine has its own storage and core tracker) and rejects the channel; the quarantine channel exists only on the offering peer's socket.
- `startQuarantineFetch(qstore, keyHex, sockets, timeoutMs)` -> `{ promise, addSocket }` (section 8) always purges the quarantine core whatever the outcome; `quarantineGet0` is the same fetch awaited directly. Late advertisers: while a fetch for K is in flight, `addSocket(socket)` attaches one more peer (one that advertised K with length >= 1 after the fetch started) to the SAME quarantine core, so a working peer that arrives later can still supply block 0 before the deadline; the member sync uses it (section 6, R5.8 b), the seeder keeps a single-socket fetch (admission is attached only to the announcer P). The quarantine directory is wiped at every `Seeder.start()` and `runSync` start and removed at close; nothing in it is ever state.
- Lock before wiping (R6.2): `Seeder.start()` and `runSync` open the main store FIRST (`store = await openStore(dataDir)`, which takes the RocksDB lock and fails fast when another process holds that data dir) and only THEN call `qstore = await openQuarantine(dataDir)`. A second process on the same data dir therefore fails on the lock before touching `<dataDir>/quarantine`, so it can never wipe the quarantine of a running `seed` or `sync`.
- Lock released last (shutdown): the quarantine store is closed and its directory removed, and every in-flight fetch and purge has settled, BEFORE the main store closes; `store.close()` (which releases the data-dir lock) is the LAST step of `Seeder.close()` and of the `runSync` cleanup. A process that takes the lock the instant it is released (and wipes/recreates `<dataDir>/quarantine` at its start) therefore never has its quarantine removed under it by the previous owner's cleanup.

### Environment summary

`VARANDA_DATA`, `VARANDA_ASSOCIATION`, `VARANDA_BOOTSTRAP`, `VARANDA_DHT_HOST`.

## 5. Admission channel (`'varanda/admission/1'`)

`mux.createChannel({ protocol: 'varanda/admission/1', onopen, onclose })`; `null` means the channel already exists on this socket (reuse the cached handle). ONE message type is added with encoding `c.buffer` (compact-encoding); the payload is UTF-8 JSON. A payload over 16384 bytes, empty, unparsable, or failing the shape rules (`validateMessage`) is ignored (counted in `badMessages`) and never dispatched. Send only after `onopen` (queue earlier sends).

`Peer.opened` resolves `true` on `onopen`; `Peer.hello` resolves with the first VALID hello. When the channel closes before it opened, `opened` resolves `false`; when it closes before a valid hello arrived, `hello` resolves `null`. Neither promise ever rejects, so a caller awaiting them treats `false`/`null` as "peer gone" (the seeder's `peer` log line is skipped on a `null` hello; `runSync` tracks hello through `onmessage` instead). After close, `send()` returns `false` and the queue is dropped; `onclose(peer)` runs exactly once.

### Messages

- `hello`: `{ "type": "hello", "v": 1, "role": "member" | "seeder", "count": <integer >= have.length>, "have": [{ "key": "<hex64>", "length": <integer >= 0> }], "cert"?: SeederCertificate }` — first message after open. See "Bounded inventory" below for `count` and `have`. R5.3 a: `cert` MUST be present and a plain object when `role === 'seeder'` and MUST be absent when `role === 'member'`; `validateMessage` enforces both (a seeder hello without `cert`, or a member hello with one, is counted in `badMessages` and never dispatched). The 16384-byte payload limit is unchanged.
- `have`: `{ "type": "have", "key": "<hex64>", "length": <integer >= 0> }` — sent (1) for each inventory entry that did not fit in `hello`, (2) whenever the `contiguousLength` of a served core grows, and (3) by a member when a followed key changes state: becoming pending (length 0, interest only) or passing the gate (length = `contiguousLength`).
- `announce`: `{ "type": "announce", "key": "<hex64>", "cert": Certificate }` — member -> seeder: replicate this diary, here is its certificate; sent once per connection for the member's own key when its block 0 is a valid member-cert for the trusted association. Members ignore incoming `announce`. `announce` stays unauthenticated by design.
- `admitted`: `{ "type": "admitted", "key": "<hex64>", "length": <integer >= 0> }` — seeder -> member after admission (idempotent; `length` = the seeder's `contiguousLength`).
- `rejected`: `{ "type": "rejected", "key": "<hex64>", "reason": <string matching /^[a-z0-9-]{1,64}$/> }` — R5.1 a: may be sent by ANY role, to any peer. Meaning: "the sender will not keep or serve `key`". Reason master list (R5.9 f, S3): `malformed` | `member-mismatch` | `untrusted-association` | `bad-signature` | `not-in-log` | `timeout` | `fork` | `no-cert` | `admission-failed` | `quota` | `seeder-full` (review item 4a: the seeder already serves `MAX_INVENTORY` logs). S4: a `reason` outside that charset (free text, control characters) is a bad message, never dispatched; every reason the seeder or a member can send is a token of the master list. Defence in depth: `lib/commands/sync.js` escapes C0/C1 controls, DEL, U+2028/U+2029 and the bidi controls as `\u{XX}` in every string it prints that came from a peer or a log (`safe`).
- `admitted` (S2) may only come from a peer whose hello role is `seeder`: an `admitted` from any other role (or before the hello) is a bad message and never touches `remoteHave`. (`rejected` stays allowed from any role: members send it as a withdrawal, R5.1 a.)
  - Members send it (broadcast to every open admission channel) when (1) a followed key's remote gate FAILS with a non-timeout reason (section 6, R5.8), (2) a fork is detected on a followed key, reason `'fork'` (R5.9), and (3) the local re-gate of a replica opened after a remote pass fails (section 6, `bloco 0 divergente`).
  - Seeders send it to the announcer on admission failure (including `'admission-failed'`: the gate passed but persisting or opening the replica threw, section 5 d) and broadcast it on every runtime drop (R5.5, R5.9).
  - Nobody sends `rejected` for `'timeout'` except a seeder answering an announce; nobody sends `'admission-failed'` except a seeder answering an announce.

Example `hello` from a member with its own diary (3 blocks), one followed key that passed the gate and one whose gate is pending:

```json
{ "type": "hello", "v": 1, "role": "member", "count": 3, "have": [{ "key": "<own hex64>", "length": 3 }, { "key": "<followed hex64>", "length": 5 }, { "key": "<pending hex64>", "length": 0 }] }
```

A seeder `hello` additionally carries `"cert": { "v": 1, "seeder": "<hex64>", "date": "...", "association": "<hex64>", "signature": "<128 hex>" }`.

### Latest-wins advertisements (R5.1 b)

`Peer.remoteHave` (lib/net.js) holds the LATEST length advertised per key, never a max: a valid `hello` REPLACES the map with its `have` entries (plus the overflow `have` messages); `have` and `admitted` do `remoteHave.set(key, length)`; a valid `rejected` does `remoteHave.delete(key)` BEFORE `onmessage` is called.

### Bounded inventory (R4.4)

- The inventory of a peer is every key it serves or wants. Member: its own key, every followed key whose gate PASSED (length = `contiguousLength`) and every followed key whose gate is still PENDING with length 0 (R4.5). Seeder: every admitted key (length = `contiguousLength`).
- `count` = total number of keys in the sender's inventory (integer >= `have.length`); `have` = the first at most 100 entries. The remaining entries are sent immediately after `hello` as individual `have` messages, in order.
- `validateMessage` rejects a `hello` whose `have` has more than 100 entries or whose `count < have.length`.
- The Peer gains `remoteCount` (from `hello`) and `inventoryComplete`: true once `remoteHave` holds `remoteCount` distinct keys, or 5000 ms after its `hello`, whichever comes first; the timeout is logged.
- Hello before inventory completion: the valid `hello` is dispatched to `onmessage` BEFORE the completion check for that hello runs, so `oninventory` (and the completion it reports) always observes the caller's per-peer state already updated from that hello (`remoteRole`, `remoteCert`, the member's `verifiedSeeder`). A hello with an empty inventory therefore reaches `onmessage` first and `oninventory` second, never the other way round.
- Overflow advertisements before inventory completion (review item 2): the same rule holds for `have` and `admitted`: `remoteHave.set(key, length)`, then `onmessage(msg)`, THEN the completion check. When the advertisement that completes the inventory is the last overflow `have`, the caller has already recorded it (in `runSync`, the claim of section 6) by the time `oninventory` fires, so `--once` can never resolve on an inventory whose last advertisement it has not seen.
- No replacement hello (S6): our side sends exactly one `hello` per connection (in `onopen`); a second valid `hello` on the same connection is a protocol violation and the peer is dropped (`duplicate-hello`), so a peer can never keep its inventory incomplete by re-sending hello.

### Per-connection limits (security audit S1, constants in `lib/net.js`)

- `MAX_INVENTORY = 4096`: a `hello` with `count > MAX_INVENTORY` is invalid; a `have`/`admitted` for a key not yet in `remoteHave` while `remoteHave.size >= MAX_INVENTORY` drops the peer (`inventory-limit`), so the map never exceeds the cap. Every advertised `length` must be `<= MAX_LOG_BLOCKS` (`isLength`), else the message is invalid.
- `MAX_BAD_MESSAGES = 16`: a connection whose `badMessages` exceeds it (the 17th bad message) is dropped (`bad-messages`).
- `HELLO_TIMEOUT_MS = 10000`: a peer that has not sent a valid `hello` within it (counted from `attachAdmission`, which opens the channel at once) is dropped (`hello-timeout`); injectable as `attachAdmission(socket, { helloTimeoutMs })` for tests.
- `MAX_CONNECTIONS = 64`: `createSwarm` passes `maxPeers: MAX_CONNECTIONS` to Hyperswarm (which bounds the connections it initiates; hyperswarm 4.17 stores `maxServerConnections` but never reads it), and `refuseOverConnectionLimit(swarm, socket, { limit, log })` runs on EVERY `'connection'` of the seeder and of `runSync` BEFORE `store.replicate(socket)`: when the swarm already holds `limit` other open connections the socket is destroyed (`connection-limit`). `Seeder` and `runSync` take `maxConnections` (tests only).
- Senders never advertise more than the receivers accept (review item 4): `attachAdmission` throws `TypeError('inventory over MAX_INVENTORY')` for a `have` list longer than `MAX_INVENTORY`, and the callers keep their inventories under it: (a) the seeder refuses an admission with `rejected { key, reason: 'seeder-full' }` while it already serves `MAX_INVENTORY` logs (`Seeder` option `maxServed`, tests only; an already admitted key is still answered `admitted`); (b) `follow` refuses a new key when `follows.json` already holds `MAX_INVENTORY - 1` keys (own diary + follows = `MAX_INVENTORY`): stderr `erro: limite de diários seguidos atingido`, exit 1, `follows.json` unchanged (an already followed key stays idempotent, exit 0); (c) `runSync` with a hand-edited `follows.json` over the limit uses only its first `MAX_INVENTORY - 1` entries and writes `aviso: limite de diários seguidos excedido: só os primeiros <n> serão sincronizados` through `log` (stderr) (`runSync` option `maxFollows`, tests only).
- `announce` flood (review item 1, `lib/seeder.js`): a peer that would hold more than `MAX_INVENTORY` distinct keys outstanding in the seeder's announce queues (running, queued or waiting, section 5) is dropped (`announce-limit`; `Seeder` option `maxAnnounces`, tests only).
- Every drop logs exactly one event `{ event: 'peer-dropped', peerKey, reason }` with `reason` in `inventory-limit` | `bad-messages` | `hello-timeout` | `connection-limit` | `duplicate-hello` | `announce-limit` (the seeder prints it through its `log`; `runSync` emits it through `onEvent` and writes `aviso: par descartado (<peerKey8>): <reason>` through `log`). Destroying the socket closes the channel, so `onclose(peer)` runs as for any disconnect.

### Message rate (security fix cycle 3)

- Every valid admission message (hello included) costs one token from a per-connection bucket: `MESSAGE_BURST = MAX_INVENTORY + 64` tokens, refilled at `MESSAGE_RATE = 100`/s (`lib/net.js`, injectable as `messageBurst` / `messageRate`). An empty bucket drops the peer (`peer-dropped`, reason `message-rate`).
- Senders pace themselves below that limit (the same burst minus 1/16, half the rate); queued `have` messages are merged per key (the latest length wins, order kept against other messages for that key). The initial inventory (hello plus overflow `have` messages) goes out at once and fits the receiver's burst.
- A member processes a `have` only for its own key or a followed key, and only when that peer's advertised length changed; the `have` event fires only on a change and `withdrawn` at most once per peer.
- Closing the admission channel, before or after hello, destroys the socket: replication and the connection slot end with it (no slot can be held without a hello).
- Messages sent before the channel opens share the same paced, per-key-merged send backlog; it is flushed after the initial inventory and capped at `MAX_SEND_BACKLOG = MAX_INVENTORY + 64` entries (exceeding it drops the peer: `peer-dropped`, reason `send-backlog`).
- The rate buckets (per-connection messages and the seeder's announces) use a monotonic clock (`performance.now()`), so a wall-clock step never drops honest peers.

### Interest is advertised without data (R4.5)

A member lists in `hello`/`have` its own key, every followed key whose gate PASSED (length = `contiguousLength`) and every followed key whose gate is still PENDING with length 0 (interest only). A pending key has no core in the main store (R5.4, R5.8 a), so nothing can be served for it. Followed keys whose gate FAILED are excluded. Advertising a pending key with length 0 never makes the sender serve data for it.

### The block-0 gate (R4.2, R5.4; identical in the seeder and in member sync)

- Verdict on a raw block (inline in lib/seeder.js and lib/sync.js, identical): `block0 = decodeBlock(raw)`; reason `'not-in-log'` when `block0 === null` or `validateRecord(block0, 0) !== null`; else `certForKey(block0.cert, keyHex, associationHex)` -> `null` when ok, otherwise its reason.
- REMOTE gate (key not yet accepted): `r = await quarantineGet0(qstore, keyHex, sockets, timeoutMs)` through the quarantine store only (section 4). `r.error === 'timeout'` (any throw of the fetch) -> timeout outcome; otherwise the verdict on `r.raw`. The quarantine core is always purged by `quarantineGet0`; nothing is opened in the main store on this path.
- LOCAL gate (block 0 already in the main store): `core.get(0, { wait: false, raw: true })` + the same verdict; any error thrown by `get` or by the checks counts as `'not-in-log'` (never let it skip the purge). On failure the main-store core is purged through `purgeReplica(store, keyHex)`.

### Seeder admission algorithm (R5.5) for `announce { key, cert }` from peer P

R4.7 as bounded by review item 1: step (a) runs synchronously when the `announce` arrives, BEFORE anything is queued, so an invalid announce is answered at once and never costs memory. A valid one enters the key's queue: at most ONE admission RUNS per key and at most ONE more is QUEUED (it runs when the running one settles, normally answering through (b)); any further announce for the key only adds its peer to the queued admission's waiter set (one slot per peer; the queued announcer itself is answered by its own run) and is answered with that admission's outcome (admitted -> `admitted { key, length }`, rejection -> `rejected` with the same reason; nothing when the seeder is closing). So a flood of announces behind a slow gate keeps the queue at one running + one queued + one waiter slot per peer, and the key is admitted once. Per peer, the outstanding keys (running, queued or waiting) are bounded by `MAX_INVENTORY`: the announce that would exceed it drops the peer (`peer-dropped`, `announce-limit`, section 5 limits). An announce is not bound to the diary signer: anyone may ask the seeder to keep a member's log, but only a log whose block 0 passes the gate is ever kept.

(a) `key` not hex64 or `certForKey(cert, key, association)` fails -> `rejected` with that reason.

(b) `key` in the in-memory `admitted` map -> `admitted { key, length: core.contiguousLength }`. An announce for a key in `dropping` (R6.1) waits on that key's per-key chain (the drop in progress) and is then handled as a fresh attempt.

(b') Inventory cap (review item 4a): when the seeder already serves `MAX_INVENTORY` logs -> `rejected { key, reason: 'seeder-full' }` and log `{ event: 'rejected', key, reason: 'seeder-full' }`, before any fetch (a seeder serving more could no longer send a valid `hello`).

(c) `r = await quarantineGet0(qstore, key, [P.socket], 15000)` (constant `GATE_TIMEOUT_MS = 15000`); if a test `gateHook` is configured, `await gateHook(key)` runs here. Then (R6.3): `r.error` -> `rejected { key, reason: 'timeout' }` and log `{ event: 'rejected', key, reason: 'timeout' }`; else compute the verdict (block-0 gate above); a NON-NULL verdict -> `rejected { key, reason: verdict }` and log `{ event: 'rejected', key, reason }`; a NULL verdict -> continue with step (d). `rejected` is never sent with a null reason. Nothing is ever opened in the main store on the rejection paths.

(c') Log quota at the gate (S3): the quarantine fetch also returns the signed `length` and `byteLength` the quarantine core learned with block 0 (the upgrade proof); `length > MAX_LOG_BLOCKS || byteLength > MAX_LOG_BYTES` -> `rejected { key, reason: 'quota' }` and log `{ event: 'rejected', key, reason: 'quota' }`, nothing opened in the main store (`Seeder` takes `maxLogBlocks` / `maxLogBytes`, tests only).

(d) Admit (null verdict): `admitted.set(key, cert)`; `await persist()` (R5.7, BEFORE the main store opens the key); `core = await openReplica(store, key)`. Rollback: if `persist()` throws (e.g. `ENOSPC`) or `openReplica` throws, the key is removed from `admitted`, `persist()` runs again best-effort (its failure is ignored), the seeder logs `{ event: 'rejected', key, reason: 'admission-failed' }` and replies `rejected { key, reason: 'admission-failed' }`; nothing is served and a later `announce` for the key runs the full gate (c) again. S7: when the failure happened in the open step and the storage already holds the core (`store.storage.hasCore(discoveryKey)`; corestore would serve a stored core), the replica is purged (`purgeReplica`) BEFORE the key leaves `admitted`; a purge failure is fatal like every other (`{ event: 'fatal', key, reason: 'purge-failed' }`, the seeder closes, the key stays listed and the next `start()` re-gates and purges it, `no-cert`). Otherwise: `watchFork(core, ...)` (R5.9); live `core.download({ start: 0, end: -1 })`; `swarm.join(core.discoveryKey, { server: true, client: true })`; `watchContiguous(core, ...)` -> broadcast `have { key, length }` + log `{ event: 'have', key, length }`; re-gate on arrival: the first time `contiguousLength >= 1` after this open, run the LOCAL gate — failure -> `drop(key, reason)`; reply `admitted { key, length: core.contiguousLength }` (0 at this point; the `have` messages follow) and log `{ event: 'admitted', key, length }`. Review item 6: the quota (S3) is checked once when the replica starts being served, BEFORE the join; a resumed main-store core already over the quota is dropped right there (`drop(key, 'quota')`: `rejected` broadcast, purge) and the admission stops: no `swarm.join` of its topic, no `admitted` reply, no `admitted` log.

(d') Log quota on growth (S3): for every served replica the seeder listens to `'append'` (registered before the growth watcher) and checks again on every growth: `core.length > MAX_LOG_BLOCKS || core.byteLength > MAX_LOG_BYTES` -> `drop(key, 'quota')` through the path (e) below (admitted.json updated, purge failure fatal), before any block past the limit is advertised.

(e) `drop(key, reason)` (runtime, R6.1): move the entry from `admitted` to `dropping` (the key stays persisted: `persist()` writes both maps); stop its watchers and destroy its download range; broadcast `rejected { key, reason }` to every open channel; log `{ event: 'rejected', key, reason }`; `await purgeReplica(store, key)`; on success delete it from `dropping` and `await persist()`. On a purge throw the key STAYS in `dropping` (and in the file): log `{ event: 'fatal', key, reason: 'purge-failed' }` and close the seeder; the next `start()` re-gates it (it fails the local gate or is empty/forked) and purges it. A concurrent `persist()` for another key (admission or drop) can never write a snapshot without the dropping key. Forks (R5.9 c): `watchFork`'s `onFork` -> `drop(key, 'fork')`.

### Announce limits, capacity and the shared gate fetch (security fix cycle 2)

- Per-peer announce rate: a token bucket of `ANNOUNCE_BURST = 20` announces refilled at `ANNOUNCE_RATE = 10`/s (injectable `announceRate` / `announceBurst`), checked before any signature is verified. A peer over it is dropped (`peer-dropped`, reason `announce-rate`).
- A peer whose announced certificate (or key) fails `MAX_BAD_ANNOUNCES = 16` times is dropped (`peer-dropped`, reason `bad-announces`); once dropped, its later announces cost no verify.
- Capacity: an admission reserves a slot before its gate; when served + reserved >= the cap (`maxServed`, default `MAX_INVENTORY`) the answer is `rejected { reason: 'seeder-full' }`, and the cap is checked again before the key is admitted.
- At start, valid listed logs beyond the cap (admitted.json order) are purged and removed from admitted.json before the swarm starts (event `warning`, reason `seeder-full`). A hello never carries more than `MAX_INVENTORY` entries.
- The gate uses `startQuarantineFetch`: every queued announcer and waiter of a key is attached (`addSocket`) to the block-0 fetch in flight, so any honest announcer can supply block 0.
- Waiters only receive an outcome that does not depend on another announcer's socket: `admitted`, or a block-0 certificate rejection other than `not-in-log`. After any other outcome (`timeout`, `not-in-log`, `quota`, `admission-failed`, `seeder-full`), a still-connected waiter runs its own gate; a queued announcer that left hands its turn to a connected waiter.

### Seeder startup (R5.6)

Lock before state (security fix cycle 2): `start()` takes the data-dir lock (opens the main store) BEFORE it reads admitted.json, so it never starts from a list a previous process was still writing; the main store still opens before the quarantine is wiped (R6.2), and the lock is still released last at shutdown. Step 1 (config, seeder key, seeder certificate) stays before the lock: a running seeder never writes those files and they are fully validated at start.

`start()` performs, in this order, and creates NO swarm and starts NO download before step 4 completes:

1. `Seeder.ensureConfig`; load `seeder-key.json` and `seeder-cert.json` and verify (errors of section 7, R5.2 f).
2. Load `admitted.json` into the `admitted` map (every listed key, including keys a previous run left mid-drop); `store = await openStore(dataDir)` FIRST (takes the RocksDB lock, fails fast when another process holds the data dir); only THEN `qstore = await openQuarantine(dataDir)` (R6.2).
3. For each admitted key: `core = await openReplica(store, key)`; if `core.fork !== 0` -> startup drop with reason `'fork'`; else if `core.contiguousLength === 0` -> startup drop with reason `'no-cert'`; else if `core.length > maxLogBlocks || core.byteLength > maxLogBytes` -> startup drop with reason `'quota'` (review item 5: the quota is part of the startup gate, so an over-quota stored log, e.g. after a restart with a lowered limit, is purged BEFORE step 4 and its topic is never joined nor served); else LOCAL gate -> pass: keep; fail: startup drop with that reason. Startup drop (R6.1 order) = log `{ event: 'rejected', key, reason }`, `await purgeReplica(store, key)` FIRST, then remove the key from `admitted`, then `await persist()`. If any purge throws, the key stays in the map and in the file and `start()` throws `Error('falha ao limpar diário rejeitado: ' + key8)` after closing the stores (fail closed).
4. For every surviving key: `watchFork`, live download, `watchContiguous`. A runtime `drop` that happens here (no swarm yet) skips the `swarm.leave` (`drop` is safe before the swarm exists).
5. `createSwarm({ bootstrap, keyPair, host })`; `done = store.findingPeers()`; join `topicFor(association)` + every surviving `discoveryKey` with `joinAndFlush` in try/finally `done()`; log `{ event: 'ready', topic, admitted }`.

The swarm uses the loaded `seeder-key.json` pair, so `socket.remotePublicKey` seen by members equals `cert.seeder`. Every seeder `hello` carries `seeder-cert.json` as `cert`.

### Seeder shutdown (`close()`), the data-dir lock released last

(1) stop the re-discovery, every replica watcher and every download range; (2) destroy the swarm; (3) close the quarantine store, wait for every in-flight admission step, `removeQuarantine(dataDir)`; (4) wait for every drop (purge) in progress; (5) close the main store, which releases the data-dir lock. A `seed` that takes the lock the instant it is released (and wipes/recreates `<dataDir>/quarantine` in its step 2) keeps its quarantine intact.

### Runtime purge failure (fail closed, R3 b / R4.7 / R5.5 e)

A purge throw at runtime (in `drop`, or propagated by `quarantineGet0` on the announce path) logs `{ event: 'fatal', key, reason: 'purge-failed' }` and closes the seeder. Corestore serves any stored core on request through its `ondiscoverykey`/`_attachMaybe` path, so a stored non-admitted core must never stay reachable; because a dropped key stays in `dropping` (and therefore in `admitted.json`) until its purge succeeds (R6.1), the next `start()` re-gates and re-purges it (step 3). Invariant (restated): every core in the main store is listed in `admitted.json` at every instant.

TODO(phase2): consult moderation and revocation lists before admitting.

## 6. Member sync (`lib/sync.js` `runSync`) and the `--once` completion rule

Open, in this order, the member store (`store = await openStore(dataDir)` FIRST: it takes the RocksDB lock and fails fast when another process holds the data dir), `config.json` (trust root), the diary, only THEN the quarantine store (`qstore = await openQuarantine(dataDir)`, R6.2: a second `sync` on the same `--data` fails on the lock before touching `<dataDir>/quarantine`), and gate every follow (below) before any swarm. `cert` = block 0 (read raw and decoded with `decodeBlock`) when `certForKey(block0.cert, ownHex, association).ok`, else warn `sem certificado válido no bloco 0: o diário não será anunciado`. `runSync` takes `host` (R5.11).

Shutdown order (the `finally` of `runSync`, after the result is settled or on a throw), the data-dir lock released LAST: (1) stop every timer, the re-discovery, the diary and replica watchers, and destroy every download range; (2) destroy the swarm; (3) close the quarantine store, wait for every in-flight quarantine fetch, `removeQuarantine(dataDir)`; (4) wait for every pending purge and local re-gate; (5) close the main store, which releases the data-dir lock. A `sync` that takes the lock the instant it is released (and wipes/recreates `<dataDir>/quarantine` at its start) keeps its quarantine intact. `Seeder.close()` follows the same order (section 5).

### Member follow gate (R5.8)

(a) At `runSync` start, before any swarm and after the main store and then the quarantine store are open (R6.2), for each followed key K: `core = await openReplica(store, K)`;
- `core.fork !== 0` -> `purgeReplica` + skipped `'fork'`;
- `core.contiguousLength === 0` -> `await purgeReplica(store, K)` (an empty core must not exist in the main store) and K is PENDING (NOT skipped, nothing stored);
- otherwise LOCAL gate (section 5) -> pass: ACTIVE (live download, inventory entry with `contiguousLength`); fail: `purgeReplica` + skipped reason. A locally stored valid block 0 passes; it is never purged merely because it was read as raw bytes.

(b) Pending keys are advertised with length 0 (R4.5). The remote gate for K starts ONLY when some connected peer's `remoteHave` reports K with length >= 1 (from hello, have or admitted) and no fetch for K is in flight: `sockets` = the `socket` of every connected peer whose latest advertisement of K is >= 1; `timeoutMs` = in `--once` mode `deadline - Date.now()` (deadline = start + `timeoutMs` of the run, see One deadline below; a fetch starts only while at least `GATE_MIN_TIMEOUT_MS = 250` ms remain, and never runs past the deadline), in long-running mode `GATE_TIMEOUT_MS = 15000`; `{ promise, addSocket } = startQuarantineFetch(qstore, K, sockets, timeoutMs)`, `r = await promise`. Late advertisers: while that fetch is in flight, every peer that then advertises K with length >= 1 (hello, have or admitted, after its own hello) is attached to the SAME in-flight fetch with `addSocket(peer.socket)`, so a working peer that arrives after a lying or empty advertiser can still supply block 0 before the deadline (the advertisement still counts as a new one for the retry rule below).

(c) Outcomes:
- `r.error === 'timeout'` -> K stays pending, `errorsSoft.push('bloco 0 indisponível: ' + key8)`; no message is sent and nothing is purged (nothing was stored). In `--once` mode a new fetch starts only when a new advertisement of K arrives and time remains; in long-running mode also every `GATE_RETRY_MS = 15000` while some connected peer still advertises K >= 1.
- A non-null verdict reason -> K FAILED: `skipped.push({ key: K, reason })`, `onEvent({ event: 'skipped', key: K, reason })`, broadcast `rejected { key: K, reason }` (R5.1 a). K is excluded from `hello.have`, from every goal and from `downloaded`.
- `null` -> K passes the REMOTE gate: `core = await openReplica(store, K)` (the main store now creates it; block 0 is re-downloaded from the connected advertiser(s)), `watchFork`, live download, `watchContiguous`. If the run started ending (deadline, abort, completion) or K left `pending` while that `openReplica` was in flight, the replica is closed and PURGED (review item 8: the main store already holds the core, and corestore serves stored cores); the purge is tracked like every other (the result waits for it), and a purge failure follows the purge-failure rule of (e) (`ok: false` with `falha ao limpar diário rejeitado: <key8>` while the result is not built yet; after it, a warning `aviso: falha ao limpar diário <key8>` through `log`, and the store is still closed only after the purge settled). Otherwise K is then in state `regate` (below) until block 0 arrives in the main store and passes the LOCAL gate; only then is it ACTIVE: `have` broadcast with `contiguousLength`, `onEvent({ event: 'downloaded', key: K, length })`, `downloaded[K] = core.contiguousLength`.

(d) `skipped` reasons are exactly `malformed | member-mismatch | untrusted-association | bad-signature | not-in-log | fork | quota` (never `timeout`).

(f) Log quota (S3): once a replica is open in the main store (`regate` or `active`), its signed `length` and `byteLength` advance on the upgrade proof (hypercore emits `'append'` before the blocks arrive); on every `'append'`, on every growth and once at open, `core.length > MAX_LOG_BLOCKS || core.byteLength > MAX_LOG_BYTES` fails the follow with reason `quota`: the download range is destroyed, `rejected { key, reason: 'quota' }` is broadcast, K is `skipped`. Chosen outcome: an ACTIVE replica keeps the blocks already verified (no purge; the next run re-gates it at startup, hits the quota again and skips it again, so the data dir never downloads past the limit), a replica still in `regate` holds nothing verified and is purged. `runSync` takes `maxLogBlocks` / `maxLogBytes` (tests only).

(e) A purge throw inside `quarantineGet0` or `purgeReplica` during sync is fatal for the run: `ok: false`, `errors: ['falha ao limpar diário rejeitado: ' + key8]`, then the usual cleanup.

### Follow entry states (as built)

- `pending`: nothing stored; advertised with length 0; the remote gate runs when a peer advertises K with length >= 1.
- `regate`: the remote gate passed and the replica is open in the main store, but block 0 has not yet arrived there and passed the LOCAL gate; still advertised with length 0, absent from `downloaded`, G1 unmet (`'<K>:0/<theirs>'`). On the first growth of `contiguousLength` (or at once if block 0 is already there) the local gate runs (`core.get(0, { wait: false, raw: true })` + the verdict). Pass -> `active`. Fail -> the advertiser served a different block 0 to the main store than to the quarantine: the run records the HARD error `'bloco 0 divergente: <key8> (<reason>)'` (a local-gate throw counts as `not-in-log`), K is skipped with that reason (`skipped`, `onEvent skipped`, broadcast `rejected { key: K, reason }`) and purged; a hard error makes the result `ok: false` with that string in `errors` (first) even when every goal holds, without ending a long-running run.
- `active`: local gate passed; live download, advertised with `contiguousLength`, listed in `downloaded`.
- `failing`: gate failed or fork: its close + purge is in flight; excluded from goals and from `downloaded`, but `--once` completion (and the timeout result) waits until the purge settles, so the result reflects it.
- `failed`: skipped; excluded from every goal.

### One deadline (`--once`, review item 7)

`deadline = Date.now() + timeoutMs` is computed ONCE, when `runSync` is entered, before any startup I/O (store, diary, quarantine, the follow gate and its purges, the join). Both the completion timer (armed after the stores are open, with the REMAINING time `max(0, deadline - Date.now())`) and every gate fetch use that same deadline, so a slow startup never extends the run beyond `timeoutMs` (plus the time to settle in-flight purges and shut down).

### Startup interruption

In `--once` mode the deadline, and in both modes a `signal` abort, interrupt network startup: `joinAndFlush(swarm, topics)` is raced against the run's completion, so a stalled DHT join (unreachable bootstrap) never delays the result. When the deadline or the abort wins, the run finishes with the timeout result (`--once`: `['sem pares']` when nobody sent hello) or the abort result (long-running: `ok: true`), the swarm is destroyed in the `finally`, and the stores are closed as usual.

The `feed` command keeps its own gate (defense in depth).

### End-of-run purges (security fix cycle 2)

- The startup purge of a follow whose stored replica is empty or fails the startup gate is tracked like the runtime purges: an abort or deadline while it is pending waits for it, and a failure makes the result `ok: false` with `'falha ao limpar diário rejeitado: ' + key8`.
- When the run ends (success, timeout, abort or failure), every replica still in `regate` (opened in the main store after the quarantine gate, block 0 not yet through the local gate in this run) is closed and purged before the result is built; the purge is tracked, so the main store closes only after it settles. The key is reported as pending (unadvertised or unmet), not skipped; a purge failure makes the result `ok: false` (after the result exists, a failure in the `finally` path is only logged).

### Forks on followed keys (R5.9 d)

`onFork` for an ACTIVE K -> destroy its range, broadcast `rejected { key: K, reason: 'fork' }`, `purgeReplica`, remove K from the inventory and from `downloaded`, `skipped.push({ key: K, reason: 'fork' })` + `onEvent({ event: 'skipped', key: K, reason: 'fork' })`. At startup a forked replica is handled by (a).

### Connections and tracking

Join the topics of section 4. On each connection: replicate, `attachAdmission(role 'member', have = the member inventory of section 5: own diary length + active replicas' contiguousLengths + pending follows with length 0)`, then if `cert`: send `announce { key: own, cert }` once. Track per peer: `peerKey` (lowercase hex of `socket.remotePublicKey`, the Noise-authenticated static key), `remoteRole`, `remoteCert`, `verifiedSeeder`, `remoteCount`, `inventoryComplete`, `remoteHave` (latest-wins, section 5, R5.1 b), `admittedOwn`, `rejectedOwn` reason. Watch every core's `contiguousLength`: send `have` to all peers on growth and re-evaluate.

Verified seeders (R5.3 c): when a hello arrives, `peer.verifiedSeeder = peer.remoteRole === 'seeder' && seederCertForKey(peer.remoteCert, peer.peerKey, association).ok`, with `association` the member's fixed trust root. A peer claiming `'seeder'` that is not verified is treated exactly like a member for `peers`, G1 and G3, is excluded from `seeders`, its `admitted` for the own key is ignored and its `rejected` is a withdrawal only.

Withdrawals (R5.1 d): `admitted`/`rejected` for the own key count ONLY from verified seeders. A `rejected` for the own key from any other peer is only a withdrawal: `onEvent({ event: 'withdrawn', key, peerKey, reason })`, stdout line `withdrawn <key> <peerKey8> <reason>`, no effect on `ok` (its `remoteHave` entry is already deleted, R5.1 b).

Events: `{ event: 'peer', role, peerKey, verified }` (`verified` = `peer.verifiedSeeder`; `false` for members).

A peer that disconnects (`onclose`) is removed from `peers` and from every goal at once.

After flush + `done()`: grace = wait up to 5000 ms for `hello` from every currently connected peer; `peers` = connected peers that sent `hello`; `seeders` = number of connected verified seeders (R5.3 d). Goal evaluation waits for `inventoryComplete` of every peer that sent `hello` (R4.4).

### Goals (R4.6, R5.1, R5.3, R5.8)

`theirs(P, K)` = `P.remoteHave.get(K)` (absent = not advertised; the LATEST advertisement, never a max); `theirs(K)` = max of `theirs(P, K)` over connected, inventory-complete peers that currently hold K (used to start gates and to report `unadvertised`).

Unverified-peer budget (S2, security fix cycle 2 H1; `lib/sync.js`, `UNVERIFIED_BUDGET_MS = 5000`, injectable as `unverifiedBudgetMs`): ONE budget per `--once` run for every peer that is not a verified seeder, started at the first hello of such a peer. There are no per-peer clocks: new identities, reconnects or progress never restart it.

- While it runs, an unverified peer counts as before: its claim above `core.length` raises the G1 target of an ACTIVE follow, its advertisement of our diary below `diary.length` keeps G3 unmet, and its incomplete inventory makes `--once` wait.
- Once it expires, for the rest of the run, unverified peers' claims (G1), interest (G3) and incomplete inventories no longer affect the goals. The G1 target of an active follow is then max(`core.length`, lengths advertised by verified seeders); `core.length` is the signed length, authenticated by the author's signature through replication. Each outstanding or later claim above `core.length` emits `claim-ignored { key, peerKey, length }` once per peer and key; each unverified peer below `diary.length` emits `peer-ignored { peerKey }` once.
- Verified seeders are never subject to the budget (a verified seeder that has not admitted the diary still counts for G3). PENDING and REGATE follows are unchanged: they stay bounded by the deadline, so a slow first-time follow is never declared done with nothing downloaded.
- Direct A<->B (no seeder): the signed `core.length` still drives B's G1, and A waits for B's full length only within the budget.
- Claim bookkeeping (H2): claims are kept only in `--once` mode while the budget runs, at most `MAX_CONNECTIONS` per follow; they are deleted when the claiming peer disconnects (unless the same remote key still has another live connection) or when `core.length` reaches them, and cleared when the budget expires. Long-running sync records none.
- `seederConfirmed` (SyncResult): true only when at least one verified seeder admitted our diary and advertises its full length (G2 met with a seeder). It can be false with `ok: true`, e.g. when the only peers are unverified and one self-reports our full length (a self-reported length is never proof of storage); the CLI then prints `sync done (sem confirmação de semeador)`.
- `admitted` / `rejected` from a seeder that is not verified change no goal (an unverified `rejected` for the own key is still a withdrawal, below).

- (G1) For every followed key K:
  - Gate failed -> excluded (listed in `skipped`).
  - Gate pending (R4.6, R5.8 d) -> unmet while some inventory-complete peer advertises K with length >= 1 (until the gate settles: pass -> `ours(K) >= theirs(K)`; fail -> skipped). At the `--once` deadline such a K appears in `errors` as `'tempo esgotado: <K>:0/<theirs>'` and is NOT listed in `skipped`. If no peer advertises K with length >= 1, K is listed in `unadvertised` and does not block.
  - Gate passed (ACTIVE) -> `ours(K)` = replica `contiguousLength` >= `theirs(K)` (0 when nobody advertised; such keys are listed in `result.unadvertised`).
- (G2) Own diary, only when the own genesis cert is valid and `seeders >= 1` (verified seeders only): met when at least one verified seeder sent `admitted` for the own key AND that seeder's `theirs(own) >= diary.length`.
  - A `rejected` with reason `'timeout'` from a verified seeder is NOT fatal: that seeder just does not count, and the event is listed in `errorsSoft` as `'rejeitado: timeout (<peerKey8>)'`.
  - Any other `rejected` reason for the own key from a verified seeder fails immediately: `ok` false, `rejected` = reason, `errors` `['rejeitado: ' + reason]`.
- (G3) Own diary to interested peers (R3 d, R4.6, R5.1 c), in `--once` mode: P is interested in the own key iff `P.remoteHave.has(own)` (any length, including 0) or P is a verified seeder that sent `admitted` for it; for every connected interested P require `theirs(P, own) >= diary.length` before resolving. A withdrawal or a disconnect removes P from G3 immediately; the author's `--once` therefore never waits on a follower whose gate failed. A peer that is not interested imposes nothing. With G3 (and R4.5 interest advertising) a direct two-member sync is deterministic: a first-time follower advertises the author's key with length 0 while its gate is pending, so the author waits until the follower advertises the full length.

Re-evaluate after every message, every growth event, every gate outcome, every disconnect, every `inventoryComplete` change and the grace timer.

Pending follows and fetch timeouts (security fix cycle 3):

- A PENDING follow K is unmet only while (a) a block-0 fetch for K is in flight, (b) a verified seeder advertises K at length >= 1, or (c) an unverified peer advertises K at length >= 1 while the unverified budget runs and no fetch that included that peer's socket has failed for K in this run. Once a fetch for K fails before the deadline, the unverified peers whose sockets were in it no longer hold K (K is reported in `unadvertised`), and in `--once` mode they are not asked again for K; a different advertiser still triggers a new fetch.
- In `--once` mode a block-0 fetch lasts `min(GATE_TIMEOUT_MS, time left before the deadline)`; a fetch cut by the deadline keeps K unmet (`tempo esgotado`). An honest first-time fetch slower than `GATE_TIMEOUT_MS` (15 s) is therefore reported in `unadvertised` and the run can end `ok` without that key.
- A pending key whose last fetch was cut by the deadline stays unmet whatever the unverified budget (`tempo esgotado`), and a follow still in `regate` when the run ends is unmet (`tempo esgotado`) and then purged.
- Failed advertisers are tracked only in `--once` mode and only while their connection is open (removed on close); a fetch includes at most `MAX_CONNECTIONS` sockets.
- Quota at the member gate: the quarantine fetch's signed `length` / `byteLength` are checked against the log quota before the replica is opened in the main store (skipped with `quota`, nothing stored), the same order as the seeder's gate.
- `unadvertised` lists pending follows that no peer still holds (failed advertisers excluded) and active follows that nobody advertises or that are advertised only at length 0.
- Startup reads only block 0 of our diary (not the whole log) to find the genesis certificate.
- Re-discovery: a connection on a diary topic keeps rediscovery off only while its peer has not sent hello yet, is a verified seeder, or advertises the key at length >= 1; the rendezvous topic still counts any live connection.
- Residual: an attacker who reconnects with a fresh socket every gate timeout can keep condition (a) true until the deadline (`tempo esgotado`), bounded by the connection cap and the gate timeout.

### `--once` SyncResult

```json
{
  "ok": true,
  "peers": 1,
  "seeders": 1,
  "admitted": true,
  "rejected": null,
  "downloaded": { "<hex64>": 3 },
  "unadvertised": [],
  "skipped": [],
  "errors": [],
  "errorsSoft": []
}
```

Shape: `{ ok, peers, seeders, admitted: boolean, rejected: null | reason, downloaded: { hex64: contiguousLength }, unadvertised: [hex64], skipped: [{ key, reason }], errors: [string], errorsSoft: [string] }`. `seeders` = connected verified seeders; `admitted` = a verified seeder sent `admitted` for the own key (R5.3 d). `skipped` and `errorsSoft` are `[]` by default; the long-running mode reports them too (R3 d). `errorsSoft` entries are `'rejeitado: timeout (<peerKey8>)'` (verified seeder timeout) and `'bloco 0 indisponível: <key8>'` (follow-gate fetch timeout, R5.8 c).

- `ok` true when `peers >= 1` and G1, G2 and G3 hold.
- If no peer has sent `hello` by the timeout -> `ok` false, `errors` `['sem pares']`.
- Timeout (default 30000 ms) -> `ok` false, `errors` `['tempo esgotado: ' + unmet goals as '<key>:<ours>/<theirs>' joined by ', ']`.
- Purge failure -> `ok` false, `errors` `['falha ao limpar diário rejeitado: ' + key8]` (R5.8 e).
- A failed local re-gate (follow entry states above) -> `ok` false, `errors` starting with `'bloco 0 divergente: ' + key8 + ' (' + reason + ')'`, K in `skipped` with that reason.
- Without `--once`: run until SIGINT/SIGTERM or signal abort, resolving `{ ok: true, ... }` (`ok: false` only after a purge failure or a hard error such as `bloco 0 divergente`).
- ALWAYS, before resolving: clear timers, destroy download ranges and the swarm, close the quarantine store and remove its directory (after every in-flight fetch settled), wait for every pending purge, and close the main store LAST (it releases the data-dir lock; the shutdown order above).
- TODO(phase1): push notifications when a followed log grows.

## 7. CLI (single bin: `node bin/varanda.js <command> [sub] [flags]`)

### Global flags

`--data <dir>` (`VARANDA_DATA`, default `./data`), `--association <hex64>` (`VARANDA_ASSOCIATION`), `--bootstrap <host:port>` (repeatable; `VARANDA_BOOTSTRAP` comma-separated), `--dht-host <ip>` (`VARANDA_DHT_HOST`; a non-empty string without whitespace, else UsageError `dht-host inválido`; passed as `host` to `runSync` and `Seeder`, R5.11), `--json`, `--help` / `-h`. Only `--flag value` syntax; booleans: `--json`, `--once`, `--help`, `-h`.

String command flags include `--seeder` (hex64 any case -> lowercase, else UsageError `chave inválida`). `flags` keys include `seeder` and `dhtHost` (R5.12).

### Help (R5.12, exact)

`HELP` is exactly:

```
varanda — protótipo de rede social P2P (fase 0)
Uso: node bin/varanda.js <comando> [subcomando] [opções]
Comandos:
  assoc init|show|certify    chave da associação de teste e certificados de membro
  assoc certify-seeder       certifica a chave de um semeador (--seeder)
  id create|show             identidade (chave pública do diário)
  cert add                   grava o certificado como bloco 0 do diário
  profile set                define nome e bio
  post                       publica um texto (--text)
  reply                      responde a uma publicação (--to <chave>:<seq> --text)
  follow|unfollow|follows    segue ou deixa de seguir uma chave pública
  log                        mostra os blocos locais de um diário
  feed                       feed com as publicações dos diários seguidos
  sync                       sincroniza com pares e com o semeador (--once, --timeout-ms)
  seed                       semeador sempre ligado
  seed key|cert add          chave do semeador e seu certificado (--cert-file)
  help                       esta ajuda
Opções globais:
  --data <dir>               diretório de dados (ou VARANDA_DATA, padrão ./data)
  --association <hex>        chave pública da associação (ou VARANDA_ASSOCIATION)
  --bootstrap <host:porta>   repetível (ou VARANDA_BOOTSTRAP, separado por vírgula)
  --dht-host <ip>            endereço local da DHT (ou VARANDA_DHT_HOST)
  --json                     saída JSON na última linha
Opções dos comandos:
  --member --seeder --age-band --method --out --cert-file --name --bio --text
  --to --author --limit --once --timeout-ms
```

### Exit codes and output

- Exit codes: 0 ok; 1 failure (`erro: <mensagem>` on stderr); 2 usage error: a flag parse error prints `uso: <mensagem>` followed by the full `HELP` text on stderr, a `UsageError` thrown by a command prints `uso: <mensagem>` alone, and an unknown command prints `erro: comando desconhecido: <comando>` (all exit 2; `bin/varanda.js`). No command, `help`, `--help` or `-h` prints `HELP` on stdout and exits 0.
- Human output and help in pt-BR; `--json` prints exactly one JSON object as the LAST stdout line (`sync`/`seed`: one JSON event per line, result last).
- Never print secret keys (`seed key` never prints the seeder's secret key).

### Terminal output safety (security fix cycle 2)

- Peer- or log-derived strings in human lines go through `safe()` (`lib/safe.js`); every JSON line the CLI prints (`--json` results and events, `log` block lines) is produced by `jsonLine()`, which stays valid JSON and parses back to the same value.
- `feed` wraps by display columns: at `process.stdout.columns` on a TTY and at 80 otherwise (floor 20; `--json` is never wrapped). The width measure over-estimates: every code point >= U+1100 counts 2 columns except U+2000-U+206F (general punctuation) and U+20A0-U+20CF (currency), which count 1; everything below U+1100 counts 1 (residual: East Asian "ambiguous" characters count 1, so a terminal configured to draw them wide can under-measure). The header line wraps too; every row after an item's first is indented by two spaces, so no post or name can place a forged `[date] name (key8) #seq` header at column 0.
- The human feed header always keeps `(key8) #seq` and the reply marker on its first row: the author name is truncated by display width and marked with `…` so the whole header fits the width; when even the fixed parts exceed the width, row 1 is `[at] (key8) #seq` plus the reply marker and the name goes on its own indented row. A padded profile name therefore cannot forge a suffix and push the real one onto an indented row. Known limits (phase 0): below about 40 columns (about 54 with a reply) `(key8) #seq` or the reply marker itself wraps onto an indented second row; the truncation mark `…` is East Asian Ambiguous and counted 1 column, so on a terminal drawing ambiguous characters wide a truncated header can overflow by one column.
- `feed` skips the own key and every `follows.json` entry that is not 64 hex characters (normalised to lowercase, deduped), warns once per bad entry on stderr (`aviso: entrada inválida em follows.json ignorada (...)`), and never purges the diary.
- `log --author <hex>` refuses a key with no local data (exit 1, `erro: sem dados locais para este diário`) and creates no core.
- `id create` publishes `config.json` durably: temp file opened `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` (mode `0o600`), fsync, hard link into place, then fsync of the directory; the temp file is always unlinked.
- `seed` installs its SIGINT/SIGTERM handlers before startup; a signal during startup closes the seeder once `start()` settles.
- `sync` prints `sync done (sem confirmação de semeador)` when `ok` is true and `seederConfirmed` is false.

### Router shutdown hardening (R3 e)

After `run()` resolves or throws, `bin/varanda.js` sets `process.exitCode` and arms `setTimeout(() => process.exit(process.exitCode), 2000).unref()`, so a lingering socket or timer cannot keep `seed` or `sync` alive after their `close()` (the unref'd timer never delays a clean exit).

### Commands and `--json` results

- `assoc init` -> `{ publicKey }` (error if `association.json` exists).
- `assoc show` -> `{ publicKey }`.
- `assoc certify --member <hex64> [--age-band 18+] [--method stub] [--out <file>]` -> the Certificate object (with `--out`: written as pretty JSON + newline and the result is `{ out, cert }`); appends the `members.jsonl` line.
- `assoc certify-seeder --seeder <hex64> [--out <file>]` -> the SeederCertificate (with `--out`: written as pretty JSON + LF, result `{ out, cert }`, stdout `certificado do semeador gravado em <out>`); appends the `seeders.jsonl` line; USAGE `informe --seeder <hex>` when the flag is missing.
- `id create` (first run requires `--association`/`VARANDA_ASSOCIATION`; writes `config.json`; idempotent, same key on every run; a different association on a later run is an error) -> `{ publicKey, association }`.
- `id show` -> same (error `identidade não encontrada` when `config.json` is missing).
- `cert add --cert-file <file>` -> `{ seq: 0 }` (checks `cert.member === own key` and `certForKey` ok against the trust root; if block 0 already holds an identical cert -> ok without append; any other existing block 0 -> error `certificado já gravado`).
- `profile set --name <s> [--bio <s>]` -> `{ seq }`; `post --text <s>` -> `{ seq, ref }`; `reply --to <hex64:seq> --text <s>` -> `{ seq, ref }` (`seq` in `--to` must be >= 1); all three require block 0 (`grave o certificado de membro antes de publicar`).
- `follow --author <hex64>` -> `{ follows, changed }`; `unfollow --author <hex64>` -> `{ follows, changed }`; `follows` -> `{ follows }`. Following yourself is an error. Following a new key when `follows.json` already holds `MAX_INVENTORY - 1` (4095) keys is an error: `erro: limite de diários seguidos atingido`, exit 1 (section 5 limits).
- `log [--author <hex64>]` -> `{ key, entries: [{ seq, record }] }` from local blocks only (no network; read through `readAll`, R4.1).
- `feed [--limit n]` -> `{ items: [FeedItem], skipped: [{ key, reason }], future: ['<hex64>:<seq>', ...] }`; own diary never gated; a followed replica is kept only if its block 0 is a valid member-cert for the trust root with `cert.member === key` and `core.fork === 0` (reasons: `no-cert` | `not-in-log` | `member-mismatch` | `untrusted-association` | `bad-signature` | `malformed` | `fork`); stderr `aviso: diário <key8> ignorado (<reason>)` (a forked replica: `aviso: diário <key8> ignorado (fork)`; it is read-only here and the next sync purges it, R5.9 e). Per future reference (R5.10), stderr `aviso: publicação <ref> ignorada (future)`. No network.
- `sync [--once] [--timeout-ms n]` -> stdout lines `sync ready`, `peer member <peerKey8>`, `peer seeder <peerKey8>` (verified) or `peer seeder <peerKey8> não verificado`, `admitted <key> <length>`, `rejected <key> <reason>`, `withdrawn <key> <peerKey8> <reason>`, `have <key> <length>`, `downloaded <key> <length>`, then `sync done` or `sync failed: <errors joined by ; >`; with `--json` one `{ event, ... }` object per line and the SyncResult last (including `{ event: 'peer', role, peerKey, verified }`, `{ event: 'withdrawn', key, peerKey, reason }` and `{ event: 'skipped', key, reason }` events). Exit 0 iff `ok`.
- `seed key` -> `{ publicKey }`, stdout `chave do semeador: <hex64>`; creates `seeder-key.json` when missing, otherwise idempotent (same key). Never prints the secret key.
- `seed cert add --cert-file <file>` -> `{ seeder }`, stdout `certificado do semeador gravado`; parses the file, requires `seeder-key.json` (error `chave do semeador não encontrada (use seed key)`), checks `seederCertForKey(cert, ownNoiseHex, trustRoot)` (error `certificado do semeador inválido (<reason>)`), writes `seeder-cert.json`; USAGE `informe --cert-file <arquivo>` when missing.
- `seed` (run) -> loads both files before any network activity: missing key -> `Error('chave do semeador não encontrada (use seed key)')`; missing cert -> `Error('certificado do semeador não encontrado (use seed cert add)')`; cert failing `seederCertForKey(cert, ownNoiseHex, trustRoot)` -> `Error('certificado do semeador inválido (<reason>)')` (all exit 1). Stdout lines `seed ready`, `peer <role> <peerKey8>`, `admitted <key> <length>`, `rejected <key> <reason>`, `have <key> <length>`; `--json`, one per line: `{ event: 'ready', topic, admitted }` | `{ event: 'peer', role, peerKey }` (unchanged: seeders do not verify members) | `{ event: 'admitted', key, length }` | `{ event: 'rejected', key, reason }` | `{ event: 'have', key, length }` | `{ event: 'fatal', key, reason: 'purge-failed' }` (section 5). Runs until SIGINT/SIGTERM, then exits 0.
- `seed key`, `seed cert add` and `seed` share `Seeder.ensureConfig(dataDir, associationKey)`: an existing `config.json` must have `role === 'seeder'` (else `diretório não é de um semeador`) and must match `--association` when given (else `associação diferente da configurada`); when missing, `--association`/`VARANDA_ASSOCIATION` is required (USAGE `informe --association ou VARANDA_ASSOCIATION`) and `config.json = { "v": 1, "role": "seeder", "association" }` is written. So the first of these three commands fixes the seeder's trust root.
- Any other `seed` subcommand -> USAGE `uso: node bin/varanda.js seed [key|cert add]`.

### FeedItem

`FeedItem = { author: hex64, name: string | null, seq, at, text, replyTo: null | { author, seq } }`, ascending by `(at, author, seq)`; future-dated posts (R5.10) are excluded before `--limit` applies; `--limit` keeps the LAST n. `key8` = first 8 hex chars.

## 8. Module map and exports

- `lib/cert.js`: `isHex(str, bytes)`, `normalizeHex(str)`, `certPayload(cert)` -> Buffer, `createCert({ member, ageBand = '18+', method = 'stub', date = new Date().toISOString() }, associationKeyPair)` -> Certificate, `validateCertShape(cert)` -> `null | 'malformed'`, `verifyCert(cert, associationHex)` -> `{ ok, reason }`, `certForKey(cert, keyHex, associationHex)` -> `{ ok, reason }`, `generateAssociationKeyPair()`, `refuseSymlinkDir(dir)` (throws `Error('diretório é um link simbólico')` when `dir` is a symlink; a missing dir is fine), `saveKeyPairFile(file, kp, { overwrite = false })` (writes through a unique temp name `.<base>.<12 random bytes hex>.tmp` opened with `'wx'` and mode `0o600`, fsynced; without `overwrite` the publish is a hard `link` to `file`, which fails with `EEXIST` when it exists, so an existing key is never clobbered; with `overwrite: true` a rename; the temp name is always unlinked and the directory fsynced; parent dir `0o700`, refused when a symlink), `loadKeyPairFile(file)` -> `{ publicKey, secretKey }` Buffers (throws `Error('arquivo de chave inválido')` on bad shape), `saveAssociationKeyPair(file, kp)` / `loadAssociationKeyPair(file)` (wrappers over the two above; the association loader keeps its message `chave da associação inválida`), `seederCertPayload(cert)` -> Buffer, `createSeederCert({ seeder, date }, associationKeyPair)` -> SeederCertificate, `validateSeederCertShape(cert)` -> `null | 'malformed'`, `verifySeederCert(cert, associationHex)` -> `{ ok, reason }`, `seederCertForKey(cert, noiseHex, associationHex)` -> `{ ok, reason }` (section 3). `validateCertShape`, `verifyCert`, `certForKey` and the four seeder-cert functions never throw (R4.3).
- `lib/assoc.js`: `initAssociation(dir)` -> `{ publicKey }`, `showAssociation(dir)` -> `{ publicKey }`, `issueCertificate(dir, { member, ageBand, method })` -> Certificate, `issueSeederCertificate(dir, { seeder })` -> SeederCertificate (appends ONE `{ "seeder": hex64, "date": ISO }` line + LF to `<dir>/seeders.jsonl`).
- `lib/records.js`: `MAX_NAME`, `MAX_BIO`, `MAX_TEXT`, `MAX_BLOCK_BYTES = 16384`, `MAX_LOG_BLOCKS = 100000`, `MAX_LOG_BYTES = 67108864` (S3), `validRecordCopy(record, seq)` -> plain-data copy of a valid record (`structuredClone`, validated on the copy, never throws) or `null`, `nowIso()`, `isHex64(s)`, `isCanonicalIso(s)` -> boolean (R4.3, never throws), `decodeBlock(buf)` -> plain object | `null` (R4.1), `memberCertRecord(cert)`, `profileRecord({ name, bio, at })`, `postRecord({ text, replyTo, at })`, `validateRecord(record, seq)` -> `null | reason` (`validateRecord(null, seq)` returns `'malformed'`; never throws, R4.3), `parseRef(str)` -> `{ author, seq } | null`, `formatRef({ author, seq })`, `latestProfile(entries)` -> `{ name, bio } | null`, `genesisCert(entries)` -> `cert | null`; `entries` = `[{ seq, record }]`.
- `lib/feed.js`: `MAX_FUTURE_MS = 86400000`, `buildFeed({ logs: [{ key, entries }], limit = Infinity, now = Date.now() })` -> `{ items: FeedItem[], future: ['<hex64>:<seq>', ...] }` (a valid post whose `Date.parse(at) - now > MAX_FUTURE_MS` is excluded from `items` and its `formatRef` reference is appended to `future`, ascending by author then seq; `limit` applies after the exclusion; `now` is injectable for tests), `shortKey(hex)` -> first 8 chars, `formatFeedItem(item)` -> string.
- `lib/store.js`: `openStore(dataDir)` -> Corestore (takes the `<dataDir>/.varanda-lock` data-dir lock first, section 1: `Error('diretório de dados em uso')` with `code 'LOCKED'` when another live process holds it, `LOCK_INVALID` / `STORE_INVALID` for a non-directory lock path or a symlinked `store/`; released once, by token, on a successful `store.close()` and on process exit), `storeExists(dataDir)`, `openDiary(store)` -> core, `openReplica(store, hex)` -> core, `openQuarantine(dataDir)` -> Corestore (`fs.rmSync(path.join(dataDir, 'quarantine'), { recursive: true, force: true })`, then `new Corestore(path.join(dataDir, 'quarantine'))` awaited ready), `removeQuarantine(dataDir)` (sync `rmSync`, called after `qstore.close()` on shutdown, best effort), `purgeReplica(store, hex)` (`const c = store.get({ key: b4a.from(hex, 'hex') }); await c.ready(); await c.purge()` — a fresh session, so it also works after hypercore closed the key's sessions on a conflict), `readAll(core)` -> `[{ seq, record }]` (R4.1: reads every block `0..core.contiguousLength-1` with `core.get(i, { wait: false, raw: true })` + `decodeBlock`; a `null` result becomes `{ seq: i, record: null }`; never throws `DECODING_ERROR`, never stops early), `appendRecord(core, record, limits?)` -> seq (throws `Error('limite do diário atingido')` when the encoded block exceeds `MAX_BLOCK_BYTES`, the diary already holds `MAX_LOG_BLOCKS` blocks, or `byteLength` + block would exceed `MAX_LOG_BYTES`; `limits` overrides them for tests), `readConfig(dataDir)` -> object | null, `writeConfig(dataDir, config)`, `readFollows(dataDir)` -> `string[]`, `writeFollows(dataDir, list)`, `readJson(file, fallback)`, `writeJsonAtomic(file, obj, mode)` (unique `.<base>.<pid>.<random>.tmp` in the same directory opened `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` with `mode`, fsync, rename over `file`, then fsync of the parent directory (only EISDIR/EPERM/EINVAL ignored), temp unlinked on failure; section 1 "Files and replicas").
- `lib/net.js`:
  - `topicFor(associationHex)` -> Buffer, `parseBootstrap(value)` -> `undefined | string[]`, `generateNoiseKeyPair()` -> `require('hyperdht').keyPair()`, `createSwarm({ bootstrap, keyPair, host } = {})` -> Hyperswarm (section 4, R5.11; `firewalled: false` only for a loopback `host`), `joinAndFlush(swarm, topics)` -> Promise, `startRediscovery(swarm, topics, { intervalMs = 1000, hasPeer = () => false, log })` -> `stop()` (section 4; `TypeError` unless every topic is a 32-byte buffer).
  - `attachAdmission(socket, { role, cert = null, have, onmessage, onclose, oninventory, log })` -> `Peer { peerKey, socket, role, remoteRole, remoteCert, remoteCount, remoteHave (Map, latest-wins), inventoryComplete, badMessages, opened (Promise<boolean>), hello (Promise<hello | null>), send(msg) -> boolean, close() }`: sends `hello` with `count`, at most 100 `have` entries and, when `role === 'seeder'`, `cert` (throws `TypeError('seeder role requires cert')` when `cert` is not a plain object), then the overflow as `have` messages (R4.4); `remoteCert` = the hello's `cert` or `null`; `socket` = the hyperswarm socket it was attached to; `remoteHave` follows R5.1 b (hello replaces, `have`/`admitted` set, `rejected` deletes before `onmessage`); a valid `hello` is dispatched to `onmessage` BEFORE its inventory completion check, so `oninventory` sees the caller's state updated from that hello (section 5 "Bounded inventory"); `opened`/`hello` settle `false`/`null` when the channel closes first (section 5) and never reject.
  - `validateMessage(msg)` -> boolean (rejects a `hello` with more than 100 `have` entries, `count < have.length`, `count > MAX_INVENTORY`, a seeder `hello` without a plain-object `cert` or a member `hello` with one, any `length > MAX_LOG_BLOCKS`, and a `rejected.reason` not matching `/^[a-z0-9-]{1,64}$/`).
  - Limits (S1, S6): `MAX_INVENTORY = 4096`, `MAX_BAD_MESSAGES = 16`, `HELLO_TIMEOUT_MS = 10000`, `MAX_CONNECTIONS = 64`; `attachAdmission` also takes `helloTimeoutMs` and drops the peer (`{ event: 'peer-dropped', peerKey, reason }` through `log`, then `socket.destroy()`) for `inventory-limit`, `bad-messages`, `hello-timeout` and `duplicate-hello`; `refuseOverConnectionLimit(swarm, socket, { limit = MAX_CONNECTIONS, log })` -> boolean (section 5 "Per-connection limits").
  - `watchContiguous(core, onGrow)` -> `stop()`.
  - `watchFork(core, onFork)` -> `stop()`: listens to `'truncate'` and `'conflict'` on the session; calls `onFork('fork')` at most once; returns a remover (R5.9 b).
  - `startQuarantineFetch(qstore, keyHex, sockets, timeoutMs)` -> `{ promise, addSocket }`: `core = qstore.get({ key: b4a.from(keyHex, 'hex') })`; `promise` resolves `{ raw: Buffer | null, error: null | 'timeout', length, byteLength }` (`length`/`byteLength` = the quarantine core's signed length and byteLength after the fetch, from the upgrade proof that came with block 0; `0` on timeout; the seeder's quota gate, S3): `await core.ready()`; `core.replicate(s)` for every initial socket; `raw = await core.get(0, { raw: true, timeout: timeoutMs })` inside try/catch — any throw (REQUEST_TIMEOUT or other) gives `{ raw: null, error: 'timeout' }`; a `null` block (cannot happen with wait true, kept for safety) also gives `'timeout'`; FINALLY `await core.purge()` always runs (whatever the outcome) and a purge throw propagates to the caller, who treats it as a fatal purge failure (R5.5 e, R5.8 e). `addSocket(socket)` -> boolean attaches one more peer to the same quarantine core while the fetch is in flight (`core.replicate(socket)`, which hypercore defers until the core is open and ignores for a socket already attached); it returns `false` once the fetch has settled (the core is being purged) or for a socket already added. `sockets` must be non-empty (`TypeError` otherwise) hyperswarm sockets already replicated by the main store.
  - `async quarantineGet0(qstore, keyHex, sockets, timeoutMs)` -> the `promise` of `startQuarantineFetch` with the same arguments (no late sockets; used by the seeder, whose admission is attached only to the announcer).
- `lib/seeder.js`: `class Seeder` constructed as `new Seeder({ dataDir, associationKey = null, bootstrap, host, log = () => {}, purgeHook, gateHook, admitHook })` with `start()` -> `{ topic: hex, admitted: hex64[] }` (startup order of section 5, R5.6), `close()`, `admittedKeys()`; `log(eventObject)` receives exactly the `--json` events of section 7. `purgeHook(core)`, when given, replaces `core.purge()` inside `purgeReplica` calls made by the seeder (tests only); `gateHook(key)` runs after the quarantine fetch (R5.5 c, tests only); `admitHook(key, step)` with `step` `'persist'` | `'open'` is awaited right before that step of admission (d) and a throw simulates the step failing (tests only; exercises the `admission-failed` rollback). Statics: `Seeder.createKey(dataDir)` -> `{ publicKey }`, `Seeder.addCert(dataDir, certFile, associationHex)` -> `{ seeder }`, `Seeder.ensureConfig(dataDir, associationKey)` -> `associationHex`. Admission uses the per-key promise chain, the two in-memory maps `admitted` (keys being served) and `dropping` (keys being purged, R6.1) and ONE serialized file writer `persist()` that writes the union of both maps (R4.7, R5.7, R6.1); `admittedKeys()` returns only `admitted` keys; an announce for a key in `dropping` waits on that key's per-key chain; `start()` opens the main store before the quarantine store (R6.2); `close()` closes the quarantine store, waits for in-flight admission steps, removes the quarantine directory, waits for drops in progress and closes the main store LAST (the data-dir lock is released last, section 5 "Seeder shutdown"); constant `GATE_TIMEOUT_MS = 15000`; constructor options `maxLogBlocks`, `maxLogBytes`, `maxConnections` (tests only; defaults = the constants) and the quota gate/drop (`quota`) and S7 rollback purge of section 5.
- `lib/sync.js`: `runSync({ dataDir, associationKey, bootstrap, host, once, timeoutMs, log, onEvent, signal, purgeHook, regateHook, joinHook })` -> SyncResult (includes `skipped` and `errorsSoft`); opens the main store before the quarantine store (R6.2) and closes it LAST at shutdown (section 6 "Shutdown order": quarantine closed and removed, in-flight fetches and purges settled, then `store.close()` releases the data-dir lock); a peer advertising a pending key during its quarantine fetch joins that fetch through `addSocket` (R5.8 b); constants `GATE_TIMEOUT_MS = 15000`, `GATE_MIN_TIMEOUT_MS = 250`, `GATE_RETRY_MS = 15000` (R5.8). Test-only hooks: `purgeHook(key, store)` replaces `purgeReplica` for every purge of the run, `regateHook(key)` returns a verdict that overrides the local re-gate of a replica opened after a remote pass (`null`/`undefined` = run the real gate), `joinHook(swarm, topics)` replaces `joinAndFlush` (a never-settling join exercises the startup interruption of section 6); injectable `unverifiedBudgetMs` (constant `UNVERIFIED_BUDGET_MS = 5000`, exported), `maxLogBlocks`, `maxLogBytes`, `maxConnections`; test-only `inspectHook({ claimCount })`; SyncResult carries `seederConfirmed`; extra events `claim-ignored`, `peer-ignored`, `peer-dropped` (sections 5 and 6). `lib/commands/sync.js` exports `formatEvent` and re-exports `safe` from `lib/safe.js` (S4).
- `lib/safe.js`: `safe(str)` (human lines: C0, DEL, C1, U+2028/9, U+202A-E, U+2066-9 escaped as `\u{hex}`), `jsonLine(value)` (`JSON.stringify` plus DEL, C1, U+2028/9 and bidi controls escaped as `\uXXXX`; parses back to the same value), `isUnsafe(cp)`, `cpWidth(cp)` / `displayWidth(str)` (over-estimating: >= U+1100 counts 2 except general punctuation and currency; below U+1100 counts 1). `lib/commands/member.js` exports `feedWidth(stream)`.
- `lib/cli.js`: `parseArgs(argv, env, cwd)` -> flags (keys include `seeder` and `dhtHost`), `HELP` (pt-BR, section 7), `UsageError`. `bin/varanda.js`: router loading every `lib/commands/*.js`; each exports `{ commands: { <name>: { summary, run(flags) } } }`; applies the shutdown hardening of section 7 (R3 e).
- `lib/commands/assoc.js` (`assoc`, including `certify-seeder`), `lib/commands/member.js` (`id`, `cert`, `profile`, `post`, `reply`, `follow`, `unfollow`, `follows`, `log`, `feed`), `lib/commands/sync.js` (`sync`), `lib/commands/seed.js` (`seed`, `seed key`, `seed cert add`).
- `scripts/run-tests.js`, `scripts/demo.js`, `scripts/local-dht.js`; `test/helpers/net.js` (`testnet(t)`, `tmpDir(t, prefix)`, `localSwarmOptions(bootstrap)` -> `{ bootstrap, host: '127.0.0.1' }`, `bootstrapFlags(list)` (appends `'--dht-host', '127.0.0.1'`), `until(fn, opts)`); `test/*.test.js` with brittle: every test file creates the in-process testnet through the helper; every socket is opened against its bootstrap list and binds `127.0.0.1`; no test touches the public DHT.
- Scaffold rules (R5.13, R6.4, R6.5):
  - `scripts/run-tests.js`: files run sequentially with async `spawn(process.execPath, [file], { stdio: 'inherit', detached: true })` (the child becomes a process-group leader); a timer of `Number(process.env.VARANDA_TEST_TIMEOUT_MS) || 180000` ms calls `process.kill(-child.pid, 'SIGKILL')` (falling back to `child.kill('SIGKILL')` if that throws), prints `# tempo esgotado: <file>` and counts a failure; `exit` with a signal or non-zero status counts a failure; the runner's own SIGINT/SIGTERM kills the current group the same way and exits 130/143; no `*.test.js` found (or `test/` missing) prints `# nenhum arquivo de teste` and exits 1.
  - Per-file temp root (R6.5): for each test file the runner creates `root = fs.mkdtempSync(path.join(os.tmpdir(), 'varanda-run-'))` and passes `VARANDA_TEST_TMPDIR=root` in the child's env; after the child exits for ANY reason (pass, failure, signal, timeout SIGKILL of the group) the runner removes `root` with `fs.rmSync(root, { recursive: true, force: true })`, so a SIGKILLed test (no `'exit'` handler runs) leaves nothing behind.
  - `test/helpers/net.js`: `tmpDir(t, prefix)` creates its directories under `process.env.VARANDA_TEST_TMPDIR || os.tmpdir()` and records every directory in a module-level `Set`; a single `process.once('exit', ...)` handler synchronously `fs.rmSync`s every directory still in the set (brittle's `t.timeout` path runs no teardown at all); the teardown removes the entry it cleans. The exit handler and the teardowns cover a test run alone with `node test/<file>.test.js`; the runner's per-file root covers the SIGKILL case.
  - `until()` never leaks a rejection (R6.4): when the deadline wins the race, the still-pending predicate promise gets a no-op `.catch(() => {})` before `until` rejects, so a late rejection is not unhandled.
  - `test/smoke.test.js`: the DHT case asserts `dht.io.serverSocket.address()` has `host === '127.0.0.1'` and `port > 0`.
  - `scripts/demo.js` (`npm run demo`): non-interactive, an in-process `hyperdht/testnet(3)` bound to 127.0.0.1 (`VARANDA_BOOTSTRAP` + `VARANDA_DHT_HOST=127.0.0.1` in every child's env; the public DHT is never contacted), every command run through `bin/varanda.js` as a child process: two associations, identities A and B, member certificates as block 0, the seeder's key and certificate (`seed key`, `assoc certify-seeder`, `seed cert add`), profile and follow, the seeder started and awaited on `seed ready`, A publishes and `sync --once` (admitted), the seeder is restarted from disk (SIGTERM, exit 0, new process), B receives A's post through the seeder with A offline, B replies and A reads it, a certificate of another association and a seeder without certificate are refused, shutdown. Prints `DEMO OK` and exits 0; on the first failure prints `DEMO FALHOU: <passo>` plus the child's output and exits 1; a 150 s watchdog; `--keep` / `VARANDA_DEMO_KEEP=1` keeps the data directory. After `main()` settles (either way) it arms `setTimeout(() => process.exit(process.exitCode), 2000).unref()` so a referenced DHT timer can never keep the process alive.

### Residual risks (phase 0)

- Open review items after the final fix batch (deferred, not security-high): a deadline-bound fetch whose advertisers all left still marks the key `cutByDeadline`, so `--once` can end `tempo esgotado` with nobody advertising it (a false failure); a fetch's socket cap counts sockets that already closed; at the follow limit a burst of non-mergeable `rejected` sends can exceed `MAX_SEND_BACKLOG` and drop honest peers.

- Fork window: with the default `allowFork: true` the rewrite is applied before we react; between the reorg and the purge (milliseconds, async) forked blocks are servable and the live range may fetch a few of them. `allowFork: false` would close the window but hides the rewrite entirely (no public signal), so detection was preferred.
- Re-gate window on the seeder: after admission the main store may hold a bogus block 0 (announcer serving a different history than it served to quarantine) until the local gate runs on the first growth event; third peers could read that single block in that window. Everything they read is still signed by the key holder and gated on their side.
- Stuck goals from lying advertisers (reduced by S2 and cycle 2 H1): peers that are not verified seeders, however many identities they use, can hold `--once` only for one `UNVERIFIED_BUDGET_MS` budget per run; a gate for a PENDING key still starts on any advertisement >= 1 and, when nobody serves block 0, the `--once` ends `tempo esgotado` (bounded by the deadline; no unsafe effect). Without a verified seeder, `ok: true` means only "every peer that showed interest within the budget said it has our diary": `seederConfirmed: false` says so.
- Sybil peers (S1): the connection cap counts connections, not identities, so a set of Noise keys can still occupy all `MAX_CONNECTIONS` slots of a seeder or a member (phase 1: per-address limits or certified-member priority).
- No seeder-wide byte budget (S3): the limits are per log, so a seeder may hold up to members x `MAX_LOG_BYTES`.
- Purging a core that a connected peer is replicating can race with that peer's messages inside hypercore (`flushHints` on a closed storage destroys the stream, observed with hypercore 11.39); the peer reconnects. The S7 rollback therefore purges only when the storage actually holds the core.
- Orphan cores: if a future bug writes a core into the main store without an `admitted.json` entry, corestore serves it on request and there is no public API to enumerate stored cores for a startup sweep. The write-ahead/purge-first ordering and the `dropping` map (a key stays persisted until its purge succeeds, R6.1) prevent this in every crash point and concurrent-persist interleaving analysed.
- `'conflict'` (equivocation without truncation) handling relies on hypercore closing the sessions and on `purgeReplica` reopening a fresh session to purge; not exercised upstream for corestore-managed cores and hard to fixture; marked best-effort (T10 may add a two-writable-copies test).
- Quarantine fetch waits the full `timeoutMs` when the offering peer disconnects mid-fetch and no other advertiser joins it (bounded; `--once` bounds it by the remaining time; a later advertiser joins the in-flight fetch through `addSocket`).
- Member quarantine attaches to every peer currently advertising the key >= 1, including those that advertise it while the fetch is in flight; those peers could pull block 0 back from the quarantine core, which they already claim to hold.
- Seeder admitted with 0 blocks (announcer left before the main store downloaded block 0) is dropped at the next restart (`'no-cert'`) and needs a fresh `announce`; admission is idempotent so this only costs one sync.
- Seeder certificates have no expiry or revocation (phase 2), and `announce` remains unauthenticated by design.
- Tests read `dht.io.serverSocket.address()` and `dht.io.portRange` (internal but stable dht-rpc state) to prove loopback/ephemeral binding; `process.kill(-pid)` process groups are POSIX only.
- Quarantine directory garbage after a crash persists until the next start (disk only, never served: the main store never opens it).
- Rename (somos -> varanda): the signature domains, the admission channel and the rendezvous topic changed, so certificates, keys and data dirs made before the rename do not verify or interoperate; start a fresh setup (assoc init, id create, seed key).
