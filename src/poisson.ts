import type { TrafficSourcePort } from './ports.js'

/** A source of uniform floats in [0, 1). */
export type RandomSource = () => number

// mulberry32 — ~10 lines, public domain. Seedable so engine tests are
// deterministic (SC-005) without mocking Math.random (research.md D3).
export function mulberry32(seed: number): RandomSource {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Exponential inter-arrival sampling via inverse transform of the CDF
// (research.md D3): for a Poisson process at meanRatePerSec, inter-arrival
// times are exponentially distributed with mean 1/meanRatePerSec.
export class PoissonTrafficSource implements TrafficSourcePort {
  private readonly random: RandomSource

  constructor(random: RandomSource) {
    this.random = random
  }

  nextInterArrivalMs(meanRatePerSec: number): number {
    if (meanRatePerSec <= 0) return Infinity
    // 1 - random() keeps the argument to ln in (0, 1], avoiding ln(0).
    const u = 1 - this.random()
    return (-Math.log(u) / meanRatePerSec) * 1000
  }
}
