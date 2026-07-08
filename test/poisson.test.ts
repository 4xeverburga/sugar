import { describe, expect, it } from 'vitest'
import { mulberry32, PoissonTrafficSource } from '../src/poisson'

describe('mulberry32', () => {
  it('is deterministic given the same seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const seqA = Array.from({ length: 20 }, () => a())
    const seqB = Array.from({ length: 20 }, () => b())
    expect(seqA).toEqual(seqB)
  })

  it('produces values in [0, 1)', () => {
    const random = mulberry32(1)
    for (let i = 0; i < 1000; i += 1) {
      const value = random()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('PoissonTrafficSource', () => {
  it('is deterministic given a seeded random source', () => {
    const sourceA = new PoissonTrafficSource(mulberry32(7))
    const sourceB = new PoissonTrafficSource(mulberry32(7))
    const seqA = Array.from({ length: 50 }, () => sourceA.nextInterArrivalMs(100))
    const seqB = Array.from({ length: 50 }, () => sourceB.nextInterArrivalMs(100))
    expect(seqA).toEqual(seqB)
  })

  it('mean inter-arrival converges to 1000/rate ms as sample size grows', () => {
    const source = new PoissonTrafficSource(mulberry32(123))
    const ratePerSec = 100
    const samples = Array.from({ length: 20000 }, () => source.nextInterArrivalMs(ratePerSec))
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
    expect(mean).toBeGreaterThan(8)
    expect(mean).toBeLessThan(12)
  })

  it('returns Infinity for a zero or negative rate (no arrivals)', () => {
    const source = new PoissonTrafficSource(mulberry32(1))
    expect(source.nextInterArrivalMs(0)).toBe(Infinity)
    expect(source.nextInterArrivalMs(-5)).toBe(Infinity)
  })

  it('always returns a positive, finite delay for a positive rate', () => {
    const source = new PoissonTrafficSource(mulberry32(9))
    for (let i = 0; i < 200; i += 1) {
      const delay = source.nextInterArrivalMs(50)
      expect(delay).toBeGreaterThan(0)
      expect(Number.isFinite(delay)).toBe(true)
    }
  })
})
