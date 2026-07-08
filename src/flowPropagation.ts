// Per-window deterministic flow propagation over the simulated DAG
// (research.md D1/D5): client pools emit, each outbound edge carries its
// own independent trafficShareRatio of the source's output (NOT
// normalized across siblings — a source's edges may sum to more than 1,
// modeling sequential/parallel fan-out to multiple downstream services;
// see edgeTrafficShare in components.ts), hosts compute saturation/
// latency/shedding, queues integrate backlog, and every metric ships a
// sourced FormulaDescriptor (constitution II). Pure — no engine state
// beyond what's threaded through as arguments — so a full window can be
// exercised directly in tests without the DES event loop.

import { EDGE_CONGESTION_THRESHOLD, KB_PER_MB } from './config'
import { edgeTrafficShare, type TopologyGraph } from './components'
import { calculatedCapacityRPS, computeClientPoolMetrics, computeExternalApiMetrics, computeHostMetrics, hostKneeRPS } from './hostModel'
import { computeQueueMetrics } from './queueModel'
import { createReplicaRuntime, drainBootQueue, effectiveReplicas, evaluateScaling, evictCollapsedReplicas, restoreMinReplicaFloor, type ReplicaRuntime } from './autoscaler'
import {
  buildEdgeCongestionDescriptor,
  buildEdgeConnectionsDescriptor,
  buildEdgeRateDescriptor,
  buildHostCapacityDescriptor,
  buildHostCollapseDescriptor,
  buildHostLatencyDescriptor,
  buildHostReplicaEvictionDescriptor,
  buildHostSaturationDescriptor,
  buildHostShedDescriptor,
  buildQueueBacklogDescriptor,
  buildReplicaDivisionDescriptor,
  buildScalingPolicyDescriptor,
  validateFormulaDescriptorsHaveSources,
} from './formulaCatalog'
import type { EdgeMetrics, HostNodeMetrics, HostNodeSim, HostReplicaTelemetry, NodeMetrics, NodeSim } from './ports'

export interface FlowPropagationInput {
  graph: TopologyGraph
  windowSizeMs: number
  /** Windowed measured rate per client-pool node (from the Poisson-driven
   *  event queue's arrival count this window). */
  clientPoolMeasuredRPS: ReadonlyMap<string, number>
  /** Backlog carried over from the previous window, per queue node. */
  queueBacklogGB: ReadonlyMap<string, number>
  /** Autoscaler runtime carried over from the previous window, per scaled
   *  host (feature 013). Absent entries are created fresh at minReplicas. */
  replicaRuntimeByNode: ReadonlyMap<string, ReplicaRuntime>
  /** Current simulated time, for boot-delay/cooldown/sustain evaluation. */
  simTimeMs: number
}

export interface FlowPropagationOutput {
  nodeMetricsById: Map<string, NodeMetrics>
  edgeMetricsById: Map<string, EdgeMetrics>
  nextQueueBacklogGB: Map<string, number>
  /** Runtime to carry into the next window's propagateWindow call. */
  nextReplicaRuntimeByNode: Map<string, ReplicaRuntime>
}

function isHostSim(sim: NodeSim): sim is HostNodeSim {
  return sim.kind === 'host'
}

// The ρ=1 point (data-model.md), independent of any actual traffic.
function hostCapacityRPS(sim: HostNodeSim): number {
  if (sim.profile === 'client_pool' || sim.profile === 'external_api') return Number.POSITIVE_INFINITY
  if (sim.configMode === 'manual') return Math.max(0, sim.manualSaturationRPS)
  return calculatedCapacityRPS(sim.cpuProcessingTimeMs, sim.maxWorkerThreads)
}

// How much RPS this host can still accept before shedding (research.md
// D4/D6) — only manual mode has a hard cap; calculated mode and
// external_api never shed. `effectiveCount` scales a saturating profile's
// per-replica manualMaxRPS into a total cap (FR-011).
function hostAcceptCapacityRPS(sim: HostNodeSim, effectiveCount: number): number {
  if (sim.profile === 'client_pool') return 0
  if (sim.profile === 'external_api') return Number.POSITIVE_INFINITY
  if (sim.configMode === 'manual') return Math.max(0, sim.manualMaxRPS) * effectiveCount
  return Number.POSITIVE_INFINITY
}

function isSaturatingProfile(
  sim: HostNodeSim,
): sim is Extract<HostNodeSim, { profile: 'transactional_api' | 'worker_consumer' | 'database_server' }> {
  return sim.profile === 'transactional_api' || sim.profile === 'worker_consumer' || sim.profile === 'database_server'
}

