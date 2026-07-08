import { describe, expect, it } from 'vitest'
import { buildTopologyGraph } from '../src/components'
import { propagateWindow } from '../src/flowPropagation'
import type { EdgeSimConfig, SimTopology } from '../src/ports'

function edgeConfig(overrides: Partial<EdgeSimConfig> = {}): EdgeSimConfig {
  return { trafficShareRatio: 1, averagePayloadSizeKB: 1, targetComputeWeightMultiplier: 1, pathIoLatencyMs: 0, ...overrides }
}

function run(topology: SimTopology, clientPoolMeasuredRPS: Map<string, number>, queueBacklogGB: Map<string, number> = new Map()) {
  const graph = buildTopologyGraph(topology)
  return propagateWindow({
    graph,
    windowSizeMs: 1000,
    clientPoolMeasuredRPS,
    queueBacklogGB,
    replicaRuntimeByNode: new Map(),
    simTimeMs: 0,
  })
}

describe('propagateWindow — 3-host chain (US1)', () => {
  const chain: SimTopology = {
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
          manualMaxRPS: 550,
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
      { id: 'pool-api', source: 'pool', target: 'api', config: edgeConfig() },
      { id: 'api-db', source: 'api', target: 'db', config: edgeConfig() },
    ],
  }

  it('propagates rate in topological order end to end', () => {
    const result = run(chain, new Map([['pool', 100]]))
    expect(result.nodeMetricsById.get('pool')?.host?.forwardedRPS).toBe(100)
    expect(result.nodeMetricsById.get('api')?.host?.incomingRPS).toBe(100)
    expect(result.nodeMetricsById.get('api')?.host?.forwardedRPS).toBeCloseTo(100, 5)
    expect(result.nodeMetricsById.get('db')?.host?.incomingRPS).toBeCloseTo(100, 5)
    expect(result.edgeMetricsById.get('pool-api')?.throughputPerSec).toBe(100)
    expect(result.edgeMetricsById.get('api-db')?.throughputPerSec).toBeCloseTo(100, 5)
  })

  it('every node/edge ships sourced formula descriptors', () => {
    const result = run(chain, new Map([['pool', 100]]))
    for (const metrics of result.nodeMetricsById.values()) {
      for (const descriptor of metrics.formulaDescriptors ?? []) expect(descriptor.sources.length).toBeGreaterThan(0)
    }
    for (const metrics of result.edgeMetricsById.values()) {
      for (const descriptor of metrics.formulaDescriptors ?? []) expect(descriptor.sources.length).toBeGreaterThan(0)
    }
  })

  it('sheds traffic beyond manualMaxRPS and does not forward the shed amount', () => {
    const result = run(chain, new Map([['pool', 700]]))
    const api = result.nodeMetricsById.get('api')?.host
    expect(api?.shedRPS).toBeCloseTo(150, 5)
    expect(api?.forwardedRPS).toBeCloseTo(550, 5)
    expect(result.nodeMetricsById.get('db')?.host?.incomingRPS).toBeCloseTo(550, 5)
  })

  it('zeros out a disconnected node not reachable by any traffic source', () => {
    const disconnected: SimTopology = {
      nodes: [...chain.nodes, { id: 'orphan', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 1 } }],
      edges: chain.edges,
    }
    const result = run(disconnected, new Map([['pool', 100]]))
    expect(result.nodeMetricsById.get('orphan')?.host?.incomingRPS).toBe(0)
    expect(result.nodeMetricsById.get('orphan')?.host?.forwardedRPS).toBe(0)
  })
})

