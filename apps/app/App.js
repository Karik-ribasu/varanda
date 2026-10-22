import { StatusBar } from 'expo-status-bar'
import { StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

// Inlined by Expo at build time; set only for the iOS worklet gate
// (docs/ios-gate.md). The member UI (T9) replaces the placeholder.
const GATE_URL = process.env.EXPO_PUBLIC_VARANDA_GATE_URL

function Placeholder () {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Varanda</Text>
      <StatusBar style='auto' />
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
  return <Placeholder />
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center'
  },
  title: {
    fontSize: 28,
    fontWeight: '600'
  }
})
