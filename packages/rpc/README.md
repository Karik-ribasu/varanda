# @varanda/rpc

Contrato JSON entre a interface (app React Native / web) e um nó Varanda: o worklet Bare do app (IPC) ou o `varanda-serve` (WebSocket em loopback). A especificação normativa está em `docs/rpc.md`.

- Sem dependências e sem módulos do Node: carrega igual no Metro / react-native-web, no Node >= 20 e no Bare.
- Envelopes versão 1 (pedido, resposta, evento), validação exata de chaves e parâmetros por método.
- Enquadramento IPC (4 bytes de tamanho big-endian + JSON UTF-8) e WebSocket (um quadro de texto por mensagem).
- `createServerDispatcher` (um por conexão, no nó) e `createClient` (na interface). O cliente nunca reenvia um pedido; falhas de rede em métodos que alteram estado vêm com `uncertain: true`.
- `displayText(valor, { multiline })`: o único escapador para qualquer texto vindo de pares.

```js
const { createClient, parseMessage } = require('@varanda/rpc')

const client = createClient({ send: (message, text) => socket.send(text) })
socket.onmessage = (ev) => {
  const r = parseMessage(ev.data)
  if (r.ok) client.receive(r.value)
  else socket.close() // erro de protocolo: fecha a conexão
}
socket.onclose = () => client.close()
await client.request('session.open', { token })
const { items } = await client.request('feed.read', { limit: 30 })
```

Testes: `npm test -w packages/rpc`.
