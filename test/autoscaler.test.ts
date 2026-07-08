import { describe, expect, it } from 'vitest'
import {
  createReplicaRuntime,
  drainBootQueue,
  effectiveReplicas,
  evaluateScaling,
  evictCollapsedReplicas,
  reclampReplicaRuntime,
  restoreMinReplicaFloor,
  type ReplicaRuntime,
} from '../src/autoscaler'
import { AUTOSCALE_COOLDOWN_MS, AUTOSCALE_SUSTAIN_MS } from '../src/config'

// Watermarks are now a per-host user parameter (constitution v3.3.0), not
// an internal config constant — these local test values match the old
// internal defaults so the fixtures below read the same as before.
const AUTOSCALE_HIGH_WATERMARK = 0.8
const AUTOSCALE_LOW_WATERMARK = 0.3

const WINDOW_MS = 1000
const BOOT_DELAY_MS = 8000

function runWindows(
  runtime: ReplicaRuntime,
  saturations: number[],
  minReplicas: number,
  maxReplicas: number,
): { runtimes: ReplicaRuntime[]; events: (import('../src/ports').ScalingEvent | undefined)[] } {
  let current = runtime
  let simTimeMs = 0
  const runtimes: ReplicaRuntime[] = []
  const events: (import('../src/ports').ScalingEvent | undefined)[] = []
  for (const saturation of saturations) {
    simTimeMs += WINDOW_MS
    current = drainBootQueue(current, simTimeMs)
    const decision = evaluateScaling({
      runtime: current,
      perReplicaSaturation: saturation,
      simTimeMs,
      windowSizeMs: WINDOW_MS,
      minReplicas,
      maxReplicas,
      bootDelayMs: BOOT_DELAY_MS,
      highWatermark: AUTOSCALE_HIGH_WATERMARK,
      lowWatermark: AUTOSCALE_LOW_WATERMARK,
    })
    current = decision.runtime
    runtimes.push(current)
    events.push(decision.event)
  }
  return { runtimes, events }
}

describe('createReplicaRuntime', () => {
  it('starts at minReplicas with no booting entries, accumulators, or events', () => {
    const runtime = createReplicaRuntime(2)
    expect(runtime).toEqual({
      nominalCount: 2,
      booting: [],
      timeAboveHighMs: 0,
      timeBelowLowMs: 0,
      lastActionSimTimeMs: undefined,
      events: [],
    })
    expect(effectiveReplicas(runtime)).toBe(2)
  })
})

