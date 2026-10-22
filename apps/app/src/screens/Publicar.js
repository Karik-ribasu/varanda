// Publicar: post.create, or post.reply when a post was chosen in A Rua.

import { useRef, useState } from 'react'
import { MAX_TEXT, displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { Body, Btn, Card, ErrorText, Field, Notice, Page, Row, Soft, Title, useAction } from '../ui'

const count = (s) => Array.from(s).length

export default function Publicar ({ reply, onClearReply }) {
  const node = useNode()
  const [text, setText] = useState('')
  const [done, setDone] = useState('')
  const action = useAction()
  const replyRef = useRef(reply)
  replyRef.current = reply
  const len = count(text)
  const valid = len >= 1 && len <= MAX_TEXT

  const send = async () => {
    setDone('')
    const sent = text
    const sentReply = reply
    // The draft is kept on any failure; an uncertain one is never resent.
    const r = await action.run(() => reply
      ? node.request('post.reply', { to: reply.ref, text })
      : node.request('post.create', { text }))
    if (r.ok) {
      // Only what was sent is cleared: an edit made while the request was
      // pending stays.
      setText((current) => (current === sent ? '' : current))
      setDone(sentReply ? 'resposta publicada' : 'publicado')
      if (sentReply && replyRef.current && replyRef.current.ref === sentReply.ref) onClearReply()
    }
  }

  return (
    <Page>
      <Title>{reply ? 'Responder' : 'Publicar'}</Title>
      {reply
        ? (
          <Card>
            <Soft>{'respondendo a ' + displayText(reply.name)}</Soft>
            <Body>{displayText(reply.text, { multiline: true })}</Body>
            <Row><Btn label='cancelar resposta' onPress={onClearReply} secondary disabled={action.pending} /></Row>
          </Card>
          )
        : null}
      <Card>
        <Field label={'texto (' + len + '/' + MAX_TEXT + ')'} value={text} onChangeText={setText} multiline lines={6} maxLength={MAX_TEXT} />
        <ErrorText>{action.error}</ErrorText>
        <Notice>{done}</Notice>
        <Btn label={reply ? 'responder' : 'publicar'} onPress={send} pending={action.pending} disabled={!valid} />
      </Card>
    </Page>
  )
}
