// A round avatar with the person's initials on the stripe colour picked by
// the first byte of the key. Decorative: the name is read elsewhere.

import { StyleSheet, Text, View } from 'react-native'
import { displayText } from '@varanda/rpc'
import { avatarColorOf, initialsOf } from '../format'
import { colors, stripes } from './theme'

export function Avatar ({ name, publicKey, size = 44, ring = false }) {
  const stripe = stripes[avatarColorOf(publicKey)]
  const fontSize = size >= 80 ? 30 : size <= 40 ? 15 : 16
  const circle = (
    <View
      style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: stripe.bg }]}
      accessible={false}
      importantForAccessibility='no-hide-descendants'
    >
      <Text style={[styles.initials, { color: stripe.ink, fontSize }]} numberOfLines={1}>
        {displayText(initialsOf(name, publicKey))}
      </Text>
    </View>
  )
  if (!ring) return circle
  const outer = size + 8
  return (
    <View
      style={[styles.circle, { width: outer, height: outer, borderRadius: outer / 2, backgroundColor: colors.bg }]}
      accessible={false}
      importantForAccessibility='no-hide-descendants'
    >
      {circle}
    </View>
  )
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  initials: { fontWeight: '700' }
})
