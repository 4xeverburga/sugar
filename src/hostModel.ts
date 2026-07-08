// Host saturation/latency model (research.md D2/D3/D6). Pure functions —
// no engine state — so every operating point is directly unit-testable
// (constitution VI) without exercising the whole simulation loop.

import { HOST_COLLAPSE_DEAD_SATURATION_RATIO, HOST_COLLAPSE_DECAY_KAPPA, HOST_COLLAPSE_STATUS_RATIO, HOST_RHO_CLAMP, HOST_SATURATION_THRESHOLD, HOST_ZERO_CAPACITY_EPSILON } from './config'
import type { HostNodeMetrics, HostNodeSim } from './ports'

/** Inputs a per-window flow pass (flowPropagation.ts) must supply beyond
 *  the host's own static config. */
export interface HostComputeInput {
  sim: Extract<HostNodeSim, { profile: 'transactional_api' | 'worker_consumer' | 'database_server' }>
  incomingRPS: number
  /** effectiveReplicas from the autoscaler runtime (feature 013,
   *  research.md D3) — the divisor host math runs on. Usually ≥ 1; a host
   *  with minReplicas = maxReplicas = 1 passes 1 here and this function's
   *  output is bit-identical to pre-013 behavior (SC-003). Can be 0 for an
   *  elastic collapse-mode host whose replicas have all been evicted
   *  (012-overload-collapse refinement, research.md D9) — see the
   *  isElasticGroup doc below. */
  effectiveReplicas: number
  /** Whether the scaler is enabled for this host (`minReplicas !==
   *  maxReplicas`, 012-overload-collapse refinement, research.md D9).
   *  Changes what `overloadBehavior === 'collapse'` means: non-elastic
   *  hosts (false) keep the smooth per-replica retrograde-decay curve
   *  (unchanged from this feature's original design — there's no group to
   *  evict from); elastic hosts (true) instead behave like `clamp` while
   *  replicas are alive, with autoscaler.ts evicting overloaded replicas
   *  outside this function. When `effectiveReplicas` is 0 for an elastic
   *  collapse host, this function reports the host as fully dead —
   *  forwards nothing, sheds everything. */
  isElasticGroup: boolean
  /** Traffic-weighted mean of inbound edges' targetComputeWeightMultiplier
   *  (calculated mode only; research.md D3). */
  inboundWeightedComputeMultiplier: number
  /** Traffic-weighted mean of outbound edges' pathIoLatencyMs (calculated
   *  mode only; research.md D3). */
  outboundWeightedIoLatencyMs: number
}

// The M/M/1 residence-time-scaling hockey stick (research.md D2): applied
// continuously from ρ=0, no threshold gate. rho is clamped to
// HOST_RHO_CLAMP before it ever reaches this formula so the curve never
// divides by (1 - 1) = 0.
export function hockeyStickLatencyMs(baseLatencyMs: number, rho: number): number {
  const clamped = Math.min(Math.max(rho, 0), HOST_RHO_CLAMP)
  return baseLatencyMs * (1 + clamped / (1 - clamped))
}

function deriveStatus(input: {
  rho: number
  incomingRPS: number
  hardCapRPS: number | undefined
  overloadBehavior: 'clamp' | 'collapse'
  isElasticGroup: boolean
  kneeRPS: number
  forwardedRPS: number
}): HostNodeMetrics['status'] {
  const { rho, incomingRPS, hardCapRPS, overloadBehavior, isElasticGroup, kneeRPS, forwardedRPS } = input
  // Checked first (research.md D5), non-elastic hosts only (research.md
  // D9): incomingRPS > kneeRPS already implies rho >= 1, so the existing
  // overloaded/saturated/healthy ladder below would otherwise report
  // 'overloaded' before this material-degradation signal is ever
  // surfaced. Elastic collapse hosts never report 'collapsed' from here —
  // while replicas are alive they behave like clamp (this ladder handles
  // them below); 'collapsed' for an elastic host is reported only by
  // computeHostMetrics's zero-effective-replicas branch.
  if (overloadBehavior === 'collapse' && !isElasticGroup && incomingRPS > kneeRPS && forwardedRPS < kneeRPS * HOST_COLLAPSE_STATUS_RATIO) {
    return 'collapsed'
  }
  const offeredLoadExceedsCap = hardCapRPS !== undefined && incomingRPS > hardCapRPS
  if (offeredLoadExceedsCap || rho >= 1) return 'overloaded'
  if (rho >= HOST_SATURATION_THRESHOLD) return 'saturated'
  return 'healthy'
}

