// Identidade: create the identity, show the public key and the member
// certificate status, add the certificate the association issued.

import { useCallback, useEffect, useState } from 'react'
import { displayText } from '@varanda/rpc'
import { useNode } from '../node'
import { Body, Btn, Card, ErrorText, Field, Label, Mono, Notice, Page, Soft, Title, errorText, useAction } from '../ui'

export default function Identidade ({ active }) {
  const node = useNode()
  const [info, setInfo] = useState(null)
  const [identity, setIdentity] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [certText, setCertText] = useState('')
  const [certLocal, setCertLocal] = useState('')
  const [done, setDone] = useState('')
  const create = useAction()
  const add = useAction()

  const refresh = useCallback(async () => {
    try {
      const i = await node.request('node.info', {})
      setInfo(i)
      setIdentity(i.publicKey === null ? null : await node.request('identity.show', {}))
      setLoadError('')
    } catch (err) {
      setLoadError(errorText(err))
    }
  }, [node.request])

  useEffect(() => { if (active) refresh() }, [active, refresh])

  const doCreate = async () => {
    const r = await create.run(() => node.request('identity.create', {}))
    if (r.ok) refresh()
  }

  const doCert = async () => {
    setDone('')
    let cert
    try {
      // iOS smart punctuation turns typed " into curly quotes; a certificate
      // holds only ASCII values, so they are read back as plain quotes.
      cert = JSON.parse(certText.replace(/[“”„‟″]/g, '"'))
    } catch {
      return setCertLocal('JSON inválido')
    }
    if (cert === null || typeof cert !== 'object' || Array.isArray(cert)) return setCertLocal('o certificado deve ser um objeto JSON')
    setCertLocal('')
    const r = await add.run(() => node.request('cert.add', { cert }))
    if (r.ok) {
      setCertText('')
      setDone('certificado gravado')
      refresh()
    }
  }

  return (
    <Page>
      <Title>Identidade</Title>
      <ErrorText>{loadError}</ErrorText>
      {info === null && !loadError ? <Soft>carregando…</Soft> : null}
      {info !== null && info.publicKey === null
        ? (
          <Card>
            <Body>Você ainda não tem identidade neste nó.</Body>
            <ErrorText>{create.error}</ErrorText>
            <Btn label='criar identidade' onPress={doCreate} pending={create.pending} />
          </Card>
          )
        : null}
      {info !== null && info.publicKey !== null
        ? (
          <Card>
            <Label>sua chave pública</Label>
            <Mono>{displayText(info.publicKey)}</Mono>
            {identity ? <Label>associação</Label> : null}
            {identity ? <Mono>{displayText(identity.association)}</Mono> : null}
            <Body>{'certificado de membro: ' + (info.memberCert ? 'válido' : 'ausente')}</Body>
          </Card>
          )
        : null}
      {info !== null && info.publicKey !== null && !info.memberCert
        ? (
          <Card>
            <Label>certificado de membro (JSON emitido pela associação)</Label>
            <Field value={certText} onChangeText={setCertText} multiline lines={6} mono placeholder='{"...": "..."}' />
            <ErrorText>{certLocal || add.error}</ErrorText>
            <Btn label='gravar certificado' onPress={doCert} pending={add.pending} disabled={certText.trim() === ''} />
          </Card>
          )
        : null}
      <Notice>{done}</Notice>
      {info !== null && info.publicKey !== null ? <Soft>{'diários seguidos: ' + String(info.followCount)}</Soft> : null}
    </Page>
  )
}
