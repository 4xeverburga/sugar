import { describe, expect, it } from 'vitest'
import {
  DIAGRAM_SCHEMA_VERSION,
  LEGACY_BOOT_DELAY_MS_FOR_IMPORT,
  LEGACY_HIGH_WATERMARK_FOR_IMPORT,
  LEGACY_LOW_WATERMARK_FOR_IMPORT,
  LEGACY_OVERLOAD_BEHAVIOR_FOR_IMPORT,
} from '../../src/config'
import { parseDiagramTopologyValue } from '../../src/diagramInput'
import type { NodeSim } from '../../src/ports'
import { registry } from '../../src/registry'

function shapeOf(sim: NodeSim): { kind: string; profile?: string } {
  if (sim.kind === 'queue') return { kind: sim.kind }
  return { kind: sim.kind, profile: sim.profile }
}

describe('registry schema round-trip', () => {
  it('keeps DIAGRAM_SCHEMA_VERSION unchanged for this migration', () => {
    expect(DIAGRAM_SCHEMA_VERSION).toBe(1)
  })

  it('round-trips every registered model with stable kind/profile shape', () => {
    const fixturesByModelId: Record<string, NodeSim> = {
      queue: { kind: 'queue' },
      client_pool: { kind: 'host', profile: 'client_pool', requestRatePerSec: 75 },
      external_api: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 35 },
      saturating_host: {
        kind: 'host',
        profile: 'transactional_api',
        configMode: 'manual',
        manualBaselineLatencyMs: 12,
        manualSaturationRPS: 600,
        manualMaxRPS: 700,
        overloadBehavior: LEGACY_OVERLOAD_BEHAVIOR_FOR_IMPORT,
        minReplicas: 1,
        maxReplicas: 1,
        bootDelayMs: LEGACY_BOOT_DELAY_MS_FOR_IMPORT,
        highWatermark: LEGACY_HIGH_WATERMARK_FOR_IMPORT,
        lowWatermark: LEGACY_LOW_WATERMARK_FOR_IMPORT,
      },
    }

    expect([...registry.byKind.keys()].sort()).toEqual(Object.keys(fixturesByModelId).sort())

    for (const modelId of registry.byKind.keys()) {
      const sim = fixturesByModelId[modelId]
      const parsed = parseDiagramTopologyValue({
        schemaVersion: DIAGRAM_SCHEMA_VERSION,
        nodes: [{ id: `node-${modelId}`, data: { label: modelId, sim } }],
        edges: [],
      })

      expect(parsed.warnings).toEqual([])
      expect(parsed.topology.nodes).toHaveLength(1)
      const roundTripped = parsed.topology.nodes[0].sim
      expect(shapeOf(roundTripped)).toEqual(shapeOf(sim))
      expect(roundTripped).toEqual(sim)
    }
  })
})