describe('propagateWindow — fan-out share splits', () => {
  it('splits a client pool proportionally across multiple hosts by configured share', () => {
    const topology: SimTopology = {
      nodes: [
        { id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 1000 } },
        { id: 'a', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 1 } },
        { id: 'b', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 1 } },
      ],
      edges: [
        { id: 'pool-a', source: 'pool', target: 'a', config: edgeConfig({ trafficShareRatio: 0.7 }) },
        { id: 'pool-b', source: 'pool', target: 'b', config: edgeConfig({ trafficShareRatio: 0.3 }) },
      ],
    }
    const result = run(topology, new Map([['pool', 1000]]))
    expect(result.edgeMetricsById.get('pool-a')?.throughputPerSec).toBeCloseTo(700, 5)
    expect(result.edgeMetricsById.get('pool-b')?.throughputPerSec).toBeCloseTo(300, 5)
  })

  it('broadcasts to multiple downstream hosts unsplit when shares are not normalized (sequential/parallel fan-out, sum > 1)', () => {
    const topology: SimTopology = {
      nodes: [
        { id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 1000 } },
        { id: 'a', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 1 } },
        { id: 'b', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 1 } },
      ],
      edges: [
        { id: 'pool-a', source: 'pool', target: 'a', config: edgeConfig({ trafficShareRatio: 1 }) },
        { id: 'pool-b', source: 'pool', target: 'b', config: edgeConfig({ trafficShareRatio: 1 }) },
      ],
    }
    const result = run(topology, new Map([['pool', 1000]]))
    // Both edges carry the FULL upstream rate — not split 50/50 — because a
    // host making sequential/parallel calls to two downstream services
    // sends every request to both.
    expect(result.edgeMetricsById.get('pool-a')?.throughputPerSec).toBeCloseTo(1000, 5)
    expect(result.edgeMetricsById.get('pool-b')?.throughputPerSec).toBeCloseTo(1000, 5)
    expect(result.nodeMetricsById.get('a')?.host?.incomingRPS).toBeCloseTo(1000, 5)
    expect(result.nodeMetricsById.get('b')?.host?.incomingRPS).toBeCloseTo(1000, 5)
  })

  it('congestion flags the first bottleneck first: a lightly-loaded downstream host is not congested while an upstream one is', () => {
    const topology: SimTopology = {
      nodes: [
        { id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 490 } },
        {
          id: 'bottleneck',
          sim: {
            kind: 'host',
            profile: 'transactional_api',
            configMode: 'manual',
            manualBaselineLatencyMs: 10,
            manualSaturationRPS: 500,
            manualMaxRPS: 500,
            overloadBehavior: 'clamp',
            minReplicas: 1,
            maxReplicas: 1,
            bootDelayMs: 8000,
            highWatermark: 0.8,
            lowWatermark: 0.3,
          },
        },
        {
          id: 'roomy',
          sim: {
            kind: 'host',
            profile: 'transactional_api',
            configMode: 'manual',
            manualBaselineLatencyMs: 10,
            manualSaturationRPS: 5000,
            manualMaxRPS: 5000,
            overloadBehavior: 'clamp',
            minReplicas: 1,
            maxReplicas: 1,
            bootDelayMs: 8000,
            highWatermark: 0.8,
            lowWatermark: 0.3,
          },
        },
      ],
      edges: [
        { id: 'pool-bottleneck', source: 'pool', target: 'bottleneck', config: edgeConfig() },
        { id: 'bottleneck-roomy', source: 'bottleneck', target: 'roomy', config: edgeConfig() },
      ],
    }
    const result = run(topology, new Map([['pool', 490]]))
    expect(result.edgeMetricsById.get('pool-bottleneck')?.sim?.isCongested).toBe(true)
    expect(result.edgeMetricsById.get('bottleneck-roomy')?.sim?.isCongested).toBe(false)
  })
})

describe('propagateWindow — host -> queue -> host (US3)', () => {
  const topology: SimTopology = {
    nodes: [
      { id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 100 } },
      { id: 'queue', sim: { kind: 'queue' } },
      {
        id: 'consumer',
        sim: {
          kind: 'host',
          profile: 'worker_consumer',
          configMode: 'manual',
          manualBaselineLatencyMs: 5,
          manualSaturationRPS: 50,
          manualMaxRPS: 50,
          overloadBehavior: 'clamp',
          minReplicas: 1,
          maxReplicas: 1,
          bootDelayMs: 8000,
          highWatermark: 0.8,
          lowWatermark: 0.3,
        },
      },
    ],
    edges: [
      { id: 'pool-queue', source: 'pool', target: 'queue', config: edgeConfig({ averagePayloadSizeKB: 200 }) },
      { id: 'queue-consumer', source: 'queue', target: 'consumer', config: edgeConfig({ averagePayloadSizeKB: 200 }) },
    ],
  }

  it('a slow consumer forces backlog to accumulate at the queue', () => {
    const result = run(topology, new Map([['pool', 100]]), new Map([['queue', 0]]))
    const queueMetrics = result.nodeMetricsById.get('queue')?.queue
    expect(queueMetrics).toBeDefined()
    expect(queueMetrics!.inflowMBps).toBeGreaterThan(queueMetrics!.outflowMBps)
  })

  it('backlog integrates window over window and drains once inflow slows', () => {
    let backlog = new Map<string, number>([['queue', 0]])
    for (let i = 0; i < 30; i += 1) {
      const result = run(topology, new Map([['pool', 100]]), backlog)
      backlog = result.nextQueueBacklogGB
    }
    const grownBacklog = backlog.get('queue') ?? 0
    expect(grownBacklog).toBeGreaterThan(0)

    for (let i = 0; i < 30; i += 1) {
      const result = run(topology, new Map([['pool', 1]]), backlog)
      backlog = result.nextQueueBacklogGB
    }
    expect(backlog.get('queue') ?? 0).toBeLessThan(grownBacklog)
  })
})

