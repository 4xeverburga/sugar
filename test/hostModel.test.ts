import { describe, expect, it } from 'vitest'
import {
  calculatedCapacityRPS,
  collapseForwardedRPS,
  computeClientPoolMetrics,
  computeExternalApiMetrics,
  computeHostMetrics,
  hockeyStickLatencyMs,
} from '../src/hostModel'
import { HOST_RHO_CLAMP } from '../src/config'
import type { HostNodeSim } from '../src/ports'

function manualSim(overrides: Partial<Extract<HostNodeSim, { configMode: 'manual' }>> = {}) {
  return {
    kind: 'host' as const,
    profile: 'transactional_api' as const,
    configMode: 'manual' as const,
    manualBaselineLatencyMs: 10,
    manualSaturationRPS: 500,
    manualMaxRPS: 550,
    overloadBehavior: 'clamp' as const,
    minReplicas: 1,
    maxReplicas: 1,
    bootDelayMs: 8000,
    highWatermark: 0.8,
    lowWatermark: 0.3,
    ...overrides,
  }
}

function calculatedSim(overrides: Partial<Extract<HostNodeSim, { configMode: 'calculated' }>> = {}) {
  return {
    kind: 'host' as const,
    profile: 'transactional_api' as const,
    configMode: 'calculated' as const,
    cpuProcessingTimeMs: 16,
    maxWorkerThreads: 8,
    overloadBehavior: 'clamp' as const,
    minReplicas: 1,
    maxReplicas: 1,
    bootDelayMs: 8000,
    highWatermark: 0.8,
    lowWatermark: 0.3,
    ...overrides,
  }
}

describe('hockeyStickLatencyMs', () => {
  it('stays near baseline at low utilization (rho=0.2)', () => {
    expect(hockeyStickLatencyMs(10, 0.2)).toBeCloseTo(12.5, 5)
  })

  it('is at least 5x baseline at rho=0.95 (SC-002)', () => {
    expect(hockeyStickLatencyMs(10, 0.95)).toBeGreaterThanOrEqual(50)
  })

  it('clamps rho below 1 so it never divides by zero / returns Infinity', () => {
    expect(Number.isFinite(hockeyStickLatencyMs(10, 1))).toBe(true)
    expect(Number.isFinite(hockeyStickLatencyMs(10, 5))).toBe(true)
  })

  it('increases strictly monotonically across a 10%->99% sweep with no discontinuity', () => {
    let previous = hockeyStickLatencyMs(10, 0.1)
    for (let rho = 0.11; rho <= 0.99; rho += 0.01) {
      const current = hockeyStickLatencyMs(10, rho)
      expect(current).toBeGreaterThan(previous)
      previous = current
    }
  })
})

