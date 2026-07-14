import { describe, expect, it } from 'vitest'
import { edgeTrafficShare } from '../../src/components'
import { type NodeModel } from '../../src/registry/nodeModel'
import { buildRegistry } from '../../src/registry/registry'
import { registry } from '../../src/registry'
import type { NodeSim, SimTopology } from '../../src/ports'
import { runSimulation } from '../../src/runner'
import { summarizeRun } from '../../src/summary'

interface CacheSim {
  kind: 'cache'
  hitRatio: number
  backingCapacityRPS: number
}

function isCacheSim(raw: unknown): raw is CacheSim {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: string }).kind === 'cache' &&
    typeof (raw as { hitRatio?: unknown }).hitRatio === 'number' &&
    typeof (raw as { backingCapacityRPS?: unknown }).backingCapacityRPS === 'number'
  )
}

const cacheModel: NodeModel<CacheSim, null> = {
  id: 'cache',
  label: 'Cache',
  paramSchema: {
    params: [
      { name: 'hitRatio', type: 'number', min: 0, max: 1 },
      { name: 'backingCapacityRPS', type: 'number', min: 0, unit: 'rps' },
    ],
  },
  formulaDescriptors: [],
  validateConfig(raw) {
    if (!isCacheSim(raw)) return { ok: false, message: 'SUGAR: cache config is invalid.' }
    if (raw.hitRatio < 0 || raw.hitRatio > 1) return { ok: false, message: 'SUGAR: cache hitRatio must be in [0, 1].' }
    if (raw.backingCapacityRPS < 0) return { ok: false, message: 'SUGAR: cache backingCapacityRPS must be >= 0.' }
    return { ok: true, value: raw }
  },
  initialState() {
    return null
  },
  reconcileState() {
    return null
  },
  acceptCapacityRPS(config) {
    const missRatio = Math.max(1e-9, 1 - config.hitRatio)
    return config.backingCapacityRPS / missRatio
  },
  computeWindow(ctx) {
    const acceptedRPS = Math.min(ctx.incomingRPS, this.acceptCapacityRPS(ctx.config, ctx.prevState))
    const edgeOutputRPS = new Map<string, number>()
    for (const edgeId of ctx.outgoingEdgeIds) {
      edgeOutputRPS.set(edgeId, acceptedRPS * edgeTrafficShare(ctx.graph.edgeById.get(edgeId)))
    }
    return {
      metrics: {
        throughputPerSec: acceptedRPS,
        queueDepth: 0,
      },
      nextState: null,
      edgeOutputRPS,
    }
  },
}

describe('registry extensibility', () => {
  it('runs a topology that includes a fixture model registered via one new entry', () => {
    const baseModels = [...registry.byKind.values()]
    const extended = buildRegistry([...baseModels, cacheModel])
    expect(extended.byKind.size).toBe(baseModels.length + 1)
    expect(extended.byKind.get('cache')).toBe(cacheModel)

    const originalResolve = registry.resolve
    const originalByKind = registry.byKind
    ;(registry as unknown as { resolve: typeof originalResolve }).resolve = extended.resolve
    ;(registry as unknown as { byKind: typeof originalByKind }).byKind = extended.byKind

    try {
      const topology: SimTopology = {
        nodes: [
          { id: 'src', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 120 } },
          { id: 'cache-1', sim: { kind: 'cache', hitRatio: 0.85, backingCapacityRPS: 300 } as unknown as NodeSim },
          { id: 'api', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 25 } },
        ],
        edges: [
          {
            id: 'e1',
            source: 'src',
            target: 'cache-1',
            config: { trafficShareRatio: 1, averagePayloadSizeKB: 1, targetComputeWeightMultiplier: 1, pathIoLatencyMs: 0 },
          },
          {
            id: 'e2',
            source: 'cache-1',
            target: 'api',
            config: { trafficShareRatio: 1, averagePayloadSizeKB: 1, targetComputeWeightMultiplier: 1, pathIoLatencyMs: 0 },
          },
        ],
      }

      const run = runSimulation(topology, { durationMs: 10_000, seed: 1 })
      const summary = summarizeRun(run.windows, run)
      expect(summary.nodes.some((node) => node.id === 'cache-1')).toBe(true)
      expect(summary.nodes.some((node) => node.id === 'api')).toBe(true)
      expect(summary.nodes.some((node) => node.id === 'src')).toBe(true)
    } finally {
      ;(registry as unknown as { resolve: typeof originalResolve }).resolve = originalResolve
      ;(registry as unknown as { byKind: typeof originalByKind }).byKind = originalByKind
    }
  })
})
