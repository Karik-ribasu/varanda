// The "fim de tarde" band. Every platform draws 48 stacked horizontal
// stripes sampled from the sunset stops (plain Views, so the gradient shows
// on iOS, Android and web; react-native-web 0.21 does not map
// backgroundImage). On iOS and Android an overlay above them also carries
// the CSS linear-gradient (react-native 0.83 new architecture); if it does
// not render, the overlay stays transparent and the stripes remain.

import { Platform, StyleSheet, View } from 'react-native'
import { interpolateStops } from '../format'
import { sunset, sunsetStops } from './theme'

const STRIPES = 48
const stripeColors = interpolateStops(sunsetStops, STRIPES)
const native = Platform.OS === 'ios' || Platform.OS === 'android'

export function SunsetBand ({ height, children, style }) {
  const step = height / STRIPES
  return (
    <View style={[styles.band, { height }, style]} accessible={false}>
      {stripeColors.map((color, i) => (
        <View key={i} style={[styles.stripe, { top: i * step, height: step + 1, backgroundColor: color }]} />
      ))}
      {native ? <View style={[StyleSheet.absoluteFill, { experimental_backgroundImage: sunset }]} /> : null}
      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  band: { position: 'relative', overflow: 'hidden' },
  stripe: { position: 'absolute', left: 0, right: 0 }
})
