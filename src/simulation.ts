import { EventQueue } from './eventQueue.js'
import { batchSizeForSubinterval, buildTopologyGraph, detectCycle, generatorUsesBatchMode, type TopologyGraph } from './components.js'
import { propagateWindow } from './flowPropagation.js'
import { registry, resolveModelId } from './registry/index.js'
import {
  CycleError,
  type MetricsSinkPort,
  type MetricsWindow,
  type NodeSim,
  type Simulation,
  type SimTopology,
  type TrafficSourcePort,
} from './ports.js'

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
  let stateByNode = new Map<string, unknown>()
  let clientPoolArrivalAccumulator = new Map<string, number>()

  function isClientPoolSim(sim: NodeSim): sim is Extract<NodeSim, { kind: 'host'; profile: 'client_pool' }> {
    return sim.kind === 'host' && resolveModelId(sim) === 'client_pool'
  }

  function validatedModelConfig(nodeId: string, sim: NodeSim): { model: NonNullable<ReturnType<typeof registry.resolve>>; config: unknown } {
    const model = registry.resolve(sim)
    if (!model) throw new Error(`SUGAR: missing registry model for node ${nodeId}.`)
    const validated = model.validateConfig(sim)
    if (!validated.ok) throw new Error(`SUGAR: invalid node config for ${nodeId}: ${validated.message}`)
    return { model, config: validated.value }
  }

  function initializeStateFromGraph(): void {
    stateByNode = new Map()
    for (const [nodeId, sim] of graph.simByNode) {
      const validated = validatedModelConfig(nodeId, sim)
      stateByNode.set(nodeId, validated.model.initialState(validated.config))
    }
  }

  function resetRuntimeState(): void {
    queue.clear()
    initializeStateFromGraph()
    clientPoolArrivalAccumulator = new Map()
    virtualTimeMs = 0
    timeIntoWindowMs = 0
  }

  function reconcileStateByNode(): void {
    const nextStateByNode = new Map<string, unknown>()
    for (const [nodeId, sim] of graph.simByNode) {
      const validated = validatedModelConfig(nodeId, sim)
      const previousState = stateByNode.has(nodeId) ? stateByNode.get(nodeId) : validated.model.initialState(validated.config)
      const reconciled = validated.model.reconcileState({
        simTimeMs: virtualTimeMs,
        windowSizeMs,
        stateByNode,
        graph,
        nodeId,
        sim,
        config: validated.config,
        previousState,
      })
      nextStateByNode.set(nodeId, reconciled)
    }
    stateByNode = nextStateByNode
  }

  function nextGeneratorDelayMs(ratePerSec: number): number {
    return generatorUsesBatchMode(ratePerSec) ? windowSizeMs / 10 : trafficSource.nextInterArrivalMs(ratePerSec)
  }

  function scheduleAllGenerators(fromMs: number): void {
    for (const nodeId of graph.generatorNodeIds) {
      const sim = graph.simByNode.get(nodeId)
      if (!sim || !isClientPoolSim(sim) || sim.requestRatePerSec <= 0) continue
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
      if (!sim || !isClientPoolSim(sim)) continue
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
      stateByNode,
      simTimeMs: virtualTimeMs,
    })
    stateByNode = result.nextStateByNode
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
        // Live topology/config updates keep prior runtime where possible,
        // then let each model reconcile state to the new graph/config.
        reconcileStateByNode()
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

