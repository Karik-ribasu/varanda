// The top bar of a tab: the chair mark, the title and an optional right slot.

import { Image, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors, fonts, layout, type } from './theme'

const mark = require('../../assets/cadeira.png')

export function TopBar ({ title, right }) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.bar, { paddingTop: insets.top, height: layout.topBar + insets.top }]}>
      <Image source={mark} style={styles.mark} accessibilityLabel='Varanda' />
      <Text style={styles.title} numberOfLines={1} accessibilityRole='header'>{title}</Text>
      {right || null}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.bg
  },
  mark: { width: 32, height: 32 },
  title: { ...type.barTitle, fontFamily: fonts.title, color: colors.ink, flex: 1 }
})