describe('evaluateScaling — scale-up half (US1)', () => {
  it('does not act on a transient spike shorter than the sustain window', () => {
    const runtime = createReplicaRuntime(1)
    const spikeWindows = Math.floor(AUTOSCALE_SUSTAIN_MS / WINDOW_MS) - 1
    const saturations = Array(spikeWindows).fill(AUTOSCALE_HIGH_WATERMARK + 0.05)
    const { runtimes, events } = runWindows(runtime, saturations, 1, 4)
    expect(events.every((event) => event === undefined)).toBe(true)
    expect(runtimes.at(-1)?.nominalCount).toBe(1)
  })

  it('fires exactly once sustain has been held for AUTOSCALE_SUSTAIN_MS, queuing a boot entry', () => {
    const runtime = createReplicaRuntime(1)
    const windowCount = Math.ceil(AUTOSCALE_SUSTAIN_MS / WINDOW_MS)
    const saturations = Array(windowCount).fill(AUTOSCALE_HIGH_WATERMARK + 0.05)
    const { runtimes, events } = runWindows(runtime, saturations, 1, 4)
    const fireIndex = events.findIndex((event) => event !== undefined)
    expect(fireIndex).toBeGreaterThanOrEqual(0)
    expect(events[fireIndex]).toEqual({ direction: 'up', newCount: 2, simTimeMs: (fireIndex + 1) * WINDOW_MS })
    expect(runtimes[fireIndex].nominalCount).toBe(2)
    expect(runtimes[fireIndex].booting).toHaveLength(1)
    // The boot entry's readyAt reflects the CONFIGURED bootDelayMs (feature
    // 013, promoted to a user-facing parameter in constitution v3.2.0), not
    // a hardcoded engine constant.
    expect(runtimes[fireIndex].booting[0].readyAtSimTimeMs).toBe((fireIndex + 1) * WINDOW_MS + BOOT_DELAY_MS)
    // Capacity unchanged until boot delay elapses (spec FR-006/US1 scenario 2).
    expect(effectiveReplicas(runtimes[fireIndex])).toBe(1)
  })

  it('a different bootDelayMs changes exactly when the booting replica starts serving (it is a real parameter, not a fixed constant)', () => {
    const fireAt = evaluateScaling({
      runtime: { ...createReplicaRuntime(1), timeAboveHighMs: AUTOSCALE_SUSTAIN_MS },
      perReplicaSaturation: AUTOSCALE_HIGH_WATERMARK + 0.05,
      simTimeMs: AUTOSCALE_SUSTAIN_MS,
      windowSizeMs: WINDOW_MS,
      minReplicas: 1,
      maxReplicas: 4,
      bootDelayMs: 2000,
    highWatermark: AUTOSCALE_HIGH_WATERMARK,
    lowWatermark: AUTOSCALE_LOW_WATERMARK,
    })
    expect(fireAt.runtime.booting[0].readyAtSimTimeMs).toBe(AUTOSCALE_SUSTAIN_MS + 2000)

    const slowBoot = evaluateScaling({
      runtime: { ...createReplicaRuntime(1), timeAboveHighMs: AUTOSCALE_SUSTAIN_MS },
      perReplicaSaturation: AUTOSCALE_HIGH_WATERMARK + 0.05,
      simTimeMs: AUTOSCALE_SUSTAIN_MS,
      windowSizeMs: WINDOW_MS,
      minReplicas: 1,
      maxReplicas: 4,
      bootDelayMs: 60_000,
    highWatermark: AUTOSCALE_HIGH_WATERMARK,
    lowWatermark: AUTOSCALE_LOW_WATERMARK,
    })
    expect(slowBoot.runtime.booting[0].readyAtSimTimeMs).toBe(AUTOSCALE_SUSTAIN_MS + 60_000)
  })

  it('jumps proportionally in one action when saturation is far past the watermark, like real HPA (research.md D9)', () => {
    // 1 replica at 400% of the watermark (e.g. 4x the target saturation)
    // should ask for ~4x the replica count in a single action, not step
    // 1 -> 2 -> 3 -> 4 across separate sustain+cooldown cycles.
    const farOverSaturation = AUTOSCALE_HIGH_WATERMARK * 4
    const decision = evaluateScaling({
      runtime: { ...createReplicaRuntime(1), timeAboveHighMs: AUTOSCALE_SUSTAIN_MS },
      perReplicaSaturation: farOverSaturation,
      simTimeMs: AUTOSCALE_SUSTAIN_MS,
      windowSizeMs: WINDOW_MS,
      minReplicas: 1,
      maxReplicas: 10,
      bootDelayMs: BOOT_DELAY_MS,
    highWatermark: AUTOSCALE_HIGH_WATERMARK,
    lowWatermark: AUTOSCALE_LOW_WATERMARK,
    })
    expect(decision.event).toEqual({ direction: 'up', newCount: 4, simTimeMs: AUTOSCALE_SUSTAIN_MS })
    // One boot entry per newly-added replica, all ready at the same time.
    expect(decision.runtime.booting).toHaveLength(3)
    expect(decision.runtime.booting.every((entry) => entry.readyAtSimTimeMs === AUTOSCALE_SUSTAIN_MS + BOOT_DELAY_MS)).toBe(true)
  })

  it('still clamps a far-oversaturated jump to maxReplicas in one action', () => {
    const decision = evaluateScaling({
      runtime: { ...createReplicaRuntime(1), timeAboveHighMs: AUTOSCALE_SUSTAIN_MS },
      perReplicaSaturation: AUTOSCALE_HIGH_WATERMARK * 10,
      simTimeMs: AUTOSCALE_SUSTAIN_MS,
      windowSizeMs: WINDOW_MS,
      minReplicas: 1,
      maxReplicas: 4,
      bootDelayMs: BOOT_DELAY_MS,
    highWatermark: AUTOSCALE_HIGH_WATERMARK,
    lowWatermark: AUTOSCALE_LOW_WATERMARK,
    })
    expect(decision.event?.newCount).toBe(4)
    expect(decision.runtime.nominalCount).toBe(4)
  })

  it('still adds exactly one replica when only barely over the watermark (proportional math floors at +1)', () => {
    const decision = evaluateScaling({
      runtime: { ...createReplicaRuntime(3), timeAboveHighMs: AUTOSCALE_SUSTAIN_MS },
      perReplicaSaturation: AUTOSCALE_HIGH_WATERMARK + 0.001,
      simTimeMs: AUTOSCALE_SUSTAIN_MS,
      windowSizeMs: WINDOW_MS,
      minReplicas: 1,
      maxReplicas: 10,
      bootDelayMs: BOOT_DELAY_MS,
    highWatermark: AUTOSCALE_HIGH_WATERMARK,
    lowWatermark: AUTOSCALE_LOW_WATERMARK,
    })
    expect(decision.event?.newCount).toBe(4)
  })

  it('a custom highWatermark changes exactly when the scaler triggers (it is a real per-host parameter, not a fixed constant)', () => {
    // At 50% saturation: never triggers against the default 0.8 watermark,
    // but DOES trigger against a custom, much lower 0.4 watermark.
    const saturation = 0.5
    const withDefaultWatermark = evaluateScaling({
      runtime: { ...createReplicaRuntime(1), timeAboveHighMs: AUTOSCALE_SUSTAIN_MS },
      perReplicaSaturation: saturation,
      simTimeMs: AUTOSCALE_SUSTAIN_MS,
      windowSizeMs: WINDOW_MS,
      minReplicas: 1,
      maxReplicas: 4,
      bootDelayMs: BOOT_DELAY_MS,
      highWatermark: 0.8,
      lowWatermark: 0.3,
    })
    expect(withDefaultWatermark.event).toBeUndefined()

    const withLowerWatermark = evaluateScaling({
      runtime: { ...createReplicaRuntime(1), timeAboveHighMs: AUTOSCALE_SUSTAIN_MS },
      perReplicaSaturation: saturation,
      simTimeMs: AUTOSCALE_SUSTAIN_MS,
      windowSizeMs: WINDOW_MS,
      minReplicas: 1,
      maxReplicas: 4,
      bootDelayMs: BOOT_DELAY_MS,
      highWatermark: 0.4,
      lowWatermark: 0.1,
    })
    expect(withLowerWatermark.event?.direction).toBe('up')
  })

  it('a custom lowWatermark changes exactly when the scaler scales back in', () => {
    // At 20% saturation: sits in the default [0.3, 0.8] band (no action),
    // but triggers a scale-down against a custom, much higher 0.25 low
    // watermark being cleared... actually below it, so it should fire.
    const saturation = 0.2
    const withDefaultWatermark = evaluateScaling({
      runtime: { ...createReplicaRuntime(2), timeBelowLowMs: AUTOSCALE_SUSTAIN_MS },
      perReplicaSaturation: saturation,
      simTimeMs: AUTOSCALE_SUSTAIN_MS,
      windowSizeMs: WINDOW_MS,
      minReplicas: 1,
      maxReplicas: 4,
      bootDelayMs: BOOT_DELAY_MS,
      highWatermark: 0.8,
      lowWatermark: 0.1,
    })
    expect(withDefaultWatermark.event).toBeUndefined()

    const withHigherLowWatermark = evaluateScaling({
      runtime: { ...createReplicaRuntime(2), timeBelowLowMs: AUTOSCALE_SUSTAIN_MS },
      perReplicaSaturation: saturation,
      simTimeMs: AUTOSCALE_SUSTAIN_MS,
      windowSizeMs: WINDOW_MS,
      minReplicas: 1,
      maxReplicas: 4,
      bootDelayMs: BOOT_DELAY_MS,
      highWatermark: 0.8,
      lowWatermark: 0.25,
    })
    expect(withHigherLowWatermark.event?.direction).toBe('down')
  })

  it('respects cooldown: a second sustained high period right after the first does not fire again immediately', () => {
    const runtime = createReplicaRuntime(1)
    const windowCount = Math.ceil(AUTOSCALE_SUSTAIN_MS / WINDOW_MS) + Math.ceil(AUTOSCALE_COOLDOWN_MS / WINDOW_MS)
    const saturations = Array(windowCount).fill(AUTOSCALE_HIGH_WATERMARK + 0.05)
    const { events } = runWindows(runtime, saturations, 1, 4)
    const fireIndices = events.flatMap((event, index) => (event ? [index] : []))
    // Sustained the whole time, so once cooldown elapses it may fire again —
    // but never twice within one cooldown interval.
    for (let i = 1; i < fireIndices.length; i++) {
      const gapMs = (fireIndices[i] - fireIndices[i - 1]) * WINDOW_MS
      expect(gapMs).toBeGreaterThanOrEqual(AUTOSCALE_COOLDOWN_MS)
    }
  })

  it('never scales up past maxReplicas', () => {
    const runtime: ReplicaRuntime = { ...createReplicaRuntime(1), nominalCount: 4 }
    const windowCount = Math.ceil(AUTOSCALE_SUSTAIN_MS / WINDOW_MS) + 2
    const saturations = Array(windowCount).fill(1)
    const { runtimes, events } = runWindows(runtime, saturations, 1, 4)
    expect(events.every((event) => event === undefined)).toBe(true)
    expect(runtimes.at(-1)?.nominalCount).toBe(4)
  })

  it('drains a booting entry once simTimeMs reaches readyAtSimTimeMs, not before', () => {
    const runtime: ReplicaRuntime = {
      ...createReplicaRuntime(1),
      nominalCount: 2,
      booting: [{ readyAtSimTimeMs: 5000 }],
    }
    expect(effectiveReplicas(drainBootQueue(runtime, 4999))).toBe(1)
    expect(effectiveReplicas(drainBootQueue(runtime, 5000))).toBe(2)
  })

  it('is deterministic: the same saturation sequence twice yields identical event sequences', () => {
    const windowCount = Math.ceil(AUTOSCALE_SUSTAIN_MS / WINDOW_MS) + 5
    const saturations = Array(windowCount).fill(AUTOSCALE_HIGH_WATERMARK + 0.05)
    const first = runWindows(createReplicaRuntime(1), saturations, 1, 4)
    const second = runWindows(createReplicaRuntime(1), saturations, 1, 4)
    expect(first.events).toEqual(second.events)
    expect(first.runtimes.at(-1)).toEqual(second.runtimes.at(-1))
  })
})

