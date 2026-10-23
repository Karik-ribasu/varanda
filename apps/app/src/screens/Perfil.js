// Perfil: the "Editar perfil" sheet. Name (1..80 code points) and bio
// (0..280 code points), published with profile.set. The draft lives here,
// outside the Sheet (its Modal unmounts the children when closed).

import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native'
import { LOG_LIMIT_MAX, MAX_BIO, MAX_NAME } from '@varanda/rpc'
import { useNode } from '../node'
import { countChars } from '../format'
import { ErrorText, Field, Page, Soft, colors, useAction } from '../ui'
import { Pill } from '../ui/Pill'
import { Sheet } from '../ui/Sheet'

// The newest 'profile' record of the own diary page, or null.
function newestProfile (log) {
  let best = null
  for (const entry of (log && log.entries) || []) {
    const record = entry.record
    if (record && record.type === 'profile' && (best === null || entry.seq > best.seq)) {
      best = { seq: entry.seq, record }
    }
  }
  return best === null ? null : best.record
}

export default function Perfil ({ open, current, onClose, onSaved }) {
  const node = useNode()
  const action = useAction()
  const [name, setName] = useState('')
  const [bio, setBio] = useState('')
  // An uncertain save is being checked against the diary.
  const [checking, setChecking] = useState(false)
  const checkingRef = useRef(false)
  const currentRef = useRef(current)
  currentRef.current = current

  // The form starts from `current` each time the sheet opens; a reload
  // while it is open never overwrites the draft.
  useEffect(() => {
    if (!open) return
    const c = currentRef.current || {}
    setName(c.name || '')
    setBio(c.bio || '')
    action.clearError()
  }, [open])

  const nameLen = countChars(name)
  const bioLen = countChars(bio)
  const valid = nameLen >= 1 && nameLen <= MAX_NAME && bioLen <= MAX_BIO
  // While a save or its uncertain re-read runs, the fields are locked: a
  // success closes the sheet and the next open restarts from the saved profile.
  const saving = action.pending || checking

  const save = async () => {
    if (!valid || checkingRef.current) return
    const sent = { name, bio }
    const r = await action.run(() => node.request('profile.set', sent))
    if (r.ok) {
      onSaved(sent)
      return
    }
    if (!r.uncertain) return
    // The request may have been applied: read the own diary before letting
    // the person try again (a mutation is never resent).
    checkingRef.current = true
    setChecking(true)
    try {
      const log = await node.request('log.read', { limit: LOG_LIMIT_MAX })
      const newest = newestProfile(log)
      if (newest && newest.name === sent.name && (newest.bio || '') === sent.bio) onSaved(sent)
    } catch {
      // Keep the draft and the uncertain message.
    } finally {
      checkingRef.current = false
      setChecking(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title='Editar perfil'
      background={colors.bg}
      right={<Pill label='Salvar' filled onPress={save} pending={saving} disabled={!valid} />}
    >
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Page>
          <Field label={'nome (' + nameLen + '/' + MAX_NAME + ')'} value={name} onChangeText={setName} editable={!saving} />
          <Field label={'bio (' + bioLen + '/' + MAX_BIO + ')'} value={bio} onChangeText={setBio} editable={!saving} multiline lines={3} />
          <ErrorText>{action.error}</ErrorText>
          <Soft>O perfil novo vale a partir do momento em que é publicado. É preciso ter o certificado de membro gravado.</Soft>
        </Page>
      </KeyboardAvoidingView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 }
})
