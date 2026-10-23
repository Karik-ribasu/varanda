// Sincronizar: sync.start (once or continuous), sync.stop, the state from
// the node's events (kept by the provider, keyed by runId) and the last 200
// event and warning lines.

import { displayText } from '@varanda/rpc'
import { useNode, useNotice } from '../node'
import { Body, Btn, Card, ErrorText, Mono, Notice, Page, Row, Soft, Title, useAction } from '../ui'

const REASONS = {
  done: 'concluída',
  stopped: 'parada',
  preempted: 'pausada para atender um pedido',
  timeout: 'tempo esgotado',
  error: 'erro'
}

export default function Sincronizar () {
  const node = useNode()
  const { sync } = node
  // "iniciada" lasts as long as that run; "nenhuma ... em andamento" until
  // a run starts.
  const [note, setNote] = useNotice(sync.active !== null ? sync.active.runId : null)
  const start = useAction()
  const stop = useAction()

  const doStart = async (once) => {
    setNote('')
    // Never resent: after an uncertain failure the state below (events) and
    // sync.status are what the person checks first.
    const r = await start.run(() => node.request('sync.start', once ? { once: true } : {}))
    if (r.ok) setNote(once ? 'sincronização única iniciada' : 'sincronização contínua iniciada', r.value.runId)
  }

  const doStop = async () => {
    setNote('')
    const r = await stop.run(() => node.request('sync.stop', {}))
    if (r.ok && !r.value.stopped) setNote('nenhuma sincronização em andamento', null)
  }

  const running = sync.active !== null
  const stopped = sync.stopped
  return (
    <Page>
      <Title>Sincronizar</Title>
      <Card>
        <Body>
          {running
            ? 'sincronizando (' + (sync.active.once ? 'uma vez' : 'contínuo') + ', execução ' + String(sync.active.runId) + ')'
            : 'parado'}
        </Body>
        {!running && stopped ? <Soft>{'última execução ' + String(stopped.runId) + ': ' + (REASONS[stopped.reason] || displayText(stopped.reason))}</Soft> : null}
        <ErrorText>{start.error || stop.error}</ErrorText>
        <Notice>{note}</Notice>
        <Row>
          <Btn label='sincronizar uma vez' onPress={() => doStart(true)} pending={start.pending} disabled={running || stop.pending} />
          <Btn label='sincronizar sempre' onPress={() => doStart(false)} pending={start.pending} disabled={running || stop.pending} />
          <Btn label='parar' onPress={doStop} pending={stop.pending} disabled={!running || start.pending} danger />
        </Row>
      </Card>
      <Card>
        <Soft>{'linhas (as últimas ' + String(sync.lines.length) + ')'}</Soft>
        {sync.lines.length === 0 ? <Soft>Nenhuma linha ainda.</Soft> : null}
        {sync.lines.map((line, i) => <Mono key={i}>{displayText(line)}</Mono>)}
      </Card>
    </Page>
  )
}
