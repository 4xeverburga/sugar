// Per-window deterministic flow propagation over the simulated DAG.
// The driver is registry-based: node-specific behavior lives in
// src/registry/models/* while this file stays as the generic topological
// propagation + edge telemetry pass.

import { EDGE_CONGESTION_THRESHOLD, KB_PER_MB } from './config.js'
import { type TopologyGraph } from './components.js'
import {
  buildEdgeCongestionDescriptor,
  buildEdgeConnectionsDescriptor,
  buildEdgeRateDescriptor,
  validateFormulaDescriptorsHaveSources,
} from './formulaCatalog.js'
import { registry } from './registry/index.js'
import type { ReplicaRuntime } from './autoscaler.js'
import type { EdgeMetrics, NodeMetrics, NodeSim } from './ports.js'

export interface FlowPropagationInput {
  graph: TopologyGraph
  windowSizeMs: number
  /** Windowed measured rate per client-pool node. */
  clientPoolMeasuredRPS: ReadonlyMap<string, number>
  /** Opaque per-node cross-window model state. */
  stateByNode?: ReadonlyMap<string, unknown>
  /** Legacy state input retained for compatibility with existing tests/callers. */
  queueBacklogGB?: ReadonlyMap<string, number>
  /** Legacy state input retained for compatibility with existing tests/callers. */
  replicaRuntimeByNode?: ReadonlyMap<string, ReplicaRuntime>
  /** Current simulated time, for boot-delay/cooldown/sustain evaluation. */
  simTimeMs: number
}

export interface FlowPropagationOutput {
  nodeMetricsById: Map<string, NodeMetrics>
  edgeMetricsById: Map<string, EdgeMetrics>
  nextStateByNode: Map<string, unknown>
  /** Legacy state output retained for compatibility with existing tests/callers. */
  nextQueueBacklogGB: Map<string, number>
  /** Legacy state output retained for compatibility with existing tests/callers. */
  nextReplicaRuntimeByNode: Map<string, ReplicaRuntime>
}

interface PreparedNode {
  sim: NodeSim
  model: (typeof registry)['byKind'] extends ReadonlyMap<string, infer T> ? T : never
  config: unknown
  state: unknown
}

function incomingRpsForNode(incomingEdgeIds: readonly string[], edgeOutputRPS: ReadonlyMap<string, number>): number {
  let incomingRPS = 0
  for (const edgeId of incomingEdgeIds) incomingRPS += edgeOutputRPS.get(edgeId) ?? 0
  return incomingRPS
}