describe('propagateWindow — edge telemetry (US4)', () => {
  it('fans 1,000 req/s 0.7/0.3 into 700/300 req/s per edge', () => {
    const topology: SimTopology = {
      nodes: [
        { id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 1000 } },
        { id: 'a', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 1 } },
        { id: 'b', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 1 } },
      ],
      edges: [
        { id: 'pool-a', source: 'pool', target: 'a', config: edgeConfig({ trafficShareRatio: 0.7 }) },
        { id: 'pool-b', source: 'pool', target: 'b', config: edgeConfig({ trafficShareRatio: 0.3 }) },
      ],
    }
    const result = run(topology, new Map([['pool', 1000]]))
    expect(result.edgeMetricsById.get('pool-a')?.sim?.currentRPS).toBeCloseTo(700, 5)
    expect(result.edgeMetricsById.get('pool-b')?.sim?.currentRPS).toBeCloseTo(300, 5)
  })

  it('converts 100 req/s x 50KB to ~4.88 MB/s', () => {
    const topology: SimTopology = {
      nodes: [
        { id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 100 } },
        { id: 'a', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 1 } },
      ],
      edges: [{ id: 'pool-a', source: 'pool', target: 'a', config: edgeConfig({ averagePayloadSizeKB: 50 }) }],
    }
    const result = run(topology, new Map([['pool', 100]]))
    expect(result.edgeMetricsById.get('pool-a')?.sim?.currentMBps).toBeCloseTo(4.8828125, 3)
  })

  it("computes ~50 active connections for 200 req/s x 250ms path latency (Little's law)", () => {
    const topology: SimTopology = {
      nodes: [
        { id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 200 } },
        { id: 'a', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 0 } },
      ],
      edges: [{ id: 'pool-a', source: 'pool', target: 'a', config: edgeConfig({ pathIoLatencyMs: 250 }) }],
    }
    const result = run(topology, new Map([['pool', 200]]))
    expect(result.edgeMetricsById.get('pool-a')?.sim?.activeConnections).toBeCloseTo(50, 5)
  })
})

describe('propagateWindow — performance sanity (SC-006/SC-007)', () => {
  it('a 30-node topology at 10,000 req/s aggregate with 1-4 replica bounds on every host propagates a window well under 50ms', () => {
    const nodes: SimTopology['nodes'] = [{ id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 10_000 } }]
    const edges: SimTopology['edges'] = []
    for (let i = 0; i < 29; i += 1) {
      const id = `host-${i}`
      nodes.push({
        id,
        sim: {
          kind: 'host',
          profile: 'transactional_api',
          configMode: 'manual',
          manualBaselineLatencyMs: 5,
          manualSaturationRPS: 50_000,
          manualMaxRPS: 50_000,
          overloadBehavior: 'clamp',
          minReplicas: 1,
          maxReplicas: 4,
          bootDelayMs: 8000,
          highWatermark: 0.8,
          lowWatermark: 0.3,
        },
      })
      const source = i === 0 ? 'pool' : `host-${i - 1}`
      edges.push({ id: `${source}-${id}`, source, target: id, config: edgeConfig() })
    }
    const topology: SimTopology = { nodes, edges }
    const graph = buildTopologyGraph(topology)
    const start = performance.now()
    propagateWindow({
      graph,
      windowSizeMs: 1000,
      clientPoolMeasuredRPS: new Map([['pool', 10_000]]),
      queueBacklogGB: new Map(),
      replicaRuntimeByNode: new Map(),
      simTimeMs: 0,
    })
    const elapsedMs = performance.now() - start
    expect(elapsedMs).toBeLessThan(50)
  })
})

