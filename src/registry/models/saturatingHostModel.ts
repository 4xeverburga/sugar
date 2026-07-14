import { edgeTrafficShare } from '../../components.js'
import { computeHostMetrics, calculatedCapacityRPS, hostKneeRPS } from '../../hostModel.js'
import {
  createReplicaRuntime,
  drainBootQueue,
  effectiveReplicas,
  evaluateScaling,
  evictCollapsedReplicas,
  restoreMinReplicaFloor,
  type ReplicaRuntime,
} from '../../autoscaler.js'
import {
  buildHostCapacityDescriptor,
  buildHostCollapseDescriptor,
  buildHostLatencyDescriptor,
  buildHostReplicaEvictionDescriptor,
  buildHostSaturationDescriptor,
  buildHostShedDescriptor,
  buildReplicaDivisionDescriptor,
  buildScalingPolicyDescriptor,
  validateFormulaDescriptorsHaveSources,
} from '../../formulaCatalog.js'
import type { HostNodeMetrics, HostNodeSim } from '../../ports.js'
import type { NodeModel, Result } from '../nodeModel.js'

type SaturatingHostSim = Extract<HostNodeSim, { profile: 'transactional_api' | 'worker_consumer' | 'database_server' }>

function isSaturatingHost(raw: unknown): raw is SaturatingHostSim {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: string }).kind === 'host' &&
    ((raw as { profile?: string }).profile === 'transactional_api' ||
      (raw as { profile?: string }).profile === 'worker_consumer' ||
      (raw as { profile?: string }).profile === 'database_server')
  )
}

function validateSaturatingHost(raw: unknown): Result<SaturatingHostSim> {
  if (!isSaturatingHost(raw)) return { ok: false, message: 'SUGAR: saturating host config is invalid.' }
  if (raw.minReplicas < 1 || raw.maxReplicas < raw.minReplicas) {
    return { ok: false, message: 'SUGAR: replica bounds are invalid.' }
  }
  if (raw.bootDelayMs < 0) return { ok: false, message: 'SUGAR: bootDelayMs must be >= 0.' }
  if (raw.lowWatermark < 0 || raw.highWatermark < 0 || raw.lowWatermark >= raw.highWatermark) {
    return { ok: false, message: 'SUGAR: watermark bounds are invalid.' }
  }
  if (raw.configMode === 'manual') {
    if (raw.manualBaselineLatencyMs < 0 || raw.manualSaturationRPS < 0 || raw.manualMaxRPS < raw.manualSaturationRPS) {
      return { ok: false, message: 'SUGAR: manual host parameters are invalid.' }
    }
  } else if (raw.cpuProcessingTimeMs < 0 || raw.maxWorkerThreads < 0) {
    return { ok: false, message: 'SUGAR: calculated host parameters are invalid.' }
  }
  return { ok: true, value: raw }
}

function toRuntime(state: unknown, minReplicas: number): ReplicaRuntime {
  if (
    typeof state === 'object' &&
    state !== null &&
    typeof (state as { nominalCount?: unknown }).nominalCount === 'number' &&
    Array.isArray((state as { booting?: unknown }).booting)
  ) {
    return state as ReplicaRuntime
  }
  return createReplicaRuntime(minReplicas)
}

function hostCapacityRPS(sim: SaturatingHostSim): number {
  if (sim.configMode === 'manual') return Math.max(0, sim.manualSaturationRPS)
  return calculatedCapacityRPS(sim.cpuProcessingTimeMs, sim.maxWorkerThreads)
}

