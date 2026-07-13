import { describe, expect, it } from 'vitest'
import { sweepParam, runHolds } from '../src/sweep'
import { runSimulation } from '../src/runner'
import { summarizeRun } from '../src/summary'
import { parseDiagramTopologyValue } from '../src/diagramInput'

// A single unscalable API behind a client pool: raising the pool rate
// monotonically pushes it from holding to breaking, so the breaking point is
// well-defined.
function diagram(rate: number) {
  return {
    nodes: [
      { id: 'src', data: { label: 'src', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: rate } } },
      {
        id: 'api',
        data: {
          label: 'api',
          sim: {
            kind: 'host',
            profile: 'transactional_api',
            configMode: 'manual',
            manualBaselineLatencyMs: 10,
            manualSaturationRPS: 500,
            manualMaxRPS: 550,
            overloadBehavior: 'collapse',
            minReplicas: 1,
            maxReplicas: 1,
            bootDelayMs: 8000,
            highWatermark: 0.8,
            lowWatermark: 0.3,
          },
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'src', target: 'api', data: { simConfig: { trafficShareRatio: 1, averagePayloadSizeKB: 2, targetComputeWeightMultiplier: 1, pathIoLatencyMs: 0 } } },
    ],
  }
}

describe('sweepParam', () => {
  it('brackets the breaking point between a holding and a breaking value', () => {
    const result = sweepParam(diagram(100), {
      param: 'src.requestRatePerSec',
      from: 100,
      to: 3000,
      durationMs: 30_000,
    })
    expect(result.largestHolding).not.toBeNull()
    expect(result.smallestBreaking).not.toBeNull()
    expect(result.largestHolding!.value).toBeLessThan(result.smallestBreaking!.value)
    // The API's clamp is ~550 rps, so the break sits in that neighborhood.
    expect(result.breakingPoint).toBeGreaterThan(400)
    expect(result.breakingPoint).toBeLessThan(700)
    expect(result.smallestBreaking!.bottleneckNodeId).toBe('api')
  })

  it('reports no break when the system holds across the whole range', () => {
    const result = sweepParam(diagram(10), { param: 'src.requestRatePerSec', from: 10, to: 100, durationMs: 20_000 })
    expect(result.smallestBreaking).toBeNull()
    expect(result.breakingPoint).toBeNull()
    expect(result.largestHolding).not.toBeNull()
  })

  it('reports a break at the minimum when even --from breaks', () => {
    const result = sweepParam(diagram(5000), { param: 'src.requestRatePerSec', from: 5000, to: 9000, durationMs: 20_000 })
    expect(result.largestHolding).toBeNull()
    expect(result.breakingPoint).toBe(5000)
  })

  it('throws on a malformed --param or a missing node/field', () => {
    expect(() => sweepParam(diagram(100), { param: 'noDotHere', from: 1, to: 2, durationMs: 1000 })).toThrow('param')
    expect(() => sweepParam(diagram(100), { param: 'ghost.requestRatePerSec', from: 1, to: 2, durationMs: 1000 })).toThrow('not in the diagram')
    expect(() => sweepParam(diagram(100), { param: 'src.nopeField', from: 1, to: 2, durationMs: 1000 })).toThrow('field')
  })
})

describe('runHolds', () => {
  it('is true for a healthy run and false once a host sheds', () => {
    const calm = parseDiagramTopologyValue(diagram(50)).topology
    const calmSummary = summarizeRun(runSimulation(calm, { durationMs: 20_000 }).windows, { durationMs: 20_000, windowSizeMs: 200, seed: 42 })
    expect(runHolds(calmSummary)).toBe(true)

    const flooded = parseDiagramTopologyValue(diagram(5000)).topology
    const floodedSummary = summarizeRun(runSimulation(flooded, { durationMs: 20_000 }).windows, { durationMs: 20_000, windowSizeMs: 200, seed: 42 })
    expect(runHolds(floodedSummary)).toBe(false)
  })
})
