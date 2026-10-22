import { useEffect, useState } from 'react'
import { StatusBar } from 'expo-status-bar'
import { StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { NodeProvider, useNode } from './src/node'
import { Btn, Tabs, colors } from './src/ui'
import Conexao from './src/screens/Conexao'
import Identidade from './src/screens/Identidade'
import Perfil from './src/screens/Perfil'
import Publicar from './src/screens/Publicar'
import Seguindo from './src/screens/Seguindo'
import ARua from './src/screens/ARua'
import Diario from './src/screens/Diario'
import Sincronizar from './src/screens/Sincronizar'

// Inlined by Expo at build time; set only for the iOS worklet gate
// (docs/ios-gate.md).
const GATE_URL = process.env.EXPO_PUBLIC_VARANDA_GATE_URL

const TABS = [
  { id: 'identidade', label: 'Identidade' },
  { id: 'perfil', label: 'Perfil' },
  { id: 'publicar', label: 'Publicar' },
  { id: 'seguindo', label: 'Seguindo' },
  { id: 'rua', label: 'A Rua' },
  { id: 'diario', label: 'Diário' },
  { id: 'sincronizar', label: 'Sincronizar' },
  { id: 'conexao', label: 'Conexão' }
]

function Member () {
  const node = useNode()
  const [tab, setTab] = useState('identidade')
  const [reply, setReply] = useState(null)
  const ready = node.phase === 'ready'
  // Once the node was ready the tree stays mounted for good: a disconnect,
  // another tab taking over or a restart only adds a banner, so drafts
  // survive.
  const [seen, setSeen] = useState(false)
  useEffect(() => { if (ready) setSeen(true) }, [ready])

  if (!ready && !seen) {
    // loading, connecting, the native Conectar form, or a web error.
    if (node.phase === 'loading' || (node.phase === 'connecting' && !node.canConfigure)) {
      return (
        <View style={styles.center}>
          <Text style={styles.brand}>Varanda</Text>
          <Text style={styles.soft}>conectando…</Text>
        </View>
      )
    }
    return <Conexao />
  }

  // Every screen stays mounted (drafts survive a tab change); `active`
  // makes a screen reload its data when it is shown, and again when the
  // connection comes back.
  const is = (id) => tab === id
  const on = (id) => is(id) && ready
  const shown = (id) => (is(id) ? styles.shown : styles.hidden)
  return (
    <View style={styles.flex}>
      <Text style={styles.brand}>Varanda</Text>
      {!ready
        ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              {node.phase === 'connecting' || node.phase === 'loading' ? 'reconectando…' : (node.error || 'sem conexão com o nó')}
            </Text>
            {node.phase !== 'connecting' && node.phase !== 'loading'
              ? <Btn label='reconectar' onPress={() => node.reconnect()} secondary />
              : null}
          </View>
          )
        : null}
      <Tabs tabs={TABS} current={tab} onSelect={setTab} />
      <View style={shown('identidade')}><Identidade active={on('identidade')} /></View>
      <View style={shown('perfil')}><Perfil /></View>
      <View style={shown('publicar')}><Publicar reply={reply} onClearReply={() => setReply(null)} /></View>
      <View style={shown('seguindo')}><Seguindo active={on('seguindo')} /></View>
      <View style={shown('rua')}>
        <ARua active={on('rua')} onReply={(r) => { setReply(r); setTab('publicar') }} />
      </View>
      <View style={shown('diario')}><Diario active={on('diario')} /></View>
      <View style={shown('sincronizar')}><Sincronizar /></View>
      <View style={shown('conexao')}><Conexao active={on('conexao')} /></View>
    </View>
  )
}

export default function App () {
  if (GATE_URL) {
    const GateScreen = require('./src/gate/GateScreen').default
    return (
      <SafeAreaProvider>
        <GateScreen url={GATE_URL} />
      </SafeAreaProvider>
    )
  }
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.flex} edges={['top', 'bottom', 'left', 'right']}>
        <NodeProvider>
          <Member />
        </NodeProvider>
        <StatusBar style='dark' />
      </SafeAreaView>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 8 },
  brand: { fontSize: 18, fontWeight: '700', color: colors.accent, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, backgroundColor: colors.card },
  banner: { backgroundColor: '#fff4e0', paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
  bannerText: { fontSize: 14, color: colors.warn },
  soft: { fontSize: 14, color: colors.soft },
  shown: { flex: 1 },
  hidden: { display: 'none' }
})