export function propagateWindow(input: FlowPropagationInput): FlowPropagationOutput {
  const { graph, windowSizeMs } = input
  const nodeMetricsById = new Map<string, NodeMetrics>()
  const edgeMetricsById = new Map<string, EdgeMetrics>()
  const edgeOutputRPS = new Map<string, number>()
  const nextStateByNode = new Map<string, unknown>()
  const stateByNode = new Map<string, unknown>(input.stateByNode)

  if (!input.stateByNode) {
    for (const [nodeId, sim] of graph.simByNode) {
      const model = registry.resolve(sim)
      if (!model) continue
      if (model.id === 'queue') {
        stateByNode.set(nodeId, input.queueBacklogGB?.get(nodeId) ?? 0)
      } else if (model.id === 'saturating_host') {
        const runtime = input.replicaRuntimeByNode?.get(nodeId)
        if (runtime !== undefined) stateByNode.set(nodeId, runtime)
      }
    }
  }

  const preparedByNode = new Map<string, PreparedNode>()
  for (const [nodeId, sim] of graph.simByNode) {
    const model = registry.resolve(sim)
    if (!model) continue
    const validated = model.validateConfig(sim)
    if (!validated.ok) {
      throw new Error(`SUGAR: invalid node config for ${nodeId}: ${validated.message}`)
    }
    const previous = stateByNode.has(nodeId) ? stateByNode.get(nodeId) : model.initialState(validated.value)
    const reconciled = model.reconcileState({
      simTimeMs: input.simTimeMs,
      windowSizeMs,
      stateByNode,
      graph,
      nodeId,
      sim,
      config: validated.value,
      previousState: previous,
    })
    preparedByNode.set(nodeId, { sim, model, config: validated.value, state: reconciled })
  }

  for (const nodeId of graph.topologicalOrder) {
    const prepared = preparedByNode.get(nodeId)
    if (!prepared) continue

    const incomingEdgeIds = graph.incomingEdgesByNode.get(nodeId) ?? []
    const outgoingEdgeIds = graph.outgoingEdgesByNode.get(nodeId) ?? []
    const defaultIncomingRPS = incomingRpsForNode(incomingEdgeIds, edgeOutputRPS)
    const incomingRPS = prepared.model.id === 'client_pool' ? input.clientPoolMeasuredRPS.get(nodeId) ?? 0 : defaultIncomingRPS

    const result = prepared.model.computeWindow({
      nodeId,
      sim: prepared.sim,
      config: prepared.config,
      prevState: prepared.state,
      incomingRPS,
      incomingEdgeIds,
      outgoingEdgeIds,
      graph,
      edgeOutputRPS,
      windowSizeMs,
      simTimeMs: input.simTimeMs,
      stateByNode,
      resolveDownstreamAcceptCapacityRPS(edgeId: string): number {
        const edge = graph.edgeById.get(edgeId)
        if (!edge) return Number.POSITIVE_INFINITY
        const targetPrepared = preparedByNode.get(edge.target)
        if (!targetPrepared) return Number.POSITIVE_INFINITY
        return targetPrepared.model.acceptCapacityRPS(targetPrepared.config, targetPrepared.state)
      },
    })

    prepared.state = result.nextState
    nextStateByNode.set(nodeId, result.nextState)
    nodeMetricsById.set(nodeId, result.metrics)
    for (const [edgeId, rps] of result.edgeOutputRPS) edgeOutputRPS.set(edgeId, rps)
  }

  // Pass 2: edge telemetry after node metrics are known.
  for (const [edgeId, edge] of graph.edgeById) {
    const currentRPS = edgeOutputRPS.get(edgeId) ?? 0
    const payloadKB = edge.config.averagePayloadSizeKB
    const currentMBps = (currentRPS * payloadKB) / KB_PER_MB
    const targetMetrics = nodeMetricsById.get(edge.target)
    const targetLatencyMs = targetMetrics?.host?.latencyMs ?? 0
    const latencySec = (targetLatencyMs + edge.config.pathIoLatencyMs) / 1000
    const activeConnections = currentRPS * latencySec
    const targetSaturationRatio = targetMetrics?.host?.saturationRatio ?? 0
    const isCongested = targetSaturationRatio > EDGE_CONGESTION_THRESHOLD

    const descriptors = [
      buildEdgeRateDescriptor({ currentRPS, averagePayloadSizeKB: payloadKB, currentMBps }),
      buildEdgeConnectionsDescriptor({ currentRPS, latencySec, activeConnections }),
    ]
    if (targetMetrics?.host) descriptors.push(buildEdgeCongestionDescriptor({ targetSaturationRatio, isCongested }))
    validateFormulaDescriptorsHaveSources(descriptors)

    edgeMetricsById.set(edgeId, {
      throughputPerSec: currentRPS,
      sim: { currentRPS, currentMBps, activeConnections, isCongested },
      formulaDescriptors: descriptors,
    })
  }

  const nextQueueBacklogGB = new Map<string, number>()
  const nextReplicaRuntimeByNode = new Map<string, ReplicaRuntime>()
  for (const [nodeId, sim] of graph.simByNode) {
    const model = registry.resolve(sim)
    if (!model) continue
    const state = nextStateByNode.get(nodeId)
    if (model.id === 'queue') {
      nextQueueBacklogGB.set(nodeId, typeof state === 'number' && Number.isFinite(state) ? state : 0)
    }
    if (model.id === 'saturating_host' && state && typeof state === 'object') {
      nextReplicaRuntimeByNode.set(nodeId, state as ReplicaRuntime)
    }
  }

  return { nodeMetricsById, edgeMetricsById, nextStateByNode, nextQueueBacklogGB, nextReplicaRuntimeByNode }
}