describe('evaluateScaling — scale-down half (US2)', () => {
  it('steps down with at least the cooldown between actions, stopping at minReplicas', () => {
    const runtime: ReplicaRuntime = { ...createReplicaRuntime(1), nominalCount: 3 }
    const windowCount = 3 * (Math.ceil(AUTOSCALE_SUSTAIN_MS / WINDOW_MS) + Math.ceil(AUTOSCALE_COOLDOWN_MS / WINDOW_MS) + 1)
    const saturations = Array(windowCount).fill(AUTOSCALE_LOW_WATERMARK - 0.05)
    const { runtimes, events } = runWindows(runtime, saturations, 1, 3)
    const fireIndices = events.flatMap((event, index) => (event ? [index] : []))
    expect(fireIndices.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < fireIndices.length; i++) {
      const gapMs = (fireIndices[i] - fireIndices[i - 1]) * WINDOW_MS
      expect(gapMs).toBeGreaterThanOrEqual(AUTOSCALE_COOLDOWN_MS)
    }
    expect(runtimes.at(-1)?.nominalCount).toBe(1)
    expect(events.filter((event) => event?.direction === 'down')).toHaveLength(2)
  })

  it('holds inside the hysteresis band (no flapping across 3 consecutive evaluations at steady load, SC-002)', () => {
    const runtime = createReplicaRuntime(2)
    const bandSaturation = (AUTOSCALE_HIGH_WATERMARK + AUTOSCALE_LOW_WATERMARK) / 2
    const { runtimes, events } = runWindows(runtime, Array(3).fill(bandSaturation), 1, 4)
    expect(events.every((event) => event === undefined)).toBe(true)
    expect(runtimes.every((runtime) => runtime.nominalCount === 2)).toBe(true)
  })

  it('cancels the newest booting entry first before removing a serving replica', () => {
    const runtime: ReplicaRuntime = {
      ...createReplicaRuntime(1),
      nominalCount: 2,
      booting: [{ readyAtSimTimeMs: 999_999 }],
    }
    const windowCount = Math.ceil(AUTOSCALE_SUSTAIN_MS / WINDOW_MS)
    const saturations = Array(windowCount).fill(AUTOSCALE_LOW_WATERMARK - 0.05)
    const { runtimes, events } = runWindows(runtime, saturations, 1, 4)
    const fireIndex = events.findIndex((event) => event !== undefined)
    expect(events[fireIndex]?.direction).toBe('down')
    expect(runtimes[fireIndex].nominalCount).toBe(1)
    expect(runtimes[fireIndex].booting).toHaveLength(0)
  })

  it('cancels multiple booting entries when a proportional down-jump removes more than one replica at once', () => {
    const runtime: ReplicaRuntime = {
      ...createReplicaRuntime(1),
      nominalCount: 6,
      booting: [{ readyAtSimTimeMs: 999_999 }, { readyAtSimTimeMs: 999_999 }],
    }
    // Deep in the low band (far below LOW watermark) => a large
    // proportional drop, mirroring the up-side jump symmetrically.
    const decision = evaluateScaling({
      runtime: { ...runtime, timeBelowLowMs: AUTOSCALE_SUSTAIN_MS },
      perReplicaSaturation: AUTOSCALE_LOW_WATERMARK * 0.1,
      simTimeMs: AUTOSCALE_SUSTAIN_MS,
      windowSizeMs: WINDOW_MS,
      minReplicas: 1,
      maxReplicas: 10,
      bootDelayMs: BOOT_DELAY_MS,
    highWatermark: AUTOSCALE_HIGH_WATERMARK,
    lowWatermark: AUTOSCALE_LOW_WATERMARK,
    })
    expect(decision.event?.direction).toBe('down')
    expect(decision.event!.newCount).toBeLessThan(6)
    // Both booting entries get cancelled first, before any serving replica
    // is removed (research.md D2/D7 pattern, generalized to N removals).
    expect(decision.runtime.booting).toHaveLength(0)
  })

  it('never scales down past minReplicas', () => {
    const runtime = createReplicaRuntime(2)
    const windowCount = Math.ceil(AUTOSCALE_SUSTAIN_MS / WINDOW_MS) + 2
    const saturations = Array(windowCount).fill(0)
    const { runtimes, events } = runWindows(runtime, saturations, 2, 4)
    expect(events.every((event) => event === undefined)).toBe(true)
    expect(runtimes.at(-1)?.nominalCount).toBe(2)
  })
})

