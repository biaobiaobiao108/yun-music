export type AudioEffectConfig = {
  enabled?: boolean
  preset?: 'flat' | 'vocal' | 'bass' | 'focus'
  gain?: number
}

type AudioGraph = {
  context: AudioContext
  source: MediaElementAudioSourceNode
  low: BiquadFilterNode
  high: BiquadFilterNode
  gain: GainNode
  analyser: AnalyserNode
}

let graph: AudioGraph | null = null
const listeners = new Set<() => void>()

export function subscribeAudioGraph(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAudioAnalyser(): AnalyserNode | null {
  return graph?.analyser ?? null
}

export function ensureAudioGraph(audio: HTMLAudioElement): AudioGraph | null {
  if (graph) {
    void graph.context.resume().catch(() => undefined)
    return graph
  }
  const AudioContextConstructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextConstructor) return null
  try {
    const context = new AudioContextConstructor()
    const source = context.createMediaElementSource(audio)
    const low = context.createBiquadFilter()
    low.type = 'lowshelf'
    low.frequency.value = 180
    const high = context.createBiquadFilter()
    high.type = 'highshelf'
    high.frequency.value = 4200
    const gain = context.createGain()
    const analyser = context.createAnalyser()
    analyser.fftSize = 128
    analyser.smoothingTimeConstant = .82
    source.connect(low)
    low.connect(high)
    high.connect(gain)
    gain.connect(analyser)
    analyser.connect(context.destination)
    graph = { context, source, low, high, gain, analyser }
    listeners.forEach(listener => listener())
    return graph
  } catch {
    return null
  }
}

export function configureAudioGraph(config: AudioEffectConfig): void {
  if (!graph) return
  const preset = config.preset ?? 'flat'
  const enabled = config.enabled === true
  const values = preset === 'vocal'
    ? { low: -2, high: 4 }
    : preset === 'bass'
      ? { low: 7, high: 1 }
      : preset === 'focus'
        ? { low: 2, high: 5 }
        : { low: 0, high: 0 }
  graph.low.gain.value = enabled ? values.low : 0
  graph.high.gain.value = enabled ? values.high : 0
  graph.gain.gain.value = Math.min(1.5, Math.max(.1, Number(config.gain ?? 1)))
  void graph.context.resume().catch(() => undefined)
}

export function releaseAudioGraph(): void {
  if (!graph) return
  try {
    graph.source.disconnect()
    graph.low.disconnect()
    graph.high.disconnect()
    graph.gain.disconnect()
    graph.analyser.disconnect()
    void graph.context.close()
  } catch { /* browser may already have released the graph */ }
  graph = null
  listeners.forEach(listener => listener())
}
