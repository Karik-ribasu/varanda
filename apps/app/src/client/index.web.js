// Web: there is no in-app node (the web build never imports
// react-native-bare-kit or the worklet bundle). The web client talks to
// varanda-serve over a loopback WebSocket instead (T9).
const unavailable = () => Promise.reject(new Error('nó local indisponível na web'))

export const startNode = unavailable
export const terminateNode = () => Promise.resolve(false)
export const currentClient = () => null
export const startProbe = unavailable
export const defaultDataDir = () => null
export const documentPath = () => null
