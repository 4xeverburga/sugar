// Pure autoscaler policy for saturating host profiles (data-model.md
// ReplicaRuntime/"Scaler decision"; research.md D1/D2/D7). Every function
// here is a pure transform of explicit state — no engine-wide state lives
// in this module — so every operating point (sustain accumulation,
// watermark crossing, cooldown, boot-queue draining, bounds re-clamp) is
// directly unit-testable (constitution VI) and deterministic (FR-008).

import { AUTOSCALE_COOLDOWN_MS, AUTOSCALE_SUSTAIN_MS, SCALING_EVENT_HISTORY_LIMIT } from './config.js'
import type { ScalingEvent } from './ports.js'

/** Per-host, cross-window scaler state (data-model.md). */
export interface ReplicaRuntime {
  /** Scaler-managed; initialized to minReplicas; always in [min, max]. */
  nominalCount: number
  /** FIFO of replicas added but not yet serving (research.md D2). */
  booting: { readyAtSimTimeMs: number }[]
  /** Sustain accumulators (research.md D1) — reset whenever saturation
   *  re-enters the hysteresis band. */
  timeAboveHighMs: number
  timeBelowLowMs: number
  /** Cooldown anchor; undefined until the first action ever fires. */
  lastActionSimTimeMs: number | undefined
  /** Bounded ring, most recent last. */
  events: ScalingEvent[]
}

/** Fresh runtime for a host at load/reset time (FR-014): starts serving at
 *  minReplicas with no booting entries, accumulators, or history. */
export function createReplicaRuntime(minReplicas: number): ReplicaRuntime {
  return {
    nominalCount: minReplicas,
    booting: [],
    timeAboveHighMs: 0,
    timeBelowLowMs: 0,
    lastActionSimTimeMs: undefined,
    events: [],
  }
}

/** Drains booting entries whose boot delay has elapsed by `simTimeMs` —
 *  called at the start of each window, before that window's host math
 *  runs (research.md D2), so a replica that just finished booting
 *  contributes capacity starting this window. */
export function drainBootQueue(runtime: ReplicaRuntime, simTimeMs: number): ReplicaRuntime {
  const stillBooting = runtime.booting.filter((entry) => entry.readyAtSimTimeMs > simTimeMs)
  if (stillBooting.length === runtime.booting.length) return runtime
  return { ...runtime, booting: stillBooting }
}

/** Restores `nominalCount` up to `minReplicas` (012-overload-collapse
 *  refinement, research.md D9) — called once per window, alongside
 *  `drainBootQueue`, BEFORE that window's host math/eviction runs. Only
 *  reachable via `evictCollapsedReplicas` below (every other path already
 *  keeps `nominalCount` within bounds), so this is a no-op for every host
 *  that isn't mid-collapse. Deliberately a separate, later window's step
 *  rather than folded into the same `evaluateScaling` call an eviction
 *  happened in: that lets a fully-crashed window's telemetry genuinely
 *  read `nominalCount = 0` for at least one window (the spec's "a scaling
 *  group with 0 nodes for some momentos") before this restores the floor
 *  on the next one. Queues fresh booting entries (real `bootDelayMs`
 *  latency) rather than serving immediately — replacing a crashed
 *  instance still takes as long as booting any other one — and bypasses
 *  cooldown/sustain entirely: it's an unconditional floor guarantee (real
 *  orchestrators replace a crashed instance immediately, they don't wait
 *  out an HPA cooldown), not a load-gated policy decision. */
export function restoreMinReplicaFloor(runtime: ReplicaRuntime, minReplicas: number, bootDelayMs: number, simTimeMs: number): ReplicaRuntime {
  if (runtime.nominalCount >= minReplicas) return runtime
  const deficit = minReplicas - runtime.nominalCount
  const readyAtSimTimeMs = simTimeMs + bootDelayMs
  const newBootingEntries = Array.from({ length: deficit }, () => ({ readyAtSimTimeMs }))
  const event: ScalingEvent = { direction: 'up', newCount: minReplicas, simTimeMs }
  return {
    ...runtime,
    nominalCount: minReplicas,
    booting: [...runtime.booting, ...newBootingEntries],
    events: appendEvent(runtime.events, event),
  }
}

/** effectiveReplicas = nominalCount − booting.length (data-model.md) — the
 *  capacity divisor host math actually uses. Never below 1 in practice:
 *  the first replica of any host is created already serving and is never
 *  put in the booting queue. */
export function effectiveReplicas(runtime: ReplicaRuntime): number {
  return runtime.nominalCount - runtime.booting.length
}

function appendEvent(events: ScalingEvent[], event: ScalingEvent): ScalingEvent[] {
  const next = [...events, event]
  return next.length > SCALING_EVENT_HISTORY_LIMIT ? next.slice(next.length - SCALING_EVENT_HISTORY_LIMIT) : next
}

