// Perfil: name (1..80 chars) and bio (0..280 chars), profile.set.

import { useState } from 'react'
import { MAX_BIO, MAX_NAME } from '@varanda/rpc'
import { useNode, useNotice } from '../node'
import { Btn, Card, ErrorText, Field, Notice, Page, Soft, Title, useAction } from '../ui'

const count = (s) => Array.from(s).length

export default function Perfil () {
  const node = useNode()
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  const [done, setDone] = useNotice()
  const action = useAction()
  const nameLen = count(name)
  const bioLen = count(bio)
  const valid = nameLen >= 1 && nameLen <= MAX_NAME && bioLen <= MAX_BIO

  const save = async () => {
    setDone('')
    const r = await action.run(() => node.request('profile.set', { name, bio }))
    if (r.ok) setDone('perfil publicado')
  }

  return (
    <Page>
      <Title>Perfil</Title>
      <Card>
        <Field label={'nome (' + nameLen + '/' + MAX_NAME + ')'} value={name} onChangeText={setName} maxLength={MAX_NAME} />
        <Field label={'bio (' + bioLen + '/' + MAX_BIO + ')'} value={bio} onChangeText={setBio} multiline lines={3} maxLength={MAX_BIO} />
        <ErrorText>{action.error}</ErrorText>
        <Notice>{done}</Notice>
        <Btn label='publicar perfil' onPress={save} pending={action.pending} disabled={!valid} />
      </Card>
      <Soft>O perfil novo vale a partir do momento em que é publicado. É preciso ter o certificado de membro gravado.</Soft>
    </Page>
  )
}
