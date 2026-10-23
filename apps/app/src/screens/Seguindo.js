// Seguindo: follow.add, follow.remove, follow.list (offset paging).

import { useCallback, useEffect, useState } from 'react'
import { FOLLOW_LIMIT_MAX, displayText, isKey } from '@varanda/rpc'
import { useNode, useNotice } from '../node'
import { Btn, Card, ErrorText, Field, Mono, Notice, Page, Soft, Title, errorText, useAction } from '../ui'

const PAGE = 50

export default function Seguindo ({ active }) {
  const node = useNode()
  const [keys, setKeys] = useState([])
  const [total, setTotal] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [input, setInput] = useState('')
  const [localError, setLocalError] = useState('')
  const [done, setDone] = useNotice()
  const add = useAction()
  const remove = useAction()
  const more = useAction()

  // Reads from the start; keeps at least as many entries as were shown.
  const reload = useCallback(async (want) => {
    try {
      const r = await node.request('follow.list', { offset: 0, limit: Math.min(FOLLOW_LIMIT_MAX, Math.max(PAGE, want)) })
      setKeys(r.follows)
      setTotal(r.total)
      setLoaded(true)
      setLoadError('')
    } catch (err) {
      setLoadError(errorText(err))
    }
  }, [node.request])

  useEffect(() => { if (active) reload(PAGE) }, [active, reload])

  const doAdd = async () => {
    setDone('')
    const key = input.trim().toLowerCase()
    if (!isKey(key)) return setLocalError('chave inválida (64 dígitos hexadecimais)')
    setLocalError('')
    const r = await add.run(() => node.request('follow.add', { key }))
    if (r.ok) {
      setInput('')
      setDone(r.value.changed ? 'seguindo' : 'você já seguia esta chave')
      reload(keys.length)
    }
  }

  const doRemove = async (key) => {
    setDone('')
    const r = await remove.run(() => node.request('follow.remove', { key }))
    if (r.ok) {
      setDone(r.value.changed ? 'deixou de seguir' : 'esta chave não estava na lista')
      reload(keys.length)
    }
  }

  const doMore = async () => {
    const r = await more.run(() => node.request('follow.list', { offset: keys.length, limit: PAGE }))
    if (r.ok) {
      setKeys((prev) => prev.concat(r.value.follows))
      setTotal(r.value.total)
    }
  }

  return (
    <Page>
      <Title>Seguindo</Title>
      <Card>
        <Field label='chave pública do diário (64 dígitos hexadecimais)' value={input} onChangeText={setInput} mono multiline lines={2} />
        <ErrorText>{localError || add.error}</ErrorText>
        <Btn label='seguir' onPress={doAdd} pending={add.pending} disabled={input.trim() === ''} />
      </Card>
      <Notice>{done}</Notice>
      <ErrorText>{loadError || remove.error}</ErrorText>
      {loaded ? <Soft>{String(total) + (total === 1 ? ' diário seguido' : ' diários seguidos')}</Soft> : null}
      {keys.map((key) => (
        <Card key={key}>
          <Mono>{displayText(key)}</Mono>
          <Btn label='deixar de seguir' onPress={() => doRemove(key)} pending={remove.pending} danger />
        </Card>
      ))}
      {loaded && keys.length < total
        ? (
          <>
            <ErrorText>{more.error}</ErrorText>
            <Btn label='mais' onPress={doMore} pending={more.pending} secondary />
          </>
          )
        : null}
      {loaded && total === 0 ? <Soft>Você ainda não segue ninguém.</Soft> : null}
    </Page>
  )
}