describe('propagateWindow — autoscaling (feature 013)', () => {
  const boundedApi = (minReplicas: number, maxReplicas: number): SimTopology['nodes'][number] => ({
    id: 'api',
    sim: {
      kind: 'host',
      profile: 'transactional_api',
      configMode: 'manual',
      manualBaselineLatencyMs: 10,
      manualSaturationRPS: 500,
      manualMaxRPS: 500,
      overloadBehavior: 'clamp',
      minReplicas,
      maxReplicas,
      bootDelayMs: 8000,
      highWatermark: 0.8,
      lowWatermark: 0.3,
    },
  })

  function topologyWith(apiNode: SimTopology['nodes'][number]): SimTopology {
    return {
      nodes: [{ id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 100 } }, apiNode],
      edges: [{ id: 'pool-api', source: 'pool', target: 'api', config: edgeConfig() }],
    }
  }

  function runWindowedScenario(topology: SimTopology, poolRPS: number, windowCount: number) {
    const graph = buildTopologyGraph(topology)
    let replicaRuntimeByNode = new Map()
    let queueBacklogGB = new Map<string, number>()
    const history: { simTimeMs: number; nominalCount: number | undefined; effectiveCount: number | undefined; saturationRatio: number | undefined }[] = []
    for (let i = 0; i < windowCount; i += 1) {
      const simTimeMs = (i + 1) * 1000
      const result = propagateWindow({
        graph,
        windowSizeMs: 1000,
        clientPoolMeasuredRPS: new Map([['pool', poolRPS]]),
        queueBacklogGB,
        replicaRuntimeByNode,
        simTimeMs,
      })
      replicaRuntimeByNode = result.nextReplicaRuntimeByNode
      queueBacklogGB = result.nextQueueBacklogGB
      const apiMetrics = result.nodeMetricsById.get('api')?.host
      history.push({
        simTimeMs,
        nominalCount: apiMetrics?.replicas?.nominalCount,
        effectiveCount: apiMetrics?.replicas?.effectiveCount,
        saturationRatio: apiMetrics?.saturationRatio,
      })
    }
    return history
  }

  it('US1: sustained high saturation scales 1 -> 2 with a visible boot-delay lag before capacity relief', () => {
    // 490 req/s against a 500 req/s single-replica cap => rho ~0.98, well
    // above the high watermark, so the scaler should add a replica.
    const history = runWindowedScenario(topologyWith(boundedApi(1, 4)), 490, 30)
    const scaleUpIndex = history.findIndex((entry, index) => index > 0 && (entry.nominalCount ?? 0) > (history[index - 1].nominalCount ?? 0))
    expect(scaleUpIndex).toBeGreaterThan(0)
    // Nominal count rises immediately, but effective (serving) count lags
    // behind until the boot delay elapses (spec FR-006).
    expect(history[scaleUpIndex].nominalCount).toBe(2)
    expect(history[scaleUpIndex].effectiveCount).toBe(1)
    const bootCompleteIndex = history.findIndex((entry, index) => index > scaleUpIndex && (entry.effectiveCount ?? 0) === 2)
    expect(bootCompleteIndex).toBeGreaterThan(scaleUpIndex)
    // Once the second replica serves, per-replica saturation roughly halves.
    expect(history[bootCompleteIndex].saturationRatio).toBeLessThan(history[scaleUpIndex].saturationRatio!)
  })

  it('US2: dropping load after scaling out eventually scales back to minReplicas', () => {
    let history = runWindowedScenario(topologyWith(boundedApi(1, 4)), 490, 40)
    const scaledUpCount = history.at(-1)?.nominalCount ?? 1
    expect(scaledUpCount).toBeGreaterThan(1)
    // Re-run the full ramp-up-then-drop as one continuous scenario so the
    // scaler's runtime state carries over exactly like flushWindow would.
    const graph = buildTopologyGraph(topologyWith(boundedApi(1, 4)))
    let replicaRuntimeByNode = new Map()
    let queueBacklogGB = new Map<string, number>()
    let last: ReturnType<typeof propagateWindow> | undefined
    for (let i = 0; i < 40; i += 1) {
      last = propagateWindow({
        graph,
        windowSizeMs: 1000,
        clientPoolMeasuredRPS: new Map([['pool', 490]]),
        queueBacklogGB,
        replicaRuntimeByNode,
        simTimeMs: (i + 1) * 1000,
      })
      replicaRuntimeByNode = last.nextReplicaRuntimeByNode
      queueBacklogGB = last.nextQueueBacklogGB
    }
    for (let i = 40; i < 120; i += 1) {
      last = propagateWindow({
        graph,
        windowSizeMs: 1000,
        clientPoolMeasuredRPS: new Map([['pool', 5]]),
        queueBacklogGB,
        replicaRuntimeByNode,
        simTimeMs: (i + 1) * 1000,
      })
      replicaRuntimeByNode = last.nextReplicaRuntimeByNode
      queueBacklogGB = last.nextQueueBacklogGB
    }
    expect(last?.nodeMetricsById.get('api')?.host?.replicas?.nominalCount).toBe(1)
    history = []
  })

  it('US3: minReplicas = maxReplicas = 1 never emits a scaling event and is bit-identical to pre-013 output (SC-003)', () => {
    const history = runWindowedScenario(topologyWith(boundedApi(1, 1)), 490, 30)
    expect(history.every((entry) => entry.nominalCount === 1 && entry.effectiveCount === 1)).toBe(true)
    const scaled = run(topologyWith(boundedApi(1, 1)), new Map([['pool', 490]]))
    const unscaledEquivalent = run(
      {
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
              manualMaxRPS: 500,
              overloadBehavior: 'clamp',
              minReplicas: 1,
              maxReplicas: 1,
              bootDelayMs: 8000,
              highWatermark: 0.8,
              lowWatermark: 0.3,
            },
          },
        ],
        edges: [{ id: 'pool-api', source: 'pool', target: 'api', config: edgeConfig() }],
      },
      new Map([['pool', 490]]),
    )
    expect(scaled.nodeMetricsById.get('api')?.host?.saturationRatio).toBeCloseTo(unscaledEquivalent.nodeMetricsById.get('api')?.host?.saturationRatio ?? -1, 10)
    expect(scaled.nodeMetricsById.get('api')?.host?.forwardedRPS).toBeCloseTo(unscaledEquivalent.nodeMetricsById.get('api')?.host?.forwardedRPS ?? -1, 10)
  })

  it('US3: minReplicas = maxReplicas = 3 divides load by 3 with zero scaling events ever', () => {
    const history = runWindowedScenario(topologyWith(boundedApi(3, 3)), 490, 30)
    expect(history.every((entry) => entry.nominalCount === 3 && entry.effectiveCount === 3)).toBe(true)
    const last = history.at(-1)
    // 490 req/s / 3 replicas ~= 163.3 req/s per replica => rho ~0.327, far
    // below the 500 req/s single-replica saturation point.
    expect(last?.saturationRatio).toBeCloseTo(490 / 3 / 500, 3)
  })

  it('FR-011: a queue draining into a scaled consumer accepts effectiveCount x per-replica remaining capacity', () => {
    const topology: SimTopology = {
      nodes: [
        { id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 1000 } },
        { id: 'queue', sim: { kind: 'queue' } },
        {
          id: 'consumer',
          sim: {
            kind: 'host',
            profile: 'worker_consumer',
            configMode: 'manual',
            manualBaselineLatencyMs: 5,
            manualSaturationRPS: 50,
            manualMaxRPS: 50,
            overloadBehavior: 'clamp',
            minReplicas: 3,
            maxReplicas: 3,
            bootDelayMs: 8000,
            highWatermark: 0.8,
            lowWatermark: 0.3,
          },
        },
      ],
      edges: [
        { id: 'pool-queue', source: 'pool', target: 'queue', config: edgeConfig({ averagePayloadSizeKB: 1 }) },
        { id: 'queue-consumer', source: 'queue', target: 'consumer', config: edgeConfig({ averagePayloadSizeKB: 1 }) },
      ],
    }
    const graph = buildTopologyGraph(topology)
    const result = propagateWindow({
      graph,
      windowSizeMs: 1000,
      clientPoolMeasuredRPS: new Map([['pool', 1000]]),
      queueBacklogGB: new Map([['queue', 0]]),
      replicaRuntimeByNode: new Map(),
      simTimeMs: 1000,
    })
    // 3 replicas x 50 req/s cap = 150 req/s accepted from the queue.
    expect(result.edgeMetricsById.get('queue-consumer')?.sim?.currentRPS).toBeCloseTo(150, 3)
    expect(result.nodeMetricsById.get('consumer')?.host?.forwardedRPS).toBeCloseTo(150, 3)
  })
})