describe('reclampReplicaRuntime (research.md D7)', () => {
  it('clamps nominalCount down when maxReplicas shrinks below it, cancelling booting entries newest-first', () => {
    const runtime: ReplicaRuntime = {
      ...createReplicaRuntime(1),
      nominalCount: 4,
      booting: [{ readyAtSimTimeMs: 1000 }, { readyAtSimTimeMs: 2000 }],
    }
    const reclamped = reclampReplicaRuntime(runtime, 1, 2)
    expect(reclamped.nominalCount).toBe(2)
    expect(reclamped.booting).toHaveLength(0)
  })

  it('clamps nominalCount up when minReplicas rises above it', () => {
    const runtime = createReplicaRuntime(1)
    const reclamped = reclampReplicaRuntime(runtime, 3, 5)
    expect(reclamped.nominalCount).toBe(3)
  })

  it('is a no-op when already within bounds', () => {
    const runtime = createReplicaRuntime(2)
    expect(reclampReplicaRuntime(runtime, 1, 4)).toBe(runtime)
  })
})

// 012-overload-collapse refinement (research.md D9): collapse-mode
// eviction and the min-replicas floor restore it depends on for recovery.
describe('evictCollapsedReplicas (research.md D9)', () => {
  it('is a no-op at or below 100% per-replica saturation', () => {
    const runtime = createReplicaRuntime(4)
    expect(evictCollapsedReplicas(runtime, 1, 4)).toBe(runtime)
    expect(evictCollapsedReplicas(runtime, 0.5, 4)).toBe(runtime)
  })

  it('is a no-op when there are no currently-serving replicas left to evict', () => {
    const runtime: ReplicaRuntime = { ...createReplicaRuntime(4), nominalCount: 2, booting: [{ readyAtSimTimeMs: 5000 }, { readyAtSimTimeMs: 5000 }] }
    expect(evictCollapsedReplicas(runtime, 5, 0)).toBe(runtime)
  })

  it('evicts exactly 1 replica at a mild overload just past 100% saturation', () => {
    const runtime: ReplicaRuntime = { ...createReplicaRuntime(4), nominalCount: 4 }
    // 4 effective replicas at 1.2x load => survivors = floor(4/1.2) = 3 => evict 1.
    const evicted = evictCollapsedReplicas(runtime, 1.2, 4)
    expect(evicted.nominalCount).toBe(3)
  })

  it('evicts proportionally more replicas the further over capacity the group is', () => {
    const runtime: ReplicaRuntime = { ...createReplicaRuntime(4), nominalCount: 4 }
    // 4 effective replicas at 4x load => survivors = floor(4/4) = 1 => evict 3.
    const evicted = evictCollapsedReplicas(runtime, 4, 4)
    expect(evicted.nominalCount).toBe(1)
  })

  it('can evict every currently-serving replica, taking nominalCount to 0, at extreme overload', () => {
    const runtime: ReplicaRuntime = { ...createReplicaRuntime(4), nominalCount: 4 }
    // 4 effective replicas at 10x load => survivors = floor(4/10) = 0 => evict all 4.
    const evicted = evictCollapsedReplicas(runtime, 10, 4)
    expect(evicted.nominalCount).toBe(0)
  })

  it('only removes from currently-serving replicas, leaving booting entries untouched', () => {
    const runtime: ReplicaRuntime = { ...createReplicaRuntime(4), nominalCount: 5, booting: [{ readyAtSimTimeMs: 5000 }] }
    // 4 effective (serving) replicas at 4x load => evict 3 servers; the 1
    // booting entry (not yet serving, can't be "overloaded to death") stays.
    const evicted = evictCollapsedReplicas(runtime, 4, 4)
    expect(evicted.nominalCount).toBe(2)
    expect(evicted.booting).toHaveLength(1)
  })

  it('allows nominalCount to fall below minReplicas (the whole point — no eviction-time bounds clamp)', () => {
    const runtime: ReplicaRuntime = { ...createReplicaRuntime(2), nominalCount: 2 }
    const evicted = evictCollapsedReplicas(runtime, 10, 2)
    expect(evicted.nominalCount).toBe(0)
  })
})

