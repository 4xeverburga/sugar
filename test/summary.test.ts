import { describe, expect, it } from 'vitest'
import { runSimulation } from '../src/runner'
import { summarizeRun, type HostNodeSummary } from '../src/summary'
import { parseDiagramTopology } from '../src/diagramInput'

// A client pool flooding a single, unscalable collapse-mode API — guaranteed
// to leave 'healthy' and settle into a shedding/collapsed steady state.
const collapse = JSON.stringify({
  nodes: [
    { id: 'flood', data: { label: 'flood', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 2000 } } },
    {
      id: 'api',
      data: {
        label: 'api',
        sim: {
          kind: 'host',
          profile: 'transactional_api',
          configMode: 'manual',
          manualBaselineLatencyMs: 12,
          manualSaturationRPS: 400,
          manualMaxRPS: 450,
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
    { id: 'e1', source: 'flood', target: 'api', data: { simConfig: { trafficShareRatio: 1, averagePayloadSizeKB: 2, targetComputeWeightMultiplier: 1, pathIoLatencyMs: 0 } } },
  ],
})

describe('summarizeRun', () => {
  it('reports the first-saturation order and picks the bottleneck', () => {
    const { topology, labels } = parseDiagramTopology(collapse)
    const result = runSimulation(topology, { durationMs: 30_000, seed: 42 })
    const summary = summarizeRun(result.windows, result, labels)

    expect(summary.firstSaturationOrder.length).toBeGreaterThan(0)
    expect(summary.firstSaturationOrder[0].nodeId).toBe('api')
    expect(summary.bottleneckNodeId).toBe('api')

    const api = summary.nodes.find((node): node is HostNodeSummary => node.id === 'api' && node.kind === 'host')
    expect(api?.status === 'overloaded' || api?.status === 'collapsed').toBe(true)
    expect(api!.shedRPS).toBeGreaterThan(0)
  })

  it('reports no saturation and a null bottleneck when everything stays healthy', () => {
    const calm = JSON.stringify({
      nodes: [
        { id: 'src', data: { label: 'src', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 10 } } },
        { id: 'ext', data: { label: 'ext', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 20 } } },
      ],
      edges: [
        { id: 'e1', source: 'src', target: 'ext', data: { simConfig: { trafficShareRatio: 1, averagePayloadSizeKB: 1, targetComputeWeightMultiplier: 1, pathIoLatencyMs: 0 } } },
      ],
    })
    const { topology } = parseDiagramTopology(calm)
    const result = runSimulation(topology, { durationMs: 20_000, seed: 42 })
    const summary = summarizeRun(result.windows, result)
    expect(summary.firstSaturationOrder).toHaveLength(0)
    expect(summary.bottleneckNodeId).toBeNull()
  })

  it('smooths the steady-state client-pool rate to near its configured rate', () => {
    const { topology } = parseDiagramTopology(
      JSON.stringify({
        nodes: [
          { id: 'src', data: { label: 'src', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 150 } } },
          { id: 'ext', data: { label: 'ext', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 20 } } },
        ],
        edges: [
          { id: 'e1', source: 'src', target: 'ext', data: { simConfig: { trafficShareRatio: 1, averagePayloadSizeKB: 1, targetComputeWeightMultiplier: 1, pathIoLatencyMs: 0 } } },
        ],
      }),
    )
    const result = runSimulation(topology, { durationMs: 60_000, seed: 42 })
    const summary = summarizeRun(result.windows, result)
    const ext = summary.nodes.find((node): node is HostNodeSummary => node.id === 'ext' && node.kind === 'host')
    // Averaged over the trailing quarter, the offered load lands within ~10%
    // of 150 rps — a single 200ms window would swing far wider.
    expect(ext!.incomingRPS).toBeGreaterThan(135)
    expect(ext!.incomingRPS).toBeLessThan(165)
  })
})
