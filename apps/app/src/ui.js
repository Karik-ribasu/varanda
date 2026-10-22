// Small UI kit (react-native primitives only) and the action hook shared by
// the screens. Every string that comes from a peer or from the node is
// rendered by the screens through displayText (docs/rpc.md section 10).

import { useCallback, useRef, useState } from 'react'
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { displayText } from '@varanda/rpc'

export const UNCERTAIN = 'incerto: pode ter sido aplicado; confira antes de repetir'

export const colors = {
  bg: '#fbf8f3',
  card: '#ffffff',
  ink: '#1f2a24',
  soft: '#5b6660',
  line: '#ded8cc',
  accent: '#1d6b4f',
  accentInk: '#ffffff',
  danger: '#a3201a',
  warn: '#8a5a00'
}

// The text of an error for the person: never the raw message.
export function errorText (err) {
  if (err && err.uncertain === true) return UNCERTAIN
  const message = err && typeof err.message === 'string' && err.message !== '' ? err.message : 'erro'
  return displayText(message)
}

// One request at a time per action: `pending` disables the button and a
// second call while pending is ignored (no double submit). run(fn) ->
// { ok: true, value } or { ok: false }; the error text is in `error`.
// A mutation is never resent: a failure only shows the message.
export function useAction () {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const run = useCallback(async (fn) => {
    if (busy.current) return { ok: false }
    busy.current = true
    setPending(true)
    setError('')
    try {
      return { ok: true, value: await fn() }
    } catch (err) {
      setError(errorText(err))
      return { ok: false }
    } finally {
      busy.current = false
      setPending(false)
    }
  }, [])
  return { run, pending, error, clearError: () => setError('') }
}

export function Page ({ children }) {
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.pageContent} keyboardShouldPersistTaps='handled'>
      <View style={styles.column}>{children}</View>
    </ScrollView>
  )
}

export function Title ({ children }) {
  return <Text style={styles.title} accessibilityRole='header'>{children}</Text>
}

export function Label ({ children }) {
  return <Text style={styles.label}>{children}</Text>
}

export function Body ({ children, style }) {
  return <Text style={[styles.body, style]}>{children}</Text>
}

export function Soft ({ children }) {
  return <Text style={styles.soft}>{children}</Text>
}

// Selectable text for keys and other values the person may want to copy.
export function Mono ({ children }) {
  return <Text style={styles.mono} selectable>{children}</Text>
}

export function ErrorText ({ children }) {
  if (!children) return null
  return <Text style={styles.error} accessibilityRole='alert'>{children}</Text>
}

export function Notice ({ children }) {
  if (!children) return null
  return <Text style={styles.notice}>{children}</Text>
}

export function Card ({ children }) {
  return <View style={styles.card}>{children}</View>
}

export function Row ({ children }) {
  return <View style={styles.row}>{children}</View>
}

export function Btn ({ label, onPress, disabled, pending, secondary, danger }) {
  const off = disabled === true || pending === true
  return (
    <Pressable
      accessibilityRole='button'
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.btn,
        secondary && styles.btnSecondary,
        danger && styles.btnDanger,
        off && styles.btnOff,
        pressed && styles.btnPressed
      ]}
    >
      <Text style={[styles.btnText, (secondary || danger) && styles.btnTextSecondary, danger && styles.btnTextDanger]}>
        {pending ? label + '…' : label}
      </Text>
    </Pressable>
  )
}

export function Field ({ label, value, onChangeText, multiline, maxLength, editable = true, placeholder, mono, lines = 4 }) {
  return (
    <View style={styles.field}>
      {label ? <Label>{label}</Label> : null}
      <TextInput
        style={[styles.input, multiline && { minHeight: lines * 22 + 16, textAlignVertical: 'top' }, mono && styles.inputMono, !editable && styles.inputOff]}
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        maxLength={maxLength}
        editable={editable}
        placeholder={placeholder}
        placeholderTextColor='#9aa39e'
        autoCapitalize='none'
        autoCorrect={false}
        spellCheck={false}
        accessibilityLabel={label}
      />
    </View>
  )
}

// A segmented bar built from Pressables.
export function Tabs ({ tabs, current, onSelect }) {
  return (
    <View style={styles.tabsWrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {tabs.map((tab) => (
          <Pressable
            key={tab.id}
            accessibilityRole='tab'
            accessibilityState={{ selected: tab.id === current }}
            onPress={() => onSelect(tab.id)}
            style={[styles.tab, tab.id === current && styles.tabOn]}
          >
            <Text style={[styles.tabText, tab.id === current && styles.tabTextOn]}>{tab.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )
}

const monoFont = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.bg },
  pageContent: { padding: 16, paddingBottom: 48 },
  column: { width: '100%', maxWidth: 640, alignSelf: 'center', gap: 12 },
  title: { fontSize: 22, fontWeight: '700', color: colors.ink },
  label: { fontSize: 14, fontWeight: '600', color: colors.soft },
  body: { fontSize: 16, lineHeight: 22, color: colors.ink },
  soft: { fontSize: 14, lineHeight: 20, color: colors.soft },
  mono: { fontSize: 13, lineHeight: 19, color: colors.ink, fontFamily: monoFont },
  error: { fontSize: 14, lineHeight: 20, color: colors.danger },
  notice: { fontSize: 14, lineHeight: 20, color: colors.warn },
  card: { backgroundColor: colors.card, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: 12, gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  btn: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  btnSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.accent },
  btnDanger: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.danger },
  btnOff: { opacity: 0.45 },
  btnPressed: { opacity: 0.8 },
  btnText: { fontSize: 16, fontWeight: '600', color: colors.accentInk },
  btnTextSecondary: { color: colors.accent },
  btnTextDanger: { color: colors.danger },
  field: { gap: 4 },
  input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16, color: colors.ink },
  inputMono: { fontFamily: monoFont, fontSize: 14 },
  inputOff: { backgroundColor: '#efece5', color: colors.soft },
  tabsWrap: { backgroundColor: colors.card, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  tabs: { paddingHorizontal: 8, gap: 4, alignItems: 'center' },
  tab: { paddingVertical: 12, paddingHorizontal: 12, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  tabOn: { borderBottomColor: colors.accent },
  tabText: { fontSize: 15, color: colors.soft },
  tabTextOn: { color: colors.accent, fontWeight: '700' }
})