describe('evaluateScaling — min-replicas floor restore (research.md D9)', () => {
  it('does not itself restore the floor — that is restoreMinReplicaFloor\u2019s job, called separately at the start of the NEXT window', () => {
    const runtime: ReplicaRuntime = { ...createReplicaRuntime(3), nominalCount: 0, lastActionSimTimeMs: 0 }
    const decision = evaluateScaling({
      runtime,
      perReplicaSaturation: 0,
      simTimeMs: WINDOW_MS,
      windowSizeMs: WINDOW_MS,
      minReplicas: 3,
      maxReplicas: 6,
      bootDelayMs: BOOT_DELAY_MS,
      highWatermark: AUTOSCALE_HIGH_WATERMARK,
      lowWatermark: AUTOSCALE_LOW_WATERMARK,
    })
    // Deep in the low band (saturation=0) with nominalCount already below
    // minReplicas: the low-side branch requires nominalCount > minReplicas
    // to act, so this is correctly a hold — nominalCount stays at 0 here,
    // genuinely observable for this window (see restoreMinReplicaFloor
    // tests below for how it recovers on the NEXT window).
    expect(decision.event).toBeUndefined()
    expect(decision.runtime.nominalCount).toBe(0)
  })
})

describe('restoreMinReplicaFloor (research.md D9)', () => {
  it('is a no-op when nominalCount already meets or exceeds minReplicas', () => {
    const runtime = createReplicaRuntime(3)
    expect(restoreMinReplicaFloor(runtime, 3, BOOT_DELAY_MS, WINDOW_MS)).toBe(runtime)
    const above = { ...createReplicaRuntime(3), nominalCount: 5 }
    expect(restoreMinReplicaFloor(above, 3, BOOT_DELAY_MS, WINDOW_MS)).toBe(above)
  })

  it('queues enough booting entries to bring nominalCount back up to minReplicas, at bootDelayMs in the future', () => {
    const runtime: ReplicaRuntime = { ...createReplicaRuntime(3), nominalCount: 0 }
    const restored = restoreMinReplicaFloor(runtime, 3, BOOT_DELAY_MS, WINDOW_MS)
    expect(restored.nominalCount).toBe(3)
    expect(restored.booting).toHaveLength(3)
    expect(restored.booting.every((entry) => entry.readyAtSimTimeMs === WINDOW_MS + BOOT_DELAY_MS)).toBe(true)
  })

  it('only tops up the deficit, preserving any already-booting entries', () => {
    const runtime: ReplicaRuntime = { ...createReplicaRuntime(3), nominalCount: 1, booting: [{ readyAtSimTimeMs: 500 }] }
    const restored = restoreMinReplicaFloor(runtime, 3, BOOT_DELAY_MS, WINDOW_MS)
    expect(restored.nominalCount).toBe(3)
    expect(restored.booting).toHaveLength(3) // 1 pre-existing + 2 new
    expect(restored.booting[0]).toEqual({ readyAtSimTimeMs: 500 })
  })
})