// Shared retrograde-collapse curve (research.md D2/D3, data-model.md), used
// by both manual and calculated modes when overloadBehavior === 'collapse'.
// Pure function of incomingRPS/kneeRPS only — no state (FR-010), so every
// operating point (and a sweep up then back down) is directly assertable.
export function collapseForwardedRPS(incomingRPS: number, kneeRPS: number): number {
  if (kneeRPS <= HOST_ZERO_CAPACITY_EPSILON) return 0
  if (incomingRPS <= kneeRPS) return incomingRPS
  const overloadRatio = incomingRPS / kneeRPS
  return kneeRPS / (1 + HOST_COLLAPSE_DECAY_KAPPA * (overloadRatio - 1) ** 2)
}

/** client_pool: a traffic source, not a saturating host — it emits its
 *  configured rate and never itself saturates. */
export function computeClientPoolMetrics(requestRatePerSec: number): HostNodeMetrics {
  const rate = Math.max(0, requestRatePerSec)
  return {
    incomingRPS: 0,
    forwardedRPS: rate,
    shedRPS: 0,
    saturationRatio: 0,
    latencyMs: 0,
    status: 'healthy',
  }
}

/** external_api: bottomless — ρ=0 always, forwards everything, never sheds
 *  (research.md summary of D2/D6 applied to this profile). */
export function computeExternalApiMetrics(incomingRPS: number, manualBaselineLatencyMs: number): HostNodeMetrics {
  const incoming = Math.max(0, incomingRPS)
  return {
    incomingRPS: incoming,
    forwardedRPS: incoming,
    shedRPS: 0,
    saturationRatio: 0,
    latencyMs: Math.max(0, manualBaselineLatencyMs),
    status: 'healthy',
  }
}

/** Manual mode (research.md D1/D3/D6): ρ = incomingRPS / manualSaturationRPS;
 *  the knee is manualMaxRPS (research.md D1 — the point 011's clamp
 *  shedding already keys off, not manualSaturationRPS). `clamp` keeps the
 *  unchanged hard-clamp-and-shed behavior (SC-003 regression); `collapse`
 *  on a non-elastic host routes forwardedRPS through the shared
 *  retrograde curve instead; `collapse` on an elastic host behaves like
 *  `clamp` while its replicas are alive (research.md D9) — overload is
 *  instead resolved by autoscaler.ts evicting replicas, outside this
 *  function. */
function computeManualMetrics(
  sim: Extract<HostNodeSim, { configMode: 'manual' }>,
  incomingRPS: number,
  isElasticGroup: boolean,
): HostNodeMetrics {
  const incoming = Math.max(0, incomingRPS)
  const saturationCapacity = Math.max(0, sim.manualSaturationRPS)
  const rho = saturationCapacity > 0 ? incoming / saturationCapacity : 0
  const kneeRPS = Math.max(0, sim.manualMaxRPS)
  const usesRetrogradeCurve = sim.overloadBehavior === 'collapse' && !isElasticGroup
  const forwardedRPS = usesRetrogradeCurve ? collapseForwardedRPS(incoming, kneeRPS) : Math.min(incoming, kneeRPS)
  const shedRPS = Math.max(0, incoming - forwardedRPS)
  return {
    incomingRPS: incoming,
    forwardedRPS,
    shedRPS,
    saturationRatio: rho,
    latencyMs: hockeyStickLatencyMs(Math.max(0, sim.manualBaselineLatencyMs), rho),
    status: deriveStatus({ rho, incomingRPS: incoming, hardCapRPS: kneeRPS, overloadBehavior: sim.overloadBehavior, isElasticGroup, kneeRPS, forwardedRPS }),
  }
}

