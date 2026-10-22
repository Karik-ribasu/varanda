// Diário: the person's own log (log.read, the newest page).

import { useCallback, useEffect, useState } from 'react'
import { displayText } from '@varanda/rpc'
import { timeText, useNode } from '../node'
import { Body, Btn, Card, ErrorText, Page, Row, Soft, Title, errorText, useAction } from '../ui'

// replyTo is { author, seq }.
function replyText (replyTo) {
  const author = replyTo && replyTo.author !== undefined ? String(replyTo.author) : ''
  const seq = replyTo && replyTo.seq !== undefined ? String(replyTo.seq) : ''
  return 'resposta a ' + displayText(author.slice(0, 8)) + ':' + displayText(seq)
}

function Entry ({ entry }) {
  const record = entry.record || {}
  const head = '#' + String(entry.seq)
  if (record.type === 'post') {
    return (
      <Card>
        <Soft>{head + ' · publicação · ' + timeText(record.at)}</Soft>
        {record.replyTo ? <Soft>{replyText(record.replyTo)}</Soft> : null}
        <Body>{displayText(record.text, { multiline: true })}</Body>
      </Card>
    )
  }
  if (record.type === 'profile') {
    return (
      <Card>
        <Soft>{head + ' · perfil · ' + timeText(record.at)}</Soft>
        <Body style={{ fontWeight: '700' }}>{displayText(record.name)}</Body>
        {record.bio ? <Body>{displayText(record.bio, { multiline: true })}</Body> : null}
      </Card>
    )
  }
  if (record.type === 'member-cert') {
    return (
      <Card>
        <Soft>{head + ' · certificado de membro'}</Soft>
      </Card>
    )
  }
  return (
    <Card>
      <Soft>{head + ' · registro desconhecido'}</Soft>
    </Card>
  )
}

export default function Diario ({ active }) {
  const node = useNode()
  const [log, setLog] = useState(null)
  const [loadError, setLoadError] = useState('')
  const refresh = useAction()

  const load = useCallback(async () => {
    try {
      setLog(await node.request('log.read', {}))
      setLoadError('')
    } catch (err) {
      setLoadError(errorText(err))
    }
  }, [node.request])

  useEffect(() => { if (active) load() }, [active, load])

  // Entries and invalid blocks, newest first, in one list by seq.
  const rows = log === null
    ? []
    : log.entries.map((e) => ({ seq: e.seq, entry: e })).concat(log.invalid.map((i) => ({ seq: i.seq, invalid: i })))
      .sort((a, b) => b.seq - a.seq)

  return (
    <Page>
      <Row>
        <Title>Diário</Title>
        <Btn label='atualizar' onPress={() => refresh.run(load)} pending={refresh.pending} secondary />
      </Row>
      <ErrorText>{loadError}</ErrorText>
      {log === null && !loadError ? <Soft>carregando…</Soft> : null}
      {log !== null && rows.length === 0 ? <Soft>O diário ainda está vazio.</Soft> : null}
      {rows.map((row) => row.invalid
        ? (
          <Card key={'i' + row.seq}>
            <Body>{'bloco inválido (#' + String(row.seq) + ': ' + displayText(row.invalid.reason) + ')'}</Body>
          </Card>
          )
        : <Entry key={'e' + row.seq} entry={row.entry} />)}
      {log !== null && log.entriesTruncated > 0
        ? <Soft>{String(log.entriesTruncated) + ' blocos mais antigos não aparecem: nesta versão só a página mais recente pode ser lida.'}</Soft>
        : null}
    </Page>
  )
}