export function propagateWindow(input: FlowPropagationInput): FlowPropagationOutput {
  const { graph, windowSizeMs } = input
  const shareOfEdge = (edgeId: string) => edgeTrafficShare(graph.edgeById.get(edgeId))
  const nodeMetricsById = new Map<string, NodeMetrics>()
  const edgeMetricsById = new Map<string, EdgeMetrics>()
  const edgeOutputRPS = new Map<string, number>()
  const nextQueueBacklogGB = new Map<string, number>(input.queueBacklogGB)
  const nextReplicaRuntimeByNode = new Map<string, ReplicaRuntime>()

  // Replica runtime is independent of this window's traffic (boot-delay/
  // cooldown/sustain timers depend only on simTimeMs), so every scaled
  // host's drained runtime and effective replica count can be resolved up
  // front — this is what lets a queue's outbound accept-capacity
  // (processed before its downstream host in topological order) already
  // see that host's current effective replica count (FR-011).
  const drainedRuntimeByNode = new Map<string, ReplicaRuntime>()
  const effectiveByNode = new Map<string, number>()
  for (const [nodeId, sim] of graph.simByNode) {
    if (sim.kind !== 'host' || !isSaturatingProfile(sim)) continue
    const runtimeIn = input.replicaRuntimeByNode.get(nodeId) ?? createReplicaRuntime(sim.minReplicas)
    const drainedRaw = drainBootQueue(runtimeIn, input.simTimeMs)
    // Restores nominalCount up to minReplicas (012-overload-collapse
    // refinement, research.md D9) — a no-op unless a PREVIOUS window's
    // collapse eviction (below) crashed nominalCount below the floor; see
    // restoreMinReplicaFloor's doc for why this runs here, one window
    // after the eviction that caused it, rather than in the same
    // evaluateScaling call.
    const drained = restoreMinReplicaFloor(drainedRaw, sim.minReplicas, sim.bootDelayMs, input.simTimeMs)
    drainedRuntimeByNode.set(nodeId, drained)
    effectiveByNode.set(nodeId, effectiveReplicas(drained))
  }

  for (const nodeId of graph.topologicalOrder) {
    const sim = graph.simByNode.get(nodeId)
    if (!sim) continue
    const incomingEdgeIds = graph.incomingEdgesByNode.get(nodeId) ?? []
    const outgoingEdgeIds = graph.outgoingEdgesByNode.get(nodeId) ?? []
    let incomingRPS = 0
    for (const edgeId of incomingEdgeIds) incomingRPS += edgeOutputRPS.get(edgeId) ?? 0

    if (sim.kind === 'queue') {
      let inflowMBps = 0
      for (const edgeId of incomingEdgeIds) {
        const edge = graph.edgeById.get(edgeId)
        const rps = edgeOutputRPS.get(edgeId) ?? 0
        inflowMBps += (rps * (edge?.config.averagePayloadSizeKB ?? 0)) / KB_PER_MB
      }

      const desiredByEdge = new Map<string, number>()
      let totalDesiredMBps = 0
      let hasUnboundedEdge = false
      for (const edgeId of outgoingEdgeIds) {
        const edge = graph.edgeById.get(edgeId)
        const targetSim = edge ? graph.simByNode.get(edge.target) : undefined
        const share = shareOfEdge(edgeId)
        const acceptRPS =
          targetSim && isHostSim(targetSim) && edge
            ? hostAcceptCapacityRPS(targetSim, effectiveByNode.get(edge.target) ?? 1)
            : Number.POSITIVE_INFINITY
        const desiredMBps = Number.isFinite(acceptRPS) ? (acceptRPS * share * (edge?.config.averagePayloadSizeKB ?? 0)) / KB_PER_MB : Number.POSITIVE_INFINITY
        desiredByEdge.set(edgeId, desiredMBps)
        if (!Number.isFinite(desiredMBps)) hasUnboundedEdge = true
        else totalDesiredMBps += desiredMBps
      }

      const queueResult = computeQueueMetrics({
        inflowMBps,
        desiredOutflowMBps: hasUnboundedEdge ? Number.POSITIVE_INFINITY : totalDesiredMBps,
        backlogGB: nextQueueBacklogGB.get(nodeId) ?? 0,
        windowSizeMs,
      })
      nextQueueBacklogGB.set(nodeId, queueResult.backlogGB)

      for (const edgeId of outgoingEdgeIds) {
        const edge = graph.edgeById.get(edgeId)
        const desired = desiredByEdge.get(edgeId) ?? 0
        const edgeShareOfOutflow = hasUnboundedEdge || totalDesiredMBps <= 0 ? shareOfEdge(edgeId) : desired / totalDesiredMBps
        const edgeMBps = queueResult.outflowMBps * edgeShareOfOutflow
        const payloadKB = edge?.config.averagePayloadSizeKB ?? 0
        edgeOutputRPS.set(edgeId, payloadKB > 0 ? (edgeMBps * KB_PER_MB) / payloadKB : 0)
      }

      const totalOutputRPS = outgoingEdgeIds.reduce((sum, edgeId) => sum + (edgeOutputRPS.get(edgeId) ?? 0), 0)
      const backlogDescriptor = buildQueueBacklogDescriptor(queueResult)
      validateFormulaDescriptorsHaveSources([backlogDescriptor])
      nodeMetricsById.set(nodeId, {
        throughputPerSec: totalOutputRPS,
        // Messages-equivalent backlog display, in MB units (data-model.md:
        // "queues: backlog in messages-equiv") — precise per-message count
        // isn't well-defined once a queue mixes edges of different payload
        // sizes, so MB is the closest well-defined proxy.
        queueDepth: queueResult.backlogGB * 1024,
        queue: { inflowMBps: queueResult.inflowMBps, outflowMBps: queueResult.outflowMBps, backlogGB: queueResult.backlogGB },
        formulaDescriptors: [backlogDescriptor],
      })
      continue
    }

    // Host node.
    if (sim.profile === 'client_pool') {
      const metrics = computeClientPoolMetrics(input.clientPoolMeasuredRPS.get(nodeId) ?? 0)
      for (const edgeId of outgoingEdgeIds) edgeOutputRPS.set(edgeId, metrics.forwardedRPS * shareOfEdge(edgeId))
      nodeMetricsById.set(nodeId, { throughputPerSec: metrics.forwardedRPS, queueDepth: 0, host: metrics, formulaDescriptors: [] })
      continue
    }

    if (sim.profile === 'external_api') {
      const metrics = computeExternalApiMetrics(incomingRPS, sim.manualBaselineLatencyMs)
      for (const edgeId of outgoingEdgeIds) edgeOutputRPS.set(edgeId, metrics.forwardedRPS * shareOfEdge(edgeId))
      nodeMetricsById.set(nodeId, { throughputPerSec: metrics.forwardedRPS, queueDepth: 0, host: metrics, formulaDescriptors: [] })
      continue
    }

    // transactional_api / worker_consumer / database_server (manual or calculated).
    let weightedMultiplierSum = 0
    for (const edgeId of incomingEdgeIds) {
      const edge = graph.edgeById.get(edgeId)
      weightedMultiplierSum += (edgeOutputRPS.get(edgeId) ?? 0) * (edge?.config.targetComputeWeightMultiplier ?? 1)
    }
    const inboundWeightedComputeMultiplier = incomingRPS > 0 ? weightedMultiplierSum / incomingRPS : 1

    let outboundIoWeightSum = 0
    let outboundIoLatencySum = 0
    for (const edgeId of outgoingEdgeIds) {
      const edge = graph.edgeById.get(edgeId)
      const share = shareOfEdge(edgeId)
      outboundIoWeightSum += share
      outboundIoLatencySum += share * (edge?.config.pathIoLatencyMs ?? 0)
    }
    const outboundWeightedIoLatencyMs = outboundIoWeightSum > 0 ? outboundIoLatencySum / outboundIoWeightSum : 0

    const drained = drainedRuntimeByNode.get(nodeId)!
    const effective = effectiveByNode.get(nodeId)!
    // Scaler enablement (feature 013, T016 US3 short-circuit) doubles, as
    // of the 012-overload-collapse refinement (research.md D9), as the
    // "is this an elastic scaling group" flag: when minReplicas ===
    // maxReplicas the scaler never runs at all (no accumulators, no
    // cooldown checks, no events, no eviction) — `drained` (whose
    // nominalCount is pinned at min = max, booting always empty) simply
    // carries forward unchanged, which is also what makes min=max=1
    // bit-identical to pre-013 behavior (SC-003), and what keeps a fixed
    // (non-elastic) multi-replica host on the original smooth retrograde
    // curve rather than the eviction mechanic below.
    const scalerEnabled = sim.minReplicas !== sim.maxReplicas
    const metrics = computeHostMetrics({
      sim,
      incomingRPS,
      effectiveReplicas: effective,
      isElasticGroup: scalerEnabled,
      inboundWeightedComputeMultiplier,
      outboundWeightedIoLatencyMs,
    })
    for (const edgeId of outgoingEdgeIds) edgeOutputRPS.set(edgeId, metrics.forwardedRPS * shareOfEdge(edgeId))

    // Collapse-mode replica eviction (012-overload-collapse refinement,
    // research.md D9): evaluated BEFORE the scale-up/down policy below, on
    // the same per-replica saturation this window's (already-fixed)
    // forwardedRPS was computed from — an overloaded replica "crashes"
    // immediately, independent of the sustain/cooldown-gated policy
    // decision that follows. No-ops for `clamp` hosts and non-elastic
    // hosts (evictCollapsedReplicas' own guard plus the check here).
    const postEviction =
      sim.overloadBehavior === 'collapse' && scalerEnabled ? evictCollapsedReplicas(drained, metrics.saturationRatio, effective) : drained

    const decision = scalerEnabled
      ? evaluateScaling({
          runtime: postEviction,
          perReplicaSaturation: metrics.saturationRatio,
          simTimeMs: input.simTimeMs,
          windowSizeMs,
          minReplicas: sim.minReplicas,
          maxReplicas: sim.maxReplicas,
          bootDelayMs: sim.bootDelayMs,
          highWatermark: sim.highWatermark,
          lowWatermark: sim.lowWatermark,
        })
      : { runtime: postEviction, event: undefined }
    nextReplicaRuntimeByNode.set(nodeId, decision.runtime)

    const replicas: HostReplicaTelemetry = {
      nominalCount: decision.runtime.nominalCount,
      bootingCount: decision.runtime.booting.length,
      effectiveCount: effectiveReplicas(decision.runtime),
      perReplicaSaturation: metrics.saturationRatio,
      events: decision.runtime.events,
    }
    const hostMetrics: HostNodeMetrics = { ...metrics, replicas }

    // capacityRPS is per-replica (config-declared); the saturation/latency
    // descriptors must show the SAME per-replica incoming rate that
    // actually produced metrics.saturationRatio (research.md D3 delta).
    const capacityRPS = hostCapacityRPS(sim)
    const perReplicaIncomingRPS = incomingRPS / Math.max(1, effective)
    const descriptors = [
      buildHostSaturationDescriptor({ incomingRPS: perReplicaIncomingRPS, capacityRPS, saturationRatio: metrics.saturationRatio }),
      buildHostLatencyDescriptor({
        baseLatencyMs: sim.configMode === 'manual' ? sim.manualBaselineLatencyMs : sim.cpuProcessingTimeMs + outboundWeightedIoLatencyMs,
        saturationRatio: metrics.saturationRatio,
        latencyMs: metrics.latencyMs,
      }),
      buildReplicaDivisionDescriptor({ incomingRPS, effectiveCount: effective, perReplicaRPS: perReplicaIncomingRPS }),
      buildScalingPolicyDescriptor({
        perReplicaSaturation: metrics.saturationRatio,
        highWatermark: sim.highWatermark,
        lowWatermark: sim.lowWatermark,
        nominalCount: decision.runtime.nominalCount,
        minReplicas: sim.minReplicas,
        maxReplicas: sim.maxReplicas,
      }),
    ]
    if (sim.configMode === 'calculated') {
      descriptors.push(buildHostCapacityDescriptor({ maxWorkerThreads: sim.maxWorkerThreads, cpuProcessingTimeMs: sim.cpuProcessingTimeMs, capacityRPS }))
    } else {
      descriptors.push(buildHostShedDescriptor({ incomingRPS: perReplicaIncomingRPS, manualMaxRPS: sim.manualMaxRPS, shedRPS: metrics.shedRPS / Math.max(1, effective) }))
    }
    // Feature 012 (US4): the collapse formula only appears for
    // overloadBehavior === 'collapse' hosts (research.md D7) — a
    // clamp-mode host's descriptor set is unchanged (SC-003 regression
    // extends to the formula panel). Non-elastic hosts show the retrograde
    // curve descriptor (unchanged); elastic hosts show the replica
    // eviction descriptor instead (research.md D9), since they never use
    // the retrograde curve.
    if (sim.overloadBehavior === 'collapse' && !scalerEnabled) {
      const kneeRPS = hostKneeRPS(sim, inboundWeightedComputeMultiplier)
      const perReplicaForwardedRPS = metrics.forwardedRPS / Math.max(1, effective)
      const overloadRatio = kneeRPS > 0 ? perReplicaIncomingRPS / kneeRPS : 0
      descriptors.push(
        buildHostCollapseDescriptor({ incomingRPS: perReplicaIncomingRPS, kneeRPS, overloadRatio, forwardedRPS: perReplicaForwardedRPS }),
      )
    } else if (sim.overloadBehavior === 'collapse' && scalerEnabled) {
      descriptors.push(
        buildHostReplicaEvictionDescriptor({
          perReplicaSaturation: metrics.saturationRatio,
          effectiveReplicas: effective,
          evictedReplicas: Math.max(0, drained.nominalCount - postEviction.nominalCount),
        }),
      )
    }
    validateFormulaDescriptorsHaveSources(descriptors)
    nodeMetricsById.set(nodeId, { throughputPerSec: metrics.forwardedRPS, queueDepth: 0, host: hostMetrics, formulaDescriptors: descriptors })
  }

  // Pass 2: edge telemetry, now that every node's metrics (including
  // downstream targets, regardless of topological position) are known.
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

  return { nodeMetricsById, edgeMetricsById, nextQueueBacklogGB, nextReplicaRuntimeByNode }
}
