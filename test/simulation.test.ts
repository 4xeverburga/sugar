import { describe, expect, it } from 'vitest'
import { createSimulation } from '../src/simulation'
import { mulberry32, PoissonTrafficSource } from '../src/poisson'
import type { EdgeSimConfig, MetricsSinkPort, MetricsWindow, SimTopology } from '../src/ports'
import { CycleError } from '../src/ports'

function collectingSink(): { sink: MetricsSinkPort; windows: MetricsWindow[] } {
  const windows: MetricsWindow[] = []
  return { sink: { emitWindow: (window) => windows.push(window) }, windows }
}

function edgeConfig(overrides: Partial<EdgeSimConfig> = {}): EdgeSimConfig {
  return { trafficShareRatio: 1, averagePayloadSizeKB: 1, targetComputeWeightMultiplier: 1, pathIoLatencyMs: 0, ...overrides }
}

const uncongestedTopology: SimTopology = {
  nodes: [
    { id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 100 } },
    {
      id: 'api',
      sim: {
        kind: 'host',
        profile: 'transactional_api',
        configMode: 'manual',
        manualBaselineLatencyMs: 10,
        manualSaturationRPS: 200,
        manualMaxRPS: 200,
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

const congestedTopology: SimTopology = {
  ...uncongestedTopology,
  nodes: [
    { id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 300 } },
    uncongestedTopology.nodes[1],
    uncongestedTopology.nodes[2],
  ],
}

describe('createSimulation lifecycle', () => {
  it('emits no windows while idle or paused', () => {
    const { sink, windows } = collectingSink()
    const simulation = createSimulation(new PoissonTrafficSource(mulberry32(1)), sink, 200)
    simulation.loadTopology(uncongestedTopology)
    simulation.tick(200)
    expect(windows).toHaveLength(0)

    simulation.start()
    simulation.pause()
    simulation.tick(200)
    expect(windows).toHaveLength(0)
  })

  it('emits exactly one window per windowSizeMs of elapsed running time', () => {
    const { sink, windows } = collectingSink()
    const simulation = createSimulation(new PoissonTrafficSource(mulberry32(1)), sink, 200)
    simulation.loadTopology(uncongestedTopology)
    simulation.start()
    simulation.tick(1000)
    expect(windows).toHaveLength(5)
  })

  it('rejects a cyclic topology at loadTopology', () => {
    const { sink } = collectingSink()
    const simulation = createSimulation(new PoissonTrafficSource(mulberry32(1)), sink, 200)
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
    expect(() => simulation.loadTopology(cyclic)).toThrow(CycleError)
  })

  it('runs with no client pool without throwing, reporting zero throughput everywhere', () => {
    const { sink, windows } = collectingSink()
    const simulation = createSimulation(new PoissonTrafficSource(mulberry32(1)), sink, 200)
    simulation.loadTopology({
      nodes: [uncongestedTopology.nodes[1], uncongestedTopology.nodes[2]],
      edges: [{ id: 'api-db', source: 'api', target: 'db', config: edgeConfig() }],
    })
    simulation.start()
    simulation.tick(200)
    expect(windows).toHaveLength(1)
    expect(windows[0].nodes.api.throughputPerSec).toBe(0)
    expect(windows[0].nodes.api.queueDepth).toBe(0)
  })

  it('reset zeroes virtual time and queue backlog', () => {
    const { sink, windows } = collectingSink()
    const withQueue: SimTopology = {
      nodes: [
        { id: 'pool', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 300 } },
        { id: 'q', sim: { kind: 'queue' } },
        {
          id: 'api',
          sim: {
            kind: 'host',
            profile: 'transactional_api',
            configMode: 'manual',
            manualBaselineLatencyMs: 10,
            manualSaturationRPS: 100,
            manualMaxRPS: 100,
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
        { id: 'pool-q', source: 'pool', target: 'q', config: edgeConfig() },
        { id: 'q-api', source: 'q', target: 'api', config: edgeConfig() },
      ],
    }
    const simulation = createSimulation(new PoissonTrafficSource(mulberry32(1)), sink, 200)
    simulation.loadTopology(withQueue)
    simulation.start()
    simulation.tick(2000)
    expect(windows.at(-1)?.nodes.q.queue?.backlogGB).toBeGreaterThan(0)

    simulation.reset()
    windows.length = 0
    simulation.start()
    simulation.tick(200)
    expect(windows[0].windowEndSimTimeMs).toBe(200)
    // Backlog restarts from empty on reset, not from wherever it left off.
    expect(windows[0].nodes.q.queue?.backlogGB).toBeLessThan(0.1)
  })
})

describe('createSimulation steady-state throughput (SC-003)', () => {
  it('an uncongested host (offered rate < capacity) forwards near the input rate at low saturation', () => {
    const { sink, windows } = collectingSink()
    const simulation = createSimulation(new PoissonTrafficSource(mulberry32(2)), sink, 200)
    simulation.loadTopology(uncongestedTopology)
    simulation.start()
    simulation.tick(10_000)
    const last = windows.at(-1)
    expect(last).toBeDefined()
    const forwarded = last!.nodes.api.host!.forwardedRPS
    expect(forwarded).toBeGreaterThan(90)
    expect(forwarded).toBeLessThan(110)
    expect(last!.nodes.api.host!.saturationRatio).toBeLessThan(0.6)
  })

  it('a congested host (offered rate > maxRPS) sheds the excess and plateaus at maxRPS', () => {
    const { sink, windows } = collectingSink()
    const simulation = createSimulation(new PoissonTrafficSource(mulberry32(3)), sink, 200)
    simulation.loadTopology(congestedTopology)
    simulation.start()
    simulation.tick(10_000)
    const last = windows.at(-1)
    expect(last).toBeDefined()
    const host = last!.nodes.api.host!
    expect(host.forwardedRPS).toBeGreaterThan(190)
    expect(host.forwardedRPS).toBeLessThan(210)
    expect(host.shedRPS).toBeGreaterThan(80)
    expect(host.status).toBe('overloaded')
  })

  it('the client-pool -> host edge carries the offered rate and the host -> external-api edge carries the forwarded rate', () => {
    const { sink, windows } = collectingSink()
    const simulation = createSimulation(new PoissonTrafficSource(mulberry32(4)), sink, 200)
    simulation.loadTopology(congestedTopology)
    simulation.start()
    simulation.tick(10_000)
    const last = windows.at(-1)
    expect(last).toBeDefined()
    expect(last!.edges['pool-api'].throughputPerSec).toBeGreaterThan(280)
    expect(last!.edges['api-db'].throughputPerSec).toBeLessThan(220)
  })
})