/** Calculated mode (research.md D1/D3): capacityRPS = maxWorkerThreads /
 *  (cpuProcessingTimeMs / 1000); ρ weighted by the traffic-weighted mean
 *  inbound compute multiplier; base latency = cpuProcessingTimeMs plus the
 *  traffic-weighted mean outbound pathIoLatencyMs. No maxRPS parameter
 *  exists in this mode, so an ORDINARY (non-elastic) `clamp` host never
 *  sheds (011/013 regression, SC-003); `collapse` on a non-elastic host
 *  sheds past ρ=1 for the first time, via the same shared retrograde
 *  curve as manual mode, keyed off the weight-adjusted knee (research.md
 *  D1: the incomingRPS at which the unclamped rho above would read
 *  exactly 1.0). `collapse` on an ELASTIC host plateaus at kneeRPS
 *  (sheds the excess, like manual mode's clamp) while replicas are
 *  alive — overload past that point is resolved by replica eviction
 *  instead (research.md D9; fixed post-D9, this file previously forwarded
 *  100% of offered load here, contradicting D9's own "plateau" design). */
function computeCalculatedMetrics(
  sim: Extract<HostNodeSim, { configMode: 'calculated' }>,
  incomingRPS: number,
  inboundWeightedComputeMultiplier: number,
  outboundWeightedIoLatencyMs: number,
  isElasticGroup: boolean,
): HostNodeMetrics {
  const incoming = Math.max(0, incomingRPS)
  const threads = Math.max(0, sim.maxWorkerThreads)
  const cpuTimeSec = Math.max(0, sim.cpuProcessingTimeMs) / 1000
  const capacityRPS = threads > 0 && cpuTimeSec > 0 ? threads / cpuTimeSec : 0
  const weight = Math.max(0, inboundWeightedComputeMultiplier)
  const rho = threads > 0 ? (incoming * weight * cpuTimeSec) / threads : incoming > 0 ? incoming / HOST_ZERO_CAPACITY_EPSILON : 0
  const baseLatencyMs = Math.max(0, sim.cpuProcessingTimeMs) + Math.max(0, outboundWeightedIoLatencyMs)
  const kneeRPS = threads > 0 && cpuTimeSec > 0 && weight > 0 ? threads / (weight * cpuTimeSec) : 0
  const usesRetrogradeCurve = sim.overloadBehavior === 'collapse' && !isElasticGroup
  // An elastic collapse-mode group plateaus (research.md D9: "behaves
  // exactly like clamp") while its replicas are alive — that means a hard
  // cap at kneeRPS with the excess SHED, same as manual mode's clamp
  // below, not "forward everything" (which is calculated mode's ORDINARY
  // clamp behavior — no maxRPS parameter exists there, so a non-elastic
  // clamp host never sheds, research.md D6). Gating this cap on
  // isElasticGroup alone (not on overloadBehavior) would incorrectly cap
  // an ordinary fixed-replica clamp host too, so it stays scoped to the
  // collapse-mode elastic case specifically.
  const usesElasticPlateau = sim.overloadBehavior === 'collapse' && isElasticGroup
  const forwardedRPS = usesRetrogradeCurve ? collapseForwardedRPS(incoming, kneeRPS) : usesElasticPlateau ? Math.min(incoming, kneeRPS) : incoming
  const shedRPS = Math.max(0, incoming - forwardedRPS)
  void capacityRPS
  return {
    incomingRPS: incoming,
    forwardedRPS,
    shedRPS,
    saturationRatio: rho,
    latencyMs: hockeyStickLatencyMs(baseLatencyMs, rho),
    status: deriveStatus({ rho, incomingRPS: incoming, hardCapRPS: undefined, overloadBehavior: sim.overloadBehavior, isElasticGroup, kneeRPS, forwardedRPS }),
  }
}

/** capacityRPS for a calculated-mode host at weight-1.0 traffic
 *  (research.md D3) — exposed separately for the formula catalog and the
 *  Inspector's calculated-mode summary. */