export const saturatingHostModel: NodeModel<SaturatingHostSim, ReplicaRuntime> = {
  id: 'saturating_host',
  label: 'Saturating Host',
  paramSchema: {
    params: [
      { name: 'minReplicas', type: 'number', min: 1 },
      { name: 'maxReplicas', type: 'number', min: 1 },
      { name: 'bootDelayMs', type: 'number', min: 0, unit: 'ms' },
      { name: 'highWatermark', type: 'number', min: 0 },
      { name: 'lowWatermark', type: 'number', min: 0 },
    ],
  },
  formulaDescriptors: [],
  validateConfig: validateSaturatingHost,
  initialState(config) {
    return createReplicaRuntime(config.minReplicas)
  },
  reconcileState(input) {
    const runtimeIn = toRuntime(input.previousState, input.config.minReplicas)
    const drainedRaw = drainBootQueue(runtimeIn, input.simTimeMs)
    return restoreMinReplicaFloor(drainedRaw, input.config.minReplicas, input.config.bootDelayMs, input.simTimeMs)
  },
  acceptCapacityRPS(config, state) {
    const effective = effectiveReplicas(state)
    if (config.configMode === 'manual') return Math.max(0, config.manualMaxRPS) * effective
    return Number.POSITIVE_INFINITY
  },
  computeWindow(ctx) {
    let weightedMultiplierSum = 0
    for (const edgeId of ctx.incomingEdgeIds) {
      const edge = ctx.graph.edgeById.get(edgeId)
      weightedMultiplierSum += (ctx.edgeOutputRPS.get(edgeId) ?? 0) * (edge?.config.targetComputeWeightMultiplier ?? 1)
    }
    const inboundWeightedComputeMultiplier = ctx.incomingRPS > 0 ? weightedMultiplierSum / ctx.incomingRPS : 1

    let outboundIoWeightSum = 0
    let outboundIoLatencySum = 0
    for (const edgeId of ctx.outgoingEdgeIds) {
      const edge = ctx.graph.edgeById.get(edgeId)
      const share = edgeTrafficShare(edge)
      outboundIoWeightSum += share
      outboundIoLatencySum += share * (edge?.config.pathIoLatencyMs ?? 0)
    }
    const outboundWeightedIoLatencyMs = outboundIoWeightSum > 0 ? outboundIoLatencySum / outboundIoWeightSum : 0

    const drained = toRuntime(ctx.prevState, ctx.config.minReplicas)
    const effective = effectiveReplicas(drained)
    const scalerEnabled = ctx.config.minReplicas !== ctx.config.maxReplicas
    const metrics = computeHostMetrics({
      sim: ctx.config,
      incomingRPS: ctx.incomingRPS,
      effectiveReplicas: effective,
      isElasticGroup: scalerEnabled,
      inboundWeightedComputeMultiplier,
      outboundWeightedIoLatencyMs,
    })

    const edgeOutputRPS = new Map<string, number>()
    for (const edgeId of ctx.outgoingEdgeIds) {
      edgeOutputRPS.set(edgeId, metrics.forwardedRPS * edgeTrafficShare(ctx.graph.edgeById.get(edgeId)))
    }

    const postEviction =
      ctx.config.overloadBehavior === 'collapse' && scalerEnabled
        ? evictCollapsedReplicas(drained, metrics.saturationRatio, effective)
        : drained

    const decision =
      scalerEnabled
        ? evaluateScaling({
            runtime: postEviction,
            perReplicaSaturation: metrics.saturationRatio,
            simTimeMs: ctx.simTimeMs,
            windowSizeMs: ctx.windowSizeMs,
            minReplicas: ctx.config.minReplicas,
            maxReplicas: ctx.config.maxReplicas,
            bootDelayMs: ctx.config.bootDelayMs,
            highWatermark: ctx.config.highWatermark,
            lowWatermark: ctx.config.lowWatermark,
          })
        : { runtime: postEviction, event: undefined }
    void decision.event

    const hostMetrics: HostNodeMetrics = {
      ...metrics,
      replicas: {
        nominalCount: decision.runtime.nominalCount,
        bootingCount: decision.runtime.booting.length,
        effectiveCount: effectiveReplicas(decision.runtime),
        perReplicaSaturation: metrics.saturationRatio,
        events: decision.runtime.events,
      },
    }

    const capacityRPS = hostCapacityRPS(ctx.config)
    const perReplicaIncomingRPS = ctx.incomingRPS / Math.max(1, effective)
    const descriptors = [
      buildHostSaturationDescriptor({
        incomingRPS: perReplicaIncomingRPS,
        capacityRPS,
        saturationRatio: metrics.saturationRatio,
      }),
      buildHostLatencyDescriptor({
        baseLatencyMs:
          ctx.config.configMode === 'manual' ? ctx.config.manualBaselineLatencyMs : ctx.config.cpuProcessingTimeMs + outboundWeightedIoLatencyMs,
        saturationRatio: metrics.saturationRatio,
        latencyMs: metrics.latencyMs,
      }),
      buildReplicaDivisionDescriptor({
        incomingRPS: ctx.incomingRPS,
        effectiveCount: effective,
        perReplicaRPS: perReplicaIncomingRPS,
      }),
      buildScalingPolicyDescriptor({
        perReplicaSaturation: metrics.saturationRatio,
        highWatermark: ctx.config.highWatermark,
        lowWatermark: ctx.config.lowWatermark,
        nominalCount: decision.runtime.nominalCount,
        minReplicas: ctx.config.minReplicas,
        maxReplicas: ctx.config.maxReplicas,
      }),
    ]

    if (ctx.config.configMode === 'calculated') {
      descriptors.push(
        buildHostCapacityDescriptor({
          maxWorkerThreads: ctx.config.maxWorkerThreads,
          cpuProcessingTimeMs: ctx.config.cpuProcessingTimeMs,
          capacityRPS,
        }),
      )
    } else {
      descriptors.push(
        buildHostShedDescriptor({
          incomingRPS: perReplicaIncomingRPS,
          manualMaxRPS: ctx.config.manualMaxRPS,
          shedRPS: metrics.shedRPS / Math.max(1, effective),
        }),
      )
    }

    if (ctx.config.overloadBehavior === 'collapse' && !scalerEnabled) {
      const kneeRPS = hostKneeRPS(ctx.config, inboundWeightedComputeMultiplier)
      const perReplicaForwardedRPS = metrics.forwardedRPS / Math.max(1, effective)
      const overloadRatio = kneeRPS > 0 ? perReplicaIncomingRPS / kneeRPS : 0
      descriptors.push(
        buildHostCollapseDescriptor({
          incomingRPS: perReplicaIncomingRPS,
          kneeRPS,
          overloadRatio,
          forwardedRPS: perReplicaForwardedRPS,
        }),
      )
    } else if (ctx.config.overloadBehavior === 'collapse' && scalerEnabled) {
      descriptors.push(
        buildHostReplicaEvictionDescriptor({
          perReplicaSaturation: metrics.saturationRatio,
          effectiveReplicas: effective,
          evictedReplicas: Math.max(0, drained.nominalCount - postEviction.nominalCount),
        }),
      )
    }

    validateFormulaDescriptorsHaveSources(descriptors)

    return {
      metrics: {
        throughputPerSec: metrics.forwardedRPS,
        queueDepth: 0,
        host: hostMetrics,
        formulaDescriptors: descriptors,
      },
      nextState: decision.runtime,
      edgeOutputRPS,
    }
  },
}
