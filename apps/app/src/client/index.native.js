// iOS and Android: the in-app node (a Bare worklet). Metro picks this file
// over index.web.js on native platforms.
export { startNode, terminateNode, currentClient, startProbe, defaultDataDir, documentPath } from './native'
