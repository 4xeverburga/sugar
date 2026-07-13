import { describe, expect, it } from 'vitest'
import { runSimulation } from '../src/runner'
import { parseDiagramTopology } from '../src/diagramInput'
import type { SimTopology } from '../src/ports'

const simpleDiagram = JSON.stringify({
  nodes: [
    { id: 'src', data: { label: 'src', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 100 } } },
    { id: 'ext', data: { label: 'ext', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 20 } } },
  ],
  edges: [
    { id: 'e1', source: 'src', target: 'ext', data: { simConfig: { trafficShareRatio: 1, averagePayloadSizeKB: 1, targetComputeWeightMultiplier: 1, pathIoLatencyMs: 0 } } },
  ],
})

function topology(): SimTopology {
  return parseDiagramTopology(simpleDiagram).topology
}

describe('runSimulation', () => {
  it('emits one window per windowSizeMs of simulated time', () => {
    const result = runSimulation(topology(), { durationMs: 10_000, windowSizeMs: 200 })
    expect(result.windows).toHaveLength(50)
    expect(result.durationMs).toBe(10_000)
    expect(result.windowSizeMs).toBe(200)
  })

  it('is deterministic for a fixed seed (same windows run to run)', () => {
    const a = runSimulation(topology(), { durationMs: 5_000, seed: 7 })
    const b = runSimulation(topology(), { durationMs: 5_000, seed: 7 })
    expect(a.windows).toEqual(b.windows)
  })

  it('produces different traffic for different seeds', () => {
    const a = runSimulation(topology(), { durationMs: 5_000, seed: 1 })
    const b = runSimulation(topology(), { durationMs: 5_000, seed: 2 })
    expect(a.windows).not.toEqual(b.windows)
  })

  it('drops the trailing partial window when duration is not a whole multiple', () => {
    const result = runSimulation(topology(), { durationMs: 950, windowSizeMs: 200 })
    expect(result.windows).toHaveLength(4)
    expect(result.durationMs).toBe(800)
  })

  it('rejects a non-positive duration', () => {
    expect(() => runSimulation(topology(), { durationMs: 0 })).toThrow('duration')
  })
})