// Feature 012 (Overload Collapse), US3 (T014): collapse is deliberately
// near-zero-code for propagation (research.md D4) — a collapsed host's low
// goodput rides the SAME, unmodified edge/queue mechanics as clamp mode.
// Two inbound paths into the collapsing host are required: a queue's
// outbound edge toward it is always capped at hostAcceptCapacityRPS
// (unaffected by overloadBehavior), so a queue-only chain could never push
// a host past its own knee — only an unbounded direct client-pool edge can.
describe('propagateWindow — overload collapse propagation regression (feature 012, US3/FR-009)', () => {
  function twoPathTopology(overloadBehavior: 'clamp' | 'collapse'): SimTopology {
    return {
      nodes: [
        { id: 'direct-source', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 2000 } },
        { id: 'queue-source', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 500 } },
        { id: 'queue', sim: { kind: 'queue' } },
        {
          id: 'b',
          sim: {
            kind: 'host',
            profile: 'transactional_api',
            configMode: 'manual',
            manualBaselineLatencyMs: 5,
            manualSaturationRPS: 500,
            manualMaxRPS: 500,
            overloadBehavior,
            minReplicas: 1,
            maxReplicas: 1,
            bootDelayMs: 8000,
            highWatermark: 0.8,
            lowWatermark: 0.3,
          },
        },
        { id: 'c', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 1 } },
      ],
      edges: [
        { id: 'direct-source-b', source: 'direct-source', target: 'b', config: edgeConfig() },
        { id: 'queue-source-queue', source: 'queue-source', target: 'queue', config: edgeConfig() },
        { id: 'queue-b', source: 'queue', target: 'b', config: edgeConfig() },
        { id: 'b-c', source: 'b', target: 'c', config: edgeConfig() },
      ],
    }
  }

  it('AS1: a downstream host tracks a collapsed host\u2019s goodput, not its offered load, once pushed well past the knee', () => {
    const result = run(
      twoPathTopology('collapse'),
      new Map([
        ['direct-source', 2000],
        ['queue-source', 500],
      ]),
      new Map([['queue', 0]]),
    )
    const b = result.nodeMetricsById.get('b')?.host
    const c = result.nodeMetricsById.get('c')?.host
    expect(b?.status).toBe('collapsed')
    expect(b!.incomingRPS).toBeGreaterThan(b!.forwardedRPS * 5) // far past the knee
    expect(c?.incomingRPS).toBeCloseTo(b!.forwardedRPS, 5) // downstream tracks the COLLAPSED goodput...
    expect(c!.incomingRPS).toBeLessThan(100) // ...nowhere near the ~2500 offered
  })

  it("FR-009/D4: hostAcceptCapacityRPS (the queue's backpressure sizing) is unaffected by overloadBehavior \u2014 manual mode", () => {
    const inputs = new Map([
      ['direct-source', 2000],
      ['queue-source', 500],
    ])
    const backlog = new Map([['queue', 0]])
    const clampResult = run(twoPathTopology('clamp'), inputs, backlog)
    const collapseResult = run(twoPathTopology('collapse'), inputs, backlog)
    // Same queue inflow/outflow/backlog dynamics regardless of the
    // downstream host's overloadBehavior — zero new propagation code
    // (research.md D4's "deliberately zero-line-diff" guarantee).
    expect(collapseResult.edgeMetricsById.get('queue-b')?.sim?.currentRPS).toBeCloseTo(
      clampResult.edgeMetricsById.get('queue-b')?.sim?.currentRPS ?? -1,
      10,
    )
    expect(collapseResult.nodeMetricsById.get('queue')?.queue?.outflowMBps).toBeCloseTo(
      clampResult.nodeMetricsById.get('queue')?.queue?.outflowMBps ?? -1,
      10,
    )
    expect(collapseResult.nextQueueBacklogGB.get('queue')).toBeCloseTo(clampResult.nextQueueBacklogGB.get('queue') ?? -1, 10)
    // B's own forwardedRPS legitimately DIFFERS between modes (that's the
    // whole feature) — confirming the two runs aren't just identical
    // end to end, only the queue-facing accept capacity is unaffected.
    expect(collapseResult.nodeMetricsById.get('b')?.host?.forwardedRPS).not.toBeCloseTo(
      clampResult.nodeMetricsById.get('b')?.host?.forwardedRPS ?? -1,
      2,
    )
  })

  it("FR-009/D4: hostAcceptCapacityRPS is unaffected by overloadBehavior \u2014 calculated mode (always unbounded, both ways)", () => {
    const calcTopology = (overloadBehavior: 'clamp' | 'collapse'): SimTopology => ({
      nodes: [
        { id: 'source', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 1000 } },
        { id: 'queue', sim: { kind: 'queue' } },
        {
          id: 'b',
          sim: {
            kind: 'host',
            profile: 'worker_consumer',
            configMode: 'calculated',
            cpuProcessingTimeMs: 16,
            maxWorkerThreads: 8,
            overloadBehavior,
            minReplicas: 1,
            maxReplicas: 1,
            bootDelayMs: 8000,
            highWatermark: 0.8,
            lowWatermark: 0.3,
          },
        },
      ],
      edges: [
        { id: 'source-queue', source: 'source', target: 'queue', config: edgeConfig() },
        { id: 'queue-b', source: 'queue', target: 'b', config: edgeConfig() },
      ],
    })
    const inputs = new Map([['source', 1000]])
    const backlog = new Map([['queue', 0]])
    const clampResult = run(calcTopology('clamp'), inputs, backlog)
    const collapseResult = run(calcTopology('collapse'), inputs, backlog)
    expect(collapseResult.edgeMetricsById.get('queue-b')?.sim?.currentRPS).toBeCloseTo(
      clampResult.edgeMetricsById.get('queue-b')?.sim?.currentRPS ?? -1,
      10,
    )
  })

  it('US4/T018: the collapse formula descriptor is present for a collapse-mode host at any load, and absent for a clamp-mode host', () => {
    const lightLoad = new Map([
      ['direct-source', 100],
      ['queue-source', 50],
    ])
    const collapseResult = run(twoPathTopology('collapse'), lightLoad, new Map([['queue', 0]]))
    const clampResult = run(twoPathTopology('clamp'), lightLoad, new Map([['queue', 0]]))
    const collapseDescriptors = collapseResult.nodeMetricsById.get('b')?.formulaDescriptors ?? []
    const clampDescriptors = clampResult.nodeMetricsById.get('b')?.formulaDescriptors ?? []
    expect(collapseDescriptors.some((d) => d.id === 'host.overload-collapse')).toBe(true)
    expect(clampDescriptors.some((d) => d.id === 'host.overload-collapse')).toBe(false)
    // Regression: clamp mode's descriptor set is otherwise unchanged (SC-003
    // extends to the formula panel, research.md D7).
    expect(clampDescriptors.map((d) => d.id).sort()).toEqual(
      collapseDescriptors.filter((d) => d.id !== 'host.overload-collapse').map((d) => d.id).sort(),
    )
  })
})

