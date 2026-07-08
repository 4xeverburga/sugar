import { describe, expect, it } from 'vitest'
import {
  buildTopologyGraph,
  detectCycle,
  edgeTrafficShare,
  generatorUsesBatchMode,
  nextOutgoingEdgeIndex,
} from '../src/components'
import type { EdgeSimConfig, SimTopology } from '../src/ports'

function edgeConfig(overrides: Partial<EdgeSimConfig> = {}): EdgeSimConfig {
  return {
    trafficShareRatio: 1,
    averagePayloadSizeKB: 1,
    targetComputeWeightMultiplier: 1,
    pathIoLatencyMs: 0,
    ...overrides,
  }
}

const threeNodeTopology: SimTopology = {
  nodes: [
    { id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 100 } },
    {
      id: 'api',
      sim: {
        kind: 'host',
        profile: 'transactional_api',
        configMode: 'manual',
        manualBaselineLatencyMs: 10,
        manualSaturationRPS: 500,
        manualMaxRPS: 600,
        overloadBehavior: 'clamp',
        minReplicas: 1,
        maxReplicas: 1,
        bootDelayMs: 8000,
        highWatermark: 0.8,
        lowWatermark: 0.3,
      },
    },
    { id: 'db', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 5 } },
  ],
  edges: [
    { id: 'e1', source: 'pool', target: 'api', config: edgeConfig() },
    { id: 'e2', source: 'api', target: 'db', config: edgeConfig() },
  ],
}

describe('buildTopologyGraph', () => {
  it('indexes nodes, edges, generator ids, and a valid topological order', () => {
    const graph = buildTopologyGraph(threeNodeTopology)
    expect(graph.nodeIds).toEqual(['pool', 'api', 'db'])
    expect(graph.generatorNodeIds).toEqual(['pool'])
    expect(graph.outgoingEdgesByNode.get('pool')).toEqual(['e1'])
    expect(graph.incomingEdgesByNode.get('api')).toEqual(['e1'])
    expect(graph.edgeById.get('e1')?.source).toBe('pool')
    expect(graph.topologicalOrder).toEqual(['pool', 'api', 'db'])
  })

  it('returns an empty topological order when the graph has a cycle', () => {
    const cyclic: SimTopology = {
      nodes: [
        { id: 'a', sim: { kind: 'queue' } },
        { id: 'b', sim: { kind: 'queue' } },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b', config: edgeConfig() },
        { id: 'e2', source: 'b', target: 'a', config: edgeConfig() },
      ],
    }
    expect(buildTopologyGraph(cyclic).topologicalOrder).toEqual([])
  })
})

describe('edgeTrafficShare', () => {
  it('returns the edge\'s own configured ratio, unmodified', () => {
    expect(edgeTrafficShare({ config: edgeConfig({ trafficShareRatio: 0.3 }) })).toBe(0.3)
  })

  it('does not normalize against sibling edges — multiple edges from the same source can each carry a ratio of 1.0 (broadcast/sequential fan-out)', () => {
    const topology: SimTopology = {
      nodes: [
        { id: 'q', sim: { kind: 'queue' } },
        { id: 'a', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 1 } },
        { id: 'b', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 1 } },
      ],
      edges: [
        { id: 'qa', source: 'q', target: 'a', config: edgeConfig({ trafficShareRatio: 1 }) },
        { id: 'qb', source: 'q', target: 'b', config: edgeConfig({ trafficShareRatio: 1 }) },
      ],
    }
    const graph = buildTopologyGraph(topology)
    expect(edgeTrafficShare(graph.edgeById.get('qa'))).toBe(1)
    expect(edgeTrafficShare(graph.edgeById.get('qb'))).toBe(1)
  })

  it('clamps a negative ratio to 0 and treats a missing edge as 0', () => {
    expect(edgeTrafficShare({ config: edgeConfig({ trafficShareRatio: -5 }) })).toBe(0)
    expect(edgeTrafficShare(undefined)).toBe(0)
  })
})

describe('detectCycle', () => {
  it('returns undefined for an acyclic topology', () => {
    expect(detectCycle(buildTopologyGraph(threeNodeTopology))).toBeUndefined()
  })

  it('detects a direct two-node cycle', () => {
    const cyclic: SimTopology = {
      nodes: [
        { id: 'a', sim: { kind: 'queue' } },
        { id: 'b', sim: { kind: 'queue' } },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b', config: edgeConfig() },
        { id: 'e2', source: 'b', target: 'a', config: edgeConfig() },
      ],
    }
    const cycle = detectCycle(buildTopologyGraph(cyclic))
    expect(cycle).toBeDefined()
    expect(cycle).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('detects a longer cycle through three nodes', () => {
    const cyclic: SimTopology = {
      nodes: [
        { id: 'a', sim: { kind: 'queue' } },
        { id: 'b', sim: { kind: 'queue' } },
        { id: 'c', sim: { kind: 'queue' } },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b', config: edgeConfig() },
        { id: 'e2', source: 'b', target: 'c', config: edgeConfig() },
        { id: 'e3', source: 'c', target: 'a', config: edgeConfig() },
      ],
    }
    expect(detectCycle(buildTopologyGraph(cyclic))).toBeDefined()
  })

  it('ignores edges reaching a node with no sim role', () => {
    const topology: SimTopology = {
      nodes: [{ id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 10 } }],
      edges: [{ id: 'e1', source: 'pool', target: 'plain-node', config: edgeConfig() }],
    }
    expect(detectCycle(buildTopologyGraph(topology))).toBeUndefined()
  })
})

describe('nextOutgoingEdgeIndex', () => {
  it('cycles round-robin through available edges', () => {
    let index = -1
    index = nextOutgoingEdgeIndex(index, 3)
    expect(index).toBe(0)
    index = nextOutgoingEdgeIndex(index, 3)
    expect(index).toBe(1)
    index = nextOutgoingEdgeIndex(index, 3)
    expect(index).toBe(2)
    index = nextOutgoingEdgeIndex(index, 3)
    expect(index).toBe(0)
  })

  it('returns 0 when there are no edges', () => {
    expect(nextOutgoingEdgeIndex(-1, 0)).toBe(0)
  })
})

describe('generatorUsesBatchMode', () => {
  it('stays per-item below the threshold', () => {
    expect(generatorUsesBatchMode(100)).toBe(false)
  })

  it('switches to batch mode above the threshold', () => {
    expect(generatorUsesBatchMode(1_000_000)).toBe(true)
  })
})

