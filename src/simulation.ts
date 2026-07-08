import { EventQueue } from './eventQueue'
import { batchSizeForSubinterval, buildTopologyGraph, detectCycle, generatorUsesBatchMode, type TopologyGraph } from './components'
import { propagateWindow } from './flowPropagation'
import { createReplicaRuntime, reclampReplicaRuntime, type ReplicaRuntime } from './autoscaler'
import {
  CycleError,
  type MetricsSinkPort,
  type MetricsWindow,
  type Simulation,
  type SimTopology,
  type TrafficSourcePort,
} from './ports'

type GeneratorEvent = { nodeId: string }

type RunStatus = 'idle' | 'running' | 'paused'

// The DES loop: schedule/advance/drain, run lifecycle (contracts/
// engine-ports.md). `tick`-driven design keeps the engine clockless — the
// host owns wall time (worker: setInterval; tests: fixed steps), which is
// what makes SC-005 (deterministic engine tests) possible. Only client-pool
// hosts still ride the Poisson event queue (research.md D1) — their
// arrival count this window becomes the "measured RPS" flowPropagation
// treats as that pool's offered load; every other node's metrics are a
// pure per-window function of that rate (flowPropagation.ts).
export function createSimulation(
  trafficSource: TrafficSourcePort,
  metricsSink: MetricsSinkPort,
  windowSizeMs: number,
): Simulation {
  let graph: TopologyGraph = buildTopologyGraph({ nodes: [], edges: [] })
  let status: RunStatus = 'idle'
  let virtualTimeMs = 0
  let timeIntoWindowMs = 0
  const queue = new EventQueue<GeneratorEvent>()
  const queueBacklogGB = new Map<string, number>()
  let clientPoolArrivalAccumulator = new Map<string, number>()
  // Per-host autoscaler runtime (feature 013) — lives alongside
  // queueBacklogGB as engine-owned cross-window state; the graph swap
  // below re-clamps or (re-)creates one entry per saturating host so a
  // mid-run topology/bounds edit never leaves a stale or missing runtime
  // (research.md D7, FR-014).
  let replicaRuntimeByNode = new Map<string, ReplicaRuntime>()

  function resetRuntimeState(): void {
    queue.clear()
    queueBacklogGB.clear()
    clientPoolArrivalAccumulator = new Map()
    virtualTimeMs = 0
    timeIntoWindowMs = 0
    replicaRuntimeByNode = new Map()
    for (const nodeId of graph.nodeIds) {
      const sim = graph.simByNode.get(nodeId)
      if (sim?.kind === 'queue') queueBacklogGB.set(nodeId, 0)
      if (sim?.kind === 'host' && (sim.profile === 'transactional_api' || sim.profile === 'worker_consumer' || sim.profile === 'database_server')) {
        replicaRuntimeByNode.set(nodeId, createReplicaRuntime(sim.minReplicas))
      }
    }
  }

  // Re-clamps every scaled host's runtime into its current [min, max]
  // (research.md D7) without resetting sustain/cooldown state — called
  // whenever the topology is reloaded WITHOUT a full reset (i.e. a live
  // config edit, not start-from-idle or reset()).
  function reclampReplicaRuntimes(): void {
    for (const nodeId of graph.nodeIds) {
      const sim = graph.simByNode.get(nodeId)
      if (!sim || sim.kind !== 'host' || (sim.profile !== 'transactional_api' && sim.profile !== 'worker_consumer' && sim.profile !== 'database_server')) continue
      const existing = replicaRuntimeByNode.get(nodeId) ?? createReplicaRuntime(sim.minReplicas)
      replicaRuntimeByNode.set(nodeId, reclampReplicaRuntime(existing, sim.minReplicas, sim.maxReplicas))
    }
    // Drop runtime for any host id no longer present/no longer saturating.
    for (const nodeId of replicaRuntimeByNode.keys()) {
      const sim = graph.simByNode.get(nodeId)
      if (!sim || sim.kind !== 'host' || (sim.profile !== 'transactional_api' && sim.profile !== 'worker_consumer' && sim.profile !== 'database_server')) {
        replicaRuntimeByNode.delete(nodeId)
      }
    }
  }

  function nextGeneratorDelayMs(ratePerSec: number): number {
    return generatorUsesBatchMode(ratePerSec) ? windowSizeMs / 10 : trafficSource.nextInterArrivalMs(ratePerSec)
  }

  function scheduleAllGenerators(fromMs: number): void {
    for (const nodeId of graph.generatorNodeIds) {
      const sim = graph.simByNode.get(nodeId)
      if (!sim || sim.kind !== 'host' || sim.profile !== 'client_pool' || sim.requestRatePerSec <= 0) continue
      queue.schedule(fromMs + nextGeneratorDelayMs(sim.requestRatePerSec), { nodeId })
    }
  }

  function recordArrival(nodeId: string, count: number): void {
    if (count <= 0) return
    clientPoolArrivalAccumulator.set(nodeId, (clientPoolArrivalAccumulator.get(nodeId) ?? 0) + count)
  }

  function processDueEvents(untilMs: number): void {
    for (;;) {
      const next = queue.peek()
      if (!next || next.timeMs > untilMs) break
      queue.popMin()
      const sim = graph.simByNode.get(next.payload.nodeId)
      if (!sim || sim.kind !== 'host' || sim.profile !== 'client_pool') continue
      const batchMode = generatorUsesBatchMode(sim.requestRatePerSec)
      const count = batchMode ? batchSizeForSubinterval(sim.requestRatePerSec, windowSizeMs) : 1
      if (count > 0) recordArrival(next.payload.nodeId, count)
      if (sim.requestRatePerSec > 0) {
        queue.schedule(next.timeMs + nextGeneratorDelayMs(sim.requestRatePerSec), { nodeId: next.payload.nodeId })
      }
    }
  }

  function flushWindow(): void {
    const clientPoolMeasuredRPS = new Map<string, number>()
    for (const [nodeId, count] of clientPoolArrivalAccumulator) {
      clientPoolMeasuredRPS.set(nodeId, (count / windowSizeMs) * 1000)
    }
    const result = propagateWindow({
      graph,
      windowSizeMs,
      clientPoolMeasuredRPS,
      queueBacklogGB,
      replicaRuntimeByNode,
      simTimeMs: virtualTimeMs,
    })
    for (const [nodeId, backlog] of result.nextQueueBacklogGB) queueBacklogGB.set(nodeId, backlog)
    replicaRuntimeByNode = result.nextReplicaRuntimeByNode
    const window: MetricsWindow = {
      windowEndSimTimeMs: virtualTimeMs,
      nodes: Object.fromEntries(result.nodeMetricsById),
      edges: Object.fromEntries(result.edgeMetricsById),
    }
    clientPoolArrivalAccumulator = new Map()
    metricsSink.emitWindow(window)
  }

  function advance(stepMs: number): void {
    const targetMs = virtualTimeMs + stepMs
    processDueEvents(targetMs)
    virtualTimeMs = targetMs
  }

  return {
    loadTopology(topology: SimTopology): void {
      const nextGraph = buildTopologyGraph(topology)
      const cycle = detectCycle(nextGraph)
      if (cycle) throw new CycleError(cycle)
      const isFirstLoad = graph.nodeIds.length === 0 && status === 'idle' && virtualTimeMs === 0
      graph = nextGraph
      if (isFirstLoad) {
        resetRuntimeState()
      } else {
        // A live topology/config update (not the very first load, not a
        // reset()): re-clamp bounds rather than wiping sustain/cooldown
        // progress (research.md D7) — queue backlog also needs fresh
        // entries for any newly-added queue node.
        for (const nodeId of graph.nodeIds) {
          const sim = graph.simByNode.get(nodeId)
          if (sim?.kind === 'queue' && !queueBacklogGB.has(nodeId)) queueBacklogGB.set(nodeId, 0)
        }
        reclampReplicaRuntimes()
      }
    },

    start(): void {
      if (status === 'idle') scheduleAllGenerators(virtualTimeMs)
      if (status === 'idle' || status === 'paused') status = 'running'
    },

    pause(): void {
      if (status === 'running') status = 'paused'
    },

    reset(): void {
      status = 'idle'
      resetRuntimeState()
    },

    tick(elapsedMs: number): void {
      if (status !== 'running' || elapsedMs <= 0) return
      let remaining = elapsedMs
      while (remaining > 0) {
        const remainingInWindow = windowSizeMs - timeIntoWindowMs
        const step = Math.min(remaining, remainingInWindow)
        advance(step)
        timeIntoWindowMs += step
        remaining -= step
        if (timeIntoWindowMs >= windowSizeMs) {
          flushWindow()
          timeIntoWindowMs = 0
        }
      }
    },
  }
}