describe('computeHostMetrics — manual mode', () => {
  it('reports near-baseline latency and low saturation under light load', () => {
    const metrics = computeHostMetrics({
      sim: manualSim(),
      incomingRPS: 100,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(metrics.saturationRatio).toBeCloseTo(0.2, 5)
    expect(metrics.latencyMs).toBeCloseTo(hockeyStickLatencyMs(10, 0.2), 5)
    expect(metrics.status).toBe('healthy')
  })

  it('forwards everything and sheds nothing below manualMaxRPS', () => {
    const metrics = computeHostMetrics({
      sim: manualSim(),
      incomingRPS: 400,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(metrics.forwardedRPS).toBe(400)
    expect(metrics.shedRPS).toBe(0)
  })

  it('hard-clamps forwardedRPS at manualMaxRPS and sheds the remainder (research.md D6)', () => {
    const metrics = computeHostMetrics({
      sim: manualSim(),
      incomingRPS: 700,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(metrics.forwardedRPS).toBe(550)
    expect(metrics.shedRPS).toBe(150)
    expect(metrics.status).toBe('overloaded')
    expect(Number.isFinite(metrics.latencyMs)).toBe(true)
  })

  it('marks saturated once rho crosses the saturation threshold but stays under manualMaxRPS', () => {
    const metrics = computeHostMetrics({
      sim: manualSim(),
      incomingRPS: 460,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(metrics.status).toBe('saturated')
    expect(metrics.shedRPS).toBe(0)
  })

  it('zero-capacity manual host (0 saturation/max RPS) yields zero forwarded/shed and finite latency, never NaN', () => {
    const metrics = computeHostMetrics({
      sim: manualSim({ manualSaturationRPS: 0, manualMaxRPS: 0 }),
      incomingRPS: 100,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(metrics.forwardedRPS).toBe(0)
    expect(metrics.shedRPS).toBe(100)
    expect(Number.isFinite(metrics.latencyMs)).toBe(true)
    expect(Number.isNaN(metrics.saturationRatio)).toBe(false)
  })
})

describe('computeHostMetrics — calculated mode (research.md D3)', () => {
  it('matches manual mode within 1% at an equivalent operating point (SC-003)', () => {
    // 16ms * 8 threads => 500 req/s capacity, same as the manual fixture's
    // manualSaturationRPS; baseline latency is also aligned to 16ms so the
    // two modes represent the exact same underlying service, isolating the
    // comparison to ρ/latency-curve agreement rather than an arbitrary
    // difference between independently-chosen baseline latency inputs.
    const manual = computeHostMetrics({
      sim: manualSim({ manualBaselineLatencyMs: 16 }),
      incomingRPS: 400,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    const calculated = computeHostMetrics({
      sim: calculatedSim(),
      incomingRPS: 400,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(calculated.saturationRatio).toBeCloseTo(manual.saturationRatio, 5)
    const relativeLatencyDiff = Math.abs(calculated.latencyMs - manual.latencyMs) / manual.latencyMs
    expect(relativeLatencyDiff).toBeLessThan(0.01)
  })

  it('scales rho proportionally to the inbound weighted compute multiplier', () => {
    const base = computeHostMetrics({
      sim: calculatedSim(),
      incomingRPS: 200,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    const doubled = computeHostMetrics({
      sim: calculatedSim(),
      incomingRPS: 200,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 2,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(doubled.saturationRatio).toBeCloseTo(base.saturationRatio * 2, 5)
  })

  it('composes base latency from cpuProcessingTimeMs plus the outbound weighted I/O latency', () => {
    const withIo = computeHostMetrics({
      sim: calculatedSim(),
      incomingRPS: 0,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 5,
    })
    // At incomingRPS=0, rho=0, so latencyMs === baseLatencyMs exactly.
    expect(withIo.latencyMs).toBeCloseTo(16 + 5, 5)
  })

  it('never sheds traffic (no maxRPS parameter exists in calculated mode)', () => {
    const metrics = computeHostMetrics({
      sim: calculatedSim(),
      incomingRPS: 5000,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(metrics.forwardedRPS).toBe(5000)
    expect(metrics.shedRPS).toBe(0)
    expect(metrics.status).toBe('overloaded')
  })

  it('0-thread edge case yields finite numbers, never NaN/Infinity', () => {
    const metrics = computeHostMetrics({
      sim: calculatedSim({ maxWorkerThreads: 0 }),
      incomingRPS: 100,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(Number.isFinite(metrics.saturationRatio)).toBe(true)
    expect(Number.isFinite(metrics.latencyMs)).toBe(true)
    expect(metrics.status).toBe('overloaded')
  })
})

describe('calculatedCapacityRPS', () => {
  it('computes threads / serviceTimeSec', () => {
    expect(calculatedCapacityRPS(16, 8)).toBeCloseTo(500, 5)
  })

  it('returns 0 for zero threads or zero cpu time, never NaN', () => {
    expect(calculatedCapacityRPS(0, 8)).toBe(0)
    expect(calculatedCapacityRPS(16, 0)).toBe(0)
  })
})

describe('computeClientPoolMetrics', () => {
  it('emits the configured rate as forwardedRPS and never saturates', () => {
    const metrics = computeClientPoolMetrics(250)
    expect(metrics.forwardedRPS).toBe(250)
    expect(metrics.saturationRatio).toBe(0)
    expect(metrics.status).toBe('healthy')
  })
})

describe('computeExternalApiMetrics', () => {
  it('is bottomless: rho=0, forwards everything, never sheds', () => {
    const metrics = computeExternalApiMetrics(10_000, 40)
    expect(metrics.saturationRatio).toBe(0)
    expect(metrics.forwardedRPS).toBe(10_000)
    expect(metrics.shedRPS).toBe(0)
    expect(metrics.latencyMs).toBe(40)
    expect(metrics.status).toBe('healthy')
  })
})

describe('HOST_RHO_CLAMP sanity', () => {
  it('is strictly below 1', () => {
    expect(HOST_RHO_CLAMP).toBeLessThan(1)
    expect(HOST_RHO_CLAMP).toBeGreaterThan(0)
  })
})

describe('computeHostMetrics — per-replica division (feature 013, research.md D3)', () => {
  it('effectiveReplicas=1 is bit-identical to the single-instance computation (SC-003)', () => {
    const single = computeHostMetrics({
      sim: manualSim(),
      incomingRPS: 400,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(single.saturationRatio).toBeCloseTo(0.8, 5)
    expect(single.forwardedRPS).toBe(400)
  })

  it('divides incomingRPS by effectiveReplicas before computing rho/latency, then scales forwarded/shed back up', () => {
    // 4 replicas at 400 total => 100 per replica => rho = 100/500 = 0.2,
    // identical to the single-replica 100-req/s fixture above.
    const scaled = computeHostMetrics({
      sim: manualSim(),
      incomingRPS: 400,
      effectiveReplicas: 4,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(scaled.saturationRatio).toBeCloseTo(0.2, 5)
    expect(scaled.latencyMs).toBeCloseTo(hockeyStickLatencyMs(10, 0.2), 5)
    expect(scaled.forwardedRPS).toBeCloseTo(400, 5)
    expect(scaled.shedRPS).toBe(0)
  })

  it('composes the per-replica manualMaxRPS clamp into a total cap of effectiveReplicas x manualMaxRPS (FR-003/FR-011)', () => {
    // 3 replicas, manualMaxRPS=550 each => total cap 1650; offered 2000 =>
    // 2000/3 ~= 666.7 per replica, clamped to 550 per replica, so shed
    // per replica ~= 116.7, scaled back up by 3.
    const metrics = computeHostMetrics({
      sim: manualSim(),
      incomingRPS: 2000,
      effectiveReplicas: 3,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(metrics.forwardedRPS).toBeCloseTo(1650, 5)
    expect(metrics.shedRPS).toBeCloseTo(350, 5)
    expect(metrics.status).toBe('overloaded')
  })

  it('calculated mode also divides by effectiveReplicas (no shedding either way)', () => {
    const single = computeHostMetrics({
      sim: calculatedSim(),
      incomingRPS: 500,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    const scaled = computeHostMetrics({
      sim: calculatedSim(),
      incomingRPS: 500,
      effectiveReplicas: 5,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(scaled.saturationRatio).toBeCloseTo(single.saturationRatio / 5, 5)
    expect(scaled.forwardedRPS).toBeCloseTo(500, 5)
    expect(scaled.shedRPS).toBe(0)
  })
})

// Feature 012 (Overload Collapse), research.md D1-D5.
describe('collapseForwardedRPS (research.md D2)', () => {
  it('passes through unchanged at/below the knee', () => {
    expect(collapseForwardedRPS(300, 500)).toBe(300)
    expect(collapseForwardedRPS(500, 500)).toBe(500)
  })

  it('decays retrograde past the knee, ~11% of peak at 3x offered load (SC-001)', () => {
    expect(collapseForwardedRPS(1000, 500)).toBeCloseTo(500 / 3, 5) // 2x -> decay 1/3
    const atThreeX = collapseForwardedRPS(1500, 500) // 3x -> decay 1/9
    expect(atThreeX).toBeCloseTo(500 / 9, 5)
    expect(atThreeX / 500).toBeLessThan(0.2)
  })

  it('collapses toward zero at extreme overload (~100x) without ever reaching exactly zero or Infinity/NaN', () => {
    const atHundredX = collapseForwardedRPS(50_000, 500)
    expect(atHundredX).toBeGreaterThan(0)
    expect(atHundredX).toBeLessThan(1)
    expect(Number.isFinite(atHundredX)).toBe(true)
  })

  it('zero-capacity guard: kneeRPS <= HOST_ZERO_CAPACITY_EPSILON forwards zero, never NaN/Infinity', () => {
    expect(collapseForwardedRPS(100, 0)).toBe(0)
    expect(Number.isFinite(collapseForwardedRPS(100, 0))).toBe(true)
  })

  it('is stateless: the same offered load yields the same goodput whether reached ramping up or down (SC-004)', () => {
    const loads = [250, 500, 1000, 1500, 2500]
    const rampUp = loads.map((rps) => collapseForwardedRPS(rps, 500))
    const rampDown = [...loads].reverse().map((rps) => collapseForwardedRPS(rps, 500))
    expect(rampDown).toEqual([...rampUp].reverse())
  })
})

describe('computeHostMetrics — collapse mode, manual (research.md D1/D6)', () => {
  it('below/at the knee is byte-identical to clamp mode (SC-002 knee-continuity)', () => {
    for (const incomingRPS of [300, 500]) {
      const clamp = computeHostMetrics({
        sim: manualSim({ overloadBehavior: 'clamp' }),
        incomingRPS,
        effectiveReplicas: 1,
        inboundWeightedComputeMultiplier: 1,
        outboundWeightedIoLatencyMs: 0,
      })
      const collapse = computeHostMetrics({
        sim: manualSim({ overloadBehavior: 'collapse' }),
        incomingRPS,
        effectiveReplicas: 1,
        inboundWeightedComputeMultiplier: 1,
        outboundWeightedIoLatencyMs: 0,
      })
      expect(collapse.forwardedRPS).toBe(clamp.forwardedRPS)
      expect(collapse.shedRPS).toBe(clamp.shedRPS)
      expect(collapse.latencyMs).toBeCloseTo(clamp.latencyMs, 10)
    }
  })

  it('bends back down past the knee instead of plateauing, unlike clamp mode', () => {
    const clamp = computeHostMetrics({
      sim: manualSim({ overloadBehavior: 'clamp' }),
      incomingRPS: 1650, // 3x the 550 knee (manualMaxRPS)
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    const collapse = computeHostMetrics({
      sim: manualSim({ overloadBehavior: 'collapse' }),
      incomingRPS: 1650,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(clamp.forwardedRPS).toBe(550) // unchanged clamp regression (SC-003)
    expect(collapse.forwardedRPS).toBeCloseTo(550 / 9, 5) // knee is manualMaxRPS=550
    expect(collapse.forwardedRPS).toBeLessThan(clamp.forwardedRPS)
  })

  it('reports collapsed status once forwardedRPS falls below half the knee, checked before overloaded (research.md D5)', () => {
    const mildlyOver = computeHostMetrics({
      // 1.2x the knee (550): decay ~0.926, forwardedRPS well above the 0.5x threshold.
      sim: manualSim({ overloadBehavior: 'collapse' }),
      incomingRPS: 660,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(mildlyOver.status).toBe('overloaded')

    const collapsed = computeHostMetrics({
      sim: manualSim({ overloadBehavior: 'collapse' }),
      incomingRPS: 1650, // 3x the 550 knee
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(collapsed.status).toBe('collapsed')
  })

  it('never sheds/collapses for a clamp-mode host, regardless of load (SC-003 regression)', () => {
    const metrics = computeHostMetrics({
      sim: manualSim({ overloadBehavior: 'clamp' }),
      incomingRPS: 5000,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(metrics.status).toBe('overloaded')
    expect(metrics.status).not.toBe('collapsed')
  })

  it('latency never improves as goodput collapses past the knee (FR-013)', () => {
    const sim = manualSim({ overloadBehavior: 'collapse', manualSaturationRPS: 2000, manualMaxRPS: 500 })
    const points = [250, 500, 1000, 1500, 2500].map((incomingRPS) =>
      computeHostMetrics({ sim, incomingRPS, effectiveReplicas: 1, inboundWeightedComputeMultiplier: 1, outboundWeightedIoLatencyMs: 0 }),
    )
    // Goodput rises then collapses past the knee...
    expect(points[1].forwardedRPS).toBeGreaterThan(points[0].forwardedRPS)
    expect(points[4].forwardedRPS).toBeLessThan(points[1].forwardedRPS)
    // ...but latency only ever rises, even as goodput craters.
    let previousLatency = points[0].latencyMs
    for (const point of points.slice(1)) {
      expect(point.latencyMs).toBeGreaterThanOrEqual(previousLatency)
      previousLatency = point.latencyMs
    }
  })
})

describe('computeHostMetrics — collapse mode, calculated (research.md D1/D3)', () => {
  it('below/at the knee is byte-identical to clamp mode (SC-002)', () => {
    for (const incomingRPS of [200, 500]) {
      const clamp = computeHostMetrics({
        sim: calculatedSim({ overloadBehavior: 'clamp' }),
        incomingRPS,
        effectiveReplicas: 1,
        inboundWeightedComputeMultiplier: 1,
        outboundWeightedIoLatencyMs: 0,
      })
      const collapse = computeHostMetrics({
        sim: calculatedSim({ overloadBehavior: 'collapse' }),
        incomingRPS,
        effectiveReplicas: 1,
        inboundWeightedComputeMultiplier: 1,
        outboundWeightedIoLatencyMs: 0,
      })
      expect(collapse.forwardedRPS).toBeCloseTo(clamp.forwardedRPS, 5)
      expect(collapse.shedRPS).toBe(clamp.shedRPS)
    }
  })

  it('sheds past rho=1 for the first time — clamp mode never sheds in calculated mode (SC-003 regression)', () => {
    // 16ms * 8 threads => 500 req/s knee at weight 1.
    const clamp = computeHostMetrics({
      sim: calculatedSim({ overloadBehavior: 'clamp' }),
      incomingRPS: 1500,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(clamp.forwardedRPS).toBe(1500)
    expect(clamp.shedRPS).toBe(0)

    const collapse = computeHostMetrics({
      sim: calculatedSim({ overloadBehavior: 'collapse' }),
      incomingRPS: 1500,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(collapse.forwardedRPS).toBeCloseTo(500 / 9, 5)
    expect(collapse.shedRPS).toBeGreaterThan(0)
    expect(collapse.status).toBe('collapsed')
  })

  it('zero-capacity edge case (0 threads) forwards zero via the zero-capacity guard, staying finite', () => {
    const metrics = computeHostMetrics({
      sim: calculatedSim({ overloadBehavior: 'collapse', maxWorkerThreads: 0 }),
      incomingRPS: 100,
      effectiveReplicas: 1,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(metrics.forwardedRPS).toBe(0)
    expect(Number.isFinite(metrics.latencyMs)).toBe(true)
    expect(Number.isFinite(metrics.saturationRatio)).toBe(true)
  })
})

// 012-overload-collapse refinement (research.md D9): elastic hosts
// (minReplicas !== maxReplicas) never use the smooth retrograde curve —
// they behave like clamp while replicas are alive, and go fully dark
// (forwardedRPS=0/shedRPS=incoming/status='collapsed') once effectiveReplicas
// hits 0. Eviction itself is autoscaler.ts's responsibility (see
// autoscaler.test.ts) — this describe block only covers hostModel.ts's side:
// the isElasticGroup flag changing forwarding/status behavior.
describe('computeHostMetrics — elastic scaling group + collapse (research.md D9)', () => {
  it('below the knee is identical to clamp, same as the non-elastic case', () => {
    const clamp = computeHostMetrics({
      sim: manualSim({ overloadBehavior: 'clamp', minReplicas: 1, maxReplicas: 4 }),
      incomingRPS: 400,
      effectiveReplicas: 2,
      isElasticGroup: true,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    const collapse = computeHostMetrics({
      sim: manualSim({ overloadBehavior: 'collapse', minReplicas: 1, maxReplicas: 4 }),
      incomingRPS: 400,
      effectiveReplicas: 2,
      isElasticGroup: true,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(collapse.forwardedRPS).toBe(clamp.forwardedRPS)
    expect(collapse.shedRPS).toBe(clamp.shedRPS)
    expect(collapse.status).toBe(clamp.status)
  })

  it('behaves like clamp (plateau, not retrograde decay) while replicas are alive and overloaded', () => {
    const sim = manualSim({ overloadBehavior: 'collapse', minReplicas: 1, maxReplicas: 4 })
    // 2 effective replicas, knee (manualMaxRPS) = 550 each => total cap 1100.
    const metrics = computeHostMetrics({
      sim,
      incomingRPS: 3300, // 3x the group's total cap
      effectiveReplicas: 2,
      isElasticGroup: true,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    // Clamp-equivalent plateau, NOT the retrograde curve's ~1/9 decay.
    expect(metrics.forwardedRPS).toBeCloseTo(1100, 5)
    expect(metrics.shedRPS).toBeCloseTo(2200, 5)
    expect(metrics.status).toBe('overloaded')
    expect(metrics.status).not.toBe('collapsed')
  })

  it('calculated mode also plateaus (sheds the excess) while replicas are alive — regression for a bug where it forwarded 100% of offered load', () => {
    const sim = calculatedSim({ overloadBehavior: 'collapse', minReplicas: 1, maxReplicas: 4 })
    // 2 effective replicas, knee (capacityRPS at weight 1) = 500 each => total cap 1000.
    const metrics = computeHostMetrics({
      sim,
      incomingRPS: 3000, // 3x the group's total cap
      effectiveReplicas: 2,
      isElasticGroup: true,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(metrics.forwardedRPS).toBeCloseTo(1000, 5)
    expect(metrics.shedRPS).toBeCloseTo(2000, 5)
    expect(metrics.status).toBe('overloaded')
  })

  it('reports the host as fully dead (forwards nothing, sheds everything, status collapsed) at effectiveReplicas=0', () => {
    const sim = manualSim({ overloadBehavior: 'collapse', minReplicas: 1, maxReplicas: 4 })
    const metrics = computeHostMetrics({
      sim,
      incomingRPS: 1000,
      effectiveReplicas: 0,
      isElasticGroup: true,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    expect(metrics.incomingRPS).toBe(1000)
    expect(metrics.forwardedRPS).toBe(0)
    expect(metrics.shedRPS).toBe(1000)
    expect(metrics.status).toBe('collapsed')
    expect(Number.isFinite(metrics.latencyMs)).toBe(true)
    expect(Number.isFinite(metrics.saturationRatio)).toBe(true)
  })

  it('a dead elastic clamp-mode host is unreachable — only collapse hosts can hit effectiveReplicas=0 via eviction, but confirm clamp still divides by the Math.max(1,·) floor if ever called with 0', () => {
    const sim = manualSim({ overloadBehavior: 'clamp', minReplicas: 1, maxReplicas: 4 })
    const metrics = computeHostMetrics({
      sim,
      incomingRPS: 100,
      effectiveReplicas: 0,
      isElasticGroup: true,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    // clamp mode never gets the "virtually dead" branch (collapse-only) —
    // it falls through to the existing Math.max(1, effectiveReplicas) floor.
    expect(metrics.status).not.toBe('collapsed')
  })

  it('a fixed (non-elastic) multi-replica host keeps the original smooth retrograde curve, not clamp/eviction semantics', () => {
    const sim = manualSim({ overloadBehavior: 'collapse', minReplicas: 3, maxReplicas: 3 })
    const metrics = computeHostMetrics({
      sim,
      incomingRPS: 3300, // per-replica: 3300/3 = 1100 = 2x the 550 knee
      effectiveReplicas: 3,
      isElasticGroup: false,
      inboundWeightedComputeMultiplier: 1,
      outboundWeightedIoLatencyMs: 0,
    })
    // Retrograde curve (decay(2) = 1/3 per replica => 550*(1/3)*3 = 550
    // total), NOT the clamp plateau of 1650 — matches the non-elastic
    // single-node collapse fixtures above.
    expect(metrics.forwardedRPS).toBeCloseTo(550, 5)
    expect(metrics.status).toBe('collapsed')
  })
})