function cooldownElapsed(runtime: ReplicaRuntime, simTimeMs: number): boolean {
  return runtime.lastActionSimTimeMs === undefined || simTimeMs - runtime.lastActionSimTimeMs >= AUTOSCALE_COOLDOWN_MS
}

export interface ScalingDecisionInput {
  /** Runtime AFTER this window's drainBootQueue call. */
  runtime: ReplicaRuntime
  /** This window's per-replica saturation ratio (already computed from
   *  the effective count post-drain). */
  perReplicaSaturation: number
  simTimeMs: number
  windowSizeMs: number
  minReplicas: number
  maxReplicas: number
  /** User-declared capability parameter (feature 013, promoted from an
   *  internal tunable — constitution v3.2.0): simulated ms a newly-added
   *  replica takes before it serves traffic. */
  bootDelayMs: number
  /** Per-replica saturation ratio above which the scaler accumulates
   *  toward a scale-up (feature 013, promoted from an internal tunable in
   *  constitution v3.3.0 — real Kubernetes HPA also sets this per
   *  resource, not globally). */
  highWatermark: number
  /** Per-replica saturation ratio below which the scaler accumulates
   *  toward a scale-down; must be < highWatermark. */
  lowWatermark: number
}

export interface ScalingDecisionOutput {
  /** Runtime to carry into the NEXT window's drainBootQueue call. */
  runtime: ReplicaRuntime
  event: ScalingEvent | undefined
}

/** One deterministic per-window scaler evaluation (data-model.md "Scaler
 *  decision", research.md D1), proportional like real Kubernetes HPA
 *  (`desiredReplicas = ceil(currentReplicas * currentMetric / targetMetric)`
 *  — kubernetes.io HPA algorithm docs) rather than a fixed step of 1: a
 *  host at 400% of its watermark jumps toward ~4x its replica count in a
 *  single action instead of stepping 1-by-1 across several sustain+
 *  cooldown cycles, exactly like real HPA does before its own rate-limit
 *  policies apply. This engine has no separate rate-limit policy layer —
 *  the existing cooldown (AUTOSCALE_COOLDOWN_MS) already bounds how often
 *  an action can fire, which is what keeps a single oversized jump from
 *  repeating every window.
 *  - saturation ≥ HIGH for ≥ SUSTAIN, count < max, cooldown elapsed → up
 *    to ceil(count * saturation / HIGH), clamped to [count+1, max] so a
 *    trigger always changes something (queues one boot entry per added
 *    replica, all sharing the same readyAt; effective capacity is
 *    unchanged this window — spec FR-006/US1 scenario 2).
 *  - saturation ≤ LOW for ≥ SUSTAIN, count > min, cooldown elapsed → down
 *    to ceil(count * saturation / LOW), clamped to [min, count-1] (cancels
 *    booting entries newest-first before removing serving replicas;
 *    nominalCount drops immediately, but the capacity DIVISOR this window
 *    was already fixed before this decision ran, so the drop in served
 *    capacity is only visible starting next window — spec US2 scenario 1).
 *  - otherwise → hold; entering the band resets both accumulators.
 *  - See `restoreMinReplicaFloor` below for what brings `nominalCount` back
 *    up to `minReplicas` after `evictCollapsedReplicas` has crashed it
 *    below that floor (012-overload-collapse refinement) — deliberately
 *    NOT handled inside this function; see that function's doc for why. */
