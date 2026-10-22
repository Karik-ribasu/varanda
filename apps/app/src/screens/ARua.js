// A Rua: the feed of the followed diaries (feed.read, newest page only).

import { useCallback, useEffect, useState } from 'react'
import { FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX, displayText } from '@varanda/rpc'
import { timeText, useNode } from '../node'
import { Body, Btn, Card, ErrorText, Page, Row, Soft, Title, errorText, useAction } from '../ui'

const STEP = 5

// replyTo is { author, seq }.
function replyText (replyTo) {
  const author = replyTo && replyTo.author !== undefined ? String(replyTo.author) : ''
  const seq = replyTo && replyTo.seq !== undefined ? String(replyTo.seq) : ''
  return 'resposta a ' + displayText(author.slice(0, 8)) + ':' + displayText(seq)
}

export default function ARua ({ active, onReply }) {
  const node = useNode()
  const [limit, setLimit] = useState(FEED_LIMIT_DEFAULT)
  const [feed, setFeed] = useState(null)
  const [loadError, setLoadError] = useState('')
  const refresh = useAction()

  const load = useCallback(async (n) => {
    try {
      setFeed(await node.request('feed.read', { limit: n }))
      setLoadError('')
    } catch (err) {
      setLoadError(errorText(err))
    }
  }, [node.request])

  useEffect(() => { if (active) load(limit) }, [active, load, limit])

  const items = feed === null ? [] : feed.items.slice().reverse()
  const hasMore = feed !== null && feed.items.length >= limit && limit < FEED_LIMIT_MAX
  const atEnd = feed !== null && feed.items.length >= limit && limit >= FEED_LIMIT_MAX
  const skipped = feed === null ? 0 : feed.skipped.length + feed.skippedTruncated
  const future = feed === null ? 0 : feed.future.length + feed.futureTruncated

  return (
    <Page>
      <Row>
        <Title>A Rua</Title>
        <Btn label='atualizar' onPress={() => refresh.run(() => load(limit))} pending={refresh.pending} secondary />
      </Row>
      <ErrorText>{loadError}</ErrorText>
      {feed === null && !loadError ? <Soft>carregando…</Soft> : null}
      {feed !== null && items.length === 0 ? <Soft>Nada por aqui ainda. Siga alguém e sincronize.</Soft> : null}
      {items.map((item) => (
        <Card key={item.author + ':' + item.seq}>
          <Body style={{ fontWeight: '700' }}>{displayText(item.name || String(item.author).slice(0, 8))}</Body>
          <Soft>{timeText(item.at) + ' · ' + displayText(String(item.author).slice(0, 8))}</Soft>
          {item.replyTo ? <Soft>{replyText(item.replyTo)}</Soft> : null}
          <Body>{displayText(item.text, { multiline: true })}</Body>
          <Btn
            label='responder'
            secondary
            onPress={() => onReply({ ref: item.author + ':' + item.seq, name: item.name || String(item.author).slice(0, 8), text: item.text })}
          />
        </Card>
      ))}
      {hasMore ? <Btn label='carregar mais' onPress={() => setLimit((n) => Math.min(FEED_LIMIT_MAX, n + STEP))} secondary /> : null}
      {atEnd ? <Soft>As publicações mais antigas não estão disponíveis nesta versão.</Soft> : null}
      {skipped > 0 ? <Soft>{String(skipped) + (skipped === 1 ? ' diário seguido não aparece (sem certificado válido ou com dados inválidos)' : ' diários seguidos não aparecem (sem certificado válido ou com dados inválidos)')}</Soft> : null}
      {future > 0 ? <Soft>{String(future) + (future === 1 ? ' publicação com data futura foi ignorada' : ' publicações com data futura foram ignoradas')}</Soft> : null}
    </Page>
  )
}