export function calculatedCapacityRPS(cpuProcessingTimeMs: number, maxWorkerThreads: number): number {
  const threads = Math.max(0, maxWorkerThreads)
  const cpuTimeSec = Math.max(0, cpuProcessingTimeMs) / 1000
  return threads > 0 && cpuTimeSec > 0 ? threads / cpuTimeSec : 0
}

/** The knee (research.md D1) — the incomingRPS past which a saturating
 *  host's offered load exceeds its capacity: manualMaxRPS in manual mode
 *  (the point 011's clamp shedding already keyed off); the weight-adjusted
 *  rho=1 point in calculated mode. Exported so flowPropagation.ts's
 *  collapse formula descriptor (US4) reports the same value the metrics
 *  computation above used internally. */
export function hostKneeRPS(
  sim: Extract<HostNodeSim, { profile: 'transactional_api' | 'worker_consumer' | 'database_server' }>,
  inboundWeightedComputeMultiplier: number,
): number {
  if (sim.configMode === 'manual') return Math.max(0, sim.manualMaxRPS)
  const threads = Math.max(0, sim.maxWorkerThreads)
  const cpuTimeSec = Math.max(0, sim.cpuProcessingTimeMs) / 1000
  const weight = Math.max(0, inboundWeightedComputeMultiplier)
  return threads > 0 && cpuTimeSec > 0 && weight > 0 ? threads / (weight * cpuTimeSec) : 0
}

// Per-replica division by composition (research.md D3): 011's manual/
// calculated math runs unchanged on perReplicaRPS = incomingRPS /
// effectiveReplicas (so ρ/latency/status are PER REPLICA, matching
// data-model.md's 013 delta), then forwardedRPS/shedRPS scale back up by
// effectiveReplicas so the per-replica manualMaxRPS clamp composes into a
// total cap of effectiveReplicas × manualMaxRPS (FR-003/FR-011).
export function computeHostMetrics(input: HostComputeInput): HostNodeMetrics {
  const { sim, incomingRPS, effectiveReplicas, isElasticGroup, inboundWeightedComputeMultiplier, outboundWeightedIoLatencyMs } = input
  const incoming = Math.max(0, incomingRPS)

  // Elastic collapse-mode host with zero currently-serving replicas
  // (012-overload-collapse refinement, research.md D9): every replica has
  // been evicted (autoscaler.ts's evictCollapsedReplicas) and none have
  // finished booting yet — the host is "virtually dead": it forwards
  // nothing and sheds everything offered to it, rather than the
  // Math.max(1, effectiveReplicas) floor below silently treating 0
  // replicas as 1 replica's worth of capacity. latencyMs still reports the
  // finite HOST_RHO_CLAMP ceiling (constitution VI: never NaN/Infinity) —
  // what an indefinitely-queued caller would observe. Recovery is entirely
  // the scaler's job (the min-replicas floor restore in evaluateScaling),
  // not this stateless function's (FR-010).
  if (isElasticGroup && sim.overloadBehavior === 'collapse' && effectiveReplicas <= 0) {
    const baseLatencyMs = sim.configMode === 'manual' ? Math.max(0, sim.manualBaselineLatencyMs) : Math.max(0, sim.cpuProcessingTimeMs) + Math.max(0, outboundWeightedIoLatencyMs)
    return {
      incomingRPS: incoming,
      forwardedRPS: 0,
      shedRPS: incoming,
      saturationRatio: incoming > 0 ? HOST_COLLAPSE_DEAD_SATURATION_RATIO : 0,
      latencyMs: hockeyStickLatencyMs(baseLatencyMs, HOST_RHO_CLAMP),
      status: 'collapsed',
    }
  }

  const replicas = Math.max(1, effectiveReplicas)
  const perReplicaRPS = incoming / replicas
  const perReplica =
    sim.configMode === 'manual'
      ? computeManualMetrics(sim, perReplicaRPS, isElasticGroup)
      : computeCalculatedMetrics(sim, perReplicaRPS, inboundWeightedComputeMultiplier, outboundWeightedIoLatencyMs, isElasticGroup)
  return {
    ...perReplica,
    incomingRPS: incoming,
    forwardedRPS: perReplica.forwardedRPS * replicas,
    shedRPS: perReplica.shedRPS * replicas,
  }
}
