import { describe, expect, it } from 'vitest'
import { DIAGRAM_SCHEMA_VERSION } from '../../src/config'
import { parseDiagramTopologyValue } from '../../src/diagramInput'
import { runSimulation } from '../../src/runner'
import { summarizeRun } from '../../src/summary'

describe('unknown kind degradation', () => {
  it('degrades unknown node kinds to plain nodes and keeps the rest runnable', () => {
    const diagram = {
      schemaVersion: DIAGRAM_SCHEMA_VERSION + 1,
      nodes: [
        {
          id: 'src',
          data: { label: 'src', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 60 } },
        },
        {
          id: 'retired',
          data: { label: 'retired', sim: { kind: 'cache', hitRatio: 0.9, backingCapacityRPS: 500 } },
        },
        {
          id: 'api',
          data: { label: 'api', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 20 } },
        },
      ],
      edges: [
        {
          id: 'e-direct',
          source: 'src',
          target: 'api',
          data: {
            simConfig: {
              trafficShareRatio: 1,
              averagePayloadSizeKB: 1,
              targetComputeWeightMultiplier: 1,
              pathIoLatencyMs: 0,
            },
          },
        },
        {
          id: 'e-to-retired',
          source: 'src',
          target: 'retired',
          data: {
            simConfig: {
              trafficShareRatio: 1,
              averagePayloadSizeKB: 1,
              targetComputeWeightMultiplier: 1,
              pathIoLatencyMs: 0,
            },
          },
        },
        {
          id: 'e-from-retired',
          source: 'retired',
          target: 'api',
          data: {
            simConfig: {
              trafficShareRatio: 1,
              averagePayloadSizeKB: 1,
              targetComputeWeightMultiplier: 1,
              pathIoLatencyMs: 0,
            },
          },
        },
      ],
    }

    const parsed = parseDiagramTopologyValue(diagram)
    expect(parsed.warnings.some((warning) => warning.includes('newer'))).toBe(true)
    expect(parsed.warnings.some((warning) => warning.includes('plain'))).toBe(true)

    expect(parsed.topology.nodes.map((node) => node.id)).toEqual(['src', 'api'])
    expect(parsed.topology.edges.map((edge) => edge.id)).toEqual(['e-direct'])

    const run = runSimulation(parsed.topology, { durationMs: 10_000, seed: 1 })
    const summary = summarizeRun(run.windows, run, parsed.labels)
    expect(summary.nodes.map((node) => node.id)).toEqual(['src', 'api'])
  })
})