export function evaluateScaling(input: ScalingDecisionInput): ScalingDecisionOutput {
  const { perReplicaSaturation, simTimeMs, windowSizeMs, minReplicas, maxReplicas, bootDelayMs, highWatermark, lowWatermark } = input
  let runtime = input.runtime

  if (perReplicaSaturation >= highWatermark) {
    runtime = { ...runtime, timeAboveHighMs: runtime.timeAboveHighMs + windowSizeMs, timeBelowLowMs: 0 }
  } else if (perReplicaSaturation <= lowWatermark) {
    runtime = { ...runtime, timeBelowLowMs: runtime.timeBelowLowMs + windowSizeMs, timeAboveHighMs: 0 }
  } else {
    runtime = { ...runtime, timeAboveHighMs: 0, timeBelowLowMs: 0 }
  }

  if (runtime.timeAboveHighMs >= AUTOSCALE_SUSTAIN_MS && runtime.nominalCount < maxReplicas && cooldownElapsed(runtime, simTimeMs)) {
    // Proportional desired count (kubernetes.io HPA formula), floored at
    // count+1 so crossing the watermark always adds at least one replica
    // even when the ratio itself rounds down to the current count.
    const rawDesired = Math.ceil(runtime.nominalCount * (perReplicaSaturation / highWatermark))
    const newCount = Math.min(maxReplicas, Math.max(runtime.nominalCount + 1, rawDesired))
    const addedCount = newCount - runtime.nominalCount
    const event: ScalingEvent = { direction: 'up', newCount, simTimeMs }
    const readyAtSimTimeMs = simTimeMs + bootDelayMs
    const newBootingEntries = Array.from({ length: addedCount }, () => ({ readyAtSimTimeMs }))
    return {
      runtime: {
        ...runtime,
        nominalCount: newCount,
        booting: [...runtime.booting, ...newBootingEntries],
        timeAboveHighMs: 0,
        timeBelowLowMs: 0,
        lastActionSimTimeMs: simTimeMs,
        events: appendEvent(runtime.events, event),
      },
      event,
    }
  }

  if (runtime.timeBelowLowMs >= AUTOSCALE_SUSTAIN_MS && runtime.nominalCount > minReplicas && cooldownElapsed(runtime, simTimeMs)) {
    // Symmetric proportional formula on the low side, floored at count-1
    // so crossing the watermark always removes at least one replica.
    const rawDesired = Math.ceil(runtime.nominalCount * (perReplicaSaturation / lowWatermark))
    const newCount = Math.max(minReplicas, Math.min(runtime.nominalCount - 1, rawDesired))
    const removedCount = runtime.nominalCount - newCount
    const event: ScalingEvent = { direction: 'down', newCount, simTimeMs }
    // Cancel booting entries first (newest first), then let the remainder
    // fall on serving replicas (research.md D2/D7 pattern, generalized
    // from a single removal to `removedCount`).
    const cancelBootingCount = Math.min(removedCount, runtime.booting.length)
    const booting = cancelBootingCount > 0 ? runtime.booting.slice(0, runtime.booting.length - cancelBootingCount) : runtime.booting
    return {
      runtime: {
        ...runtime,
        nominalCount: newCount,
        booting,
        timeAboveHighMs: 0,
        timeBelowLowMs: 0,
        lastActionSimTimeMs: simTimeMs,
        events: appendEvent(runtime.events, event),
      },
      event,
    }
  }

  return { runtime, event: undefined }
}

/** Collapse-mode replica eviction (012-overload-collapse refinement,
 *  research.md D9): an elastic host (scaler enabled, `minReplicas !==
 *  maxReplicas`) with `overloadBehavior === 'collapse'` doesn't apply the
 *  smooth retrograde-decay curve across the whole group — that would
 *  require modeling a single degraded replica gracefully recovering
 *  in-place, which this engine doesn't (and shouldn't) model. Instead,
 *  overloaded replicas "crash": whenever the group's per-replica
 *  saturation exceeds 1 (offered load exceeds serving capacity),
 *  `Math.floor(currentEffectiveReplicas / perReplicaSaturation)` replicas
 *  could theoretically keep up — the rest are evicted immediately (at
 *  least 1 per window, no cooldown/sustain gate: a crash is a reactive
 *  failure, not a throttled policy decision). `nominalCount` is allowed to
 *  fall below `minReplicas`, all the way to 0 — recovery is entirely the
 *  responsibility of the normal scale-up watermark path plus the
 *  min-replicas floor restore below (spec: "a scaling group with 0 nodes
 *  for some momentos while the other replicas boot up"). A no-op for
 *  `clamp` hosts and non-elastic hosts (call site gates this). */
export function evictCollapsedReplicas(runtime: ReplicaRuntime, perReplicaSaturation: number, currentEffectiveReplicas: number): ReplicaRuntime {
  if (perReplicaSaturation <= 1 || currentEffectiveReplicas <= 0) return runtime
  const survivors = Math.floor(currentEffectiveReplicas / perReplicaSaturation)
  const evictCount = Math.min(currentEffectiveReplicas, Math.max(1, currentEffectiveReplicas - survivors))
  if (evictCount <= 0) return runtime
  return { ...runtime, nominalCount: runtime.nominalCount - evictCount }
}

/** Mid-run bounds edit (research.md D7, spec edge case): re-clamp
 *  nominalCount into the new [min, max] and cancel booting entries beyond
 *  the new max (newest first); accumulators/cooldown are preserved. */
export function reclampReplicaRuntime(runtime: ReplicaRuntime, minReplicas: number, maxReplicas: number): ReplicaRuntime {
  const clampedNominal = Math.min(Math.max(runtime.nominalCount, minReplicas), maxReplicas)
  if (clampedNominal === runtime.nominalCount) return runtime
  const removed = runtime.nominalCount - clampedNominal
  const booting = removed > 0 ? runtime.booting.slice(0, Math.max(0, runtime.booting.length - removed)) : runtime.booting
  return { ...runtime, nominalCount: clampedNominal, booting }
}