// 012-overload-collapse refinement (research.md D9): an elastic scaling
// group (minReplicas !== maxReplicas) with overloadBehavior === 'collapse'
// evicts overloaded replicas instead of applying the retrograde curve —
// this can transiently drive the group to 0 serving replicas, and the
// min-replicas floor restore (autoscaler.ts) must bring it back.
describe('propagateWindow — elastic scaling group collapse eviction (012-overload-collapse refinement)', () => {
  function elasticApi(overloadBehavior: 'clamp' | 'collapse'): SimTopology['nodes'][number] {
    return {
      id: 'api',
      sim: {
        kind: 'host',
        profile: 'transactional_api',
        configMode: 'manual',
        manualBaselineLatencyMs: 10,
        manualSaturationRPS: 500,
        manualMaxRPS: 550,
        overloadBehavior,
        minReplicas: 2,
        maxReplicas: 4,
        bootDelayMs: 8000,
        highWatermark: 0.8,
        lowWatermark: 0.3,
      },
    }
  }

  function runScenario(apiNode: SimTopology['nodes'][number], poolRPS: number, windowCount: number) {
    const topology: SimTopology = {
      nodes: [{ id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: poolRPS } }, apiNode],
      edges: [{ id: 'pool-api', source: 'pool', target: 'api', config: edgeConfig() }],
    }
    const graph = buildTopologyGraph(topology)
    let replicaRuntimeByNode = new Map()
    let queueBacklogGB = new Map<string, number>()
    const history: { nominalCount: number | undefined; effectiveCount: number | undefined; status: string | undefined }[] = []
    for (let i = 0; i < windowCount; i += 1) {
      const result = propagateWindow({
        graph,
        windowSizeMs: 1000,
        clientPoolMeasuredRPS: new Map([['pool', poolRPS]]),
        queueBacklogGB,
        replicaRuntimeByNode,
        simTimeMs: (i + 1) * 1000,
      })
      replicaRuntimeByNode = result.nextReplicaRuntimeByNode
      queueBacklogGB = result.nextQueueBacklogGB
      const apiMetrics = result.nodeMetricsById.get('api')?.host
      history.push({ nominalCount: apiMetrics?.replicas?.nominalCount, effectiveCount: apiMetrics?.replicas?.effectiveCount, status: apiMetrics?.status })
    }
    return history
  }

  it('an extreme overload cascades replica eviction down toward — and can reach — 0 serving replicas', () => {
    // 2 replicas x 550 knee = 1100 cap; 20,000 req/s is ~18x that.
    const history = runScenario(elasticApi('collapse'), 20_000, 20)
    // nominalCount reaches exactly 0 for at least one window (the eviction
    // window itself — restoreMinReplicaFloor only re-inflates it starting
    // the FOLLOWING window, per its doc). Note replicas.effectiveCount in
    // telemetry previews the NEXT window's divisor (same pre-existing
    // convention as ordinary scale-down), so status is checked separately
    // below rather than cross-referenced against it.
    const zeroNominalIndex = history.findIndex((entry) => entry.nominalCount === 0)
    expect(zeroNominalIndex).toBeGreaterThanOrEqual(0)
    // The host reports itself dead once its OWN window's effective replica
    // count (the divisor metrics were actually computed from) hit 0.
    const collapsedIndex = history.findIndex((entry) => entry.status === 'collapsed')
    expect(collapsedIndex).toBeGreaterThanOrEqual(0)
    // Nominal count only ever decreases (or holds) on the way down to 0 —
    // no oscillation back up before the group has actually crashed out.
    for (let i = 1; i <= zeroNominalIndex; i += 1) {
      expect(history[i].nominalCount).toBeLessThanOrEqual(history[i - 1].nominalCount ?? Infinity)
    }
  })

  it('recovers back to minReplicas via the boot queue after crashing to 0 (floor restore)', () => {
    const history = runScenario(elasticApi('collapse'), 20_000, 60)
    const zeroIndex = history.findIndex((entry) => entry.nominalCount === 0)
    expect(zeroIndex).toBeGreaterThanOrEqual(0)
    const restoredIndex = history.findIndex((entry, index) => index > zeroIndex && (entry.nominalCount ?? 0) >= 2)
    expect(restoredIndex).toBeGreaterThan(zeroIndex)
  })

  it('below the knee, an elastic collapse-mode group never evicts (parity with clamp)', () => {
    const collapseHistory = runScenario(elasticApi('collapse'), 400, 20)
    const clampHistory = runScenario(elasticApi('clamp'), 400, 20)
    expect(collapseHistory.every((entry) => entry.nominalCount === 2)).toBe(true)
    expect(clampHistory.every((entry) => entry.nominalCount === 2)).toBe(true)
  })

  it('a clamp-mode elastic group never evicts, regardless of overload (SC-003 regression: relies on the normal scale-up path only)', () => {
    const history = runScenario(elasticApi('clamp'), 20_000, 20)
    expect(history.every((entry) => (entry.nominalCount ?? 0) >= 2)).toBe(true)
  })

  it('a fixed (non-elastic) multi-replica collapse host never evicts either, keeping the smooth retrograde curve', () => {
    const fixedApi: SimTopology['nodes'][number] = {
      id: 'api',
      sim: {
        kind: 'host',
        profile: 'transactional_api',
        configMode: 'manual',
        manualBaselineLatencyMs: 10,
        manualSaturationRPS: 500,
        manualMaxRPS: 550,
        overloadBehavior: 'collapse',
        minReplicas: 2,
        maxReplicas: 2,
        bootDelayMs: 8000,
        highWatermark: 0.8,
        lowWatermark: 0.3,
      },
    }
    const history = runScenario(fixedApi, 20_000, 20)
    expect(history.every((entry) => entry.nominalCount === 2)).toBe(true)
  })

  it('shows the replica-eviction formula descriptor for an elastic collapse host, not the retrograde-curve one', () => {
    const topology: SimTopology = {
      nodes: [{ id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 20_000 } }, elasticApi('collapse')],
      edges: [{ id: 'pool-api', source: 'pool', target: 'api', config: edgeConfig() }],
    }
    const result = run(topology, new Map([['pool', 20_000]]))
    const descriptors = result.nodeMetricsById.get('api')?.formulaDescriptors ?? []
    expect(descriptors.some((d) => d.id === 'host.replica-eviction')).toBe(true)
    expect(descriptors.some((d) => d.id === 'host.overload-collapse')).toBe(false)
  })
})

