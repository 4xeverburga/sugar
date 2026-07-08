import { describe, expect, it } from 'vitest'
import { computeQueueMetrics } from '../src/queueModel'

describe('computeQueueMetrics (SC-004)', () => {
  it('accumulates ~0.6GB of backlog after 60s at 20 MB/s in vs 10 MB/s desired-out (within 5%)', () => {
    let backlogGB = 0
    const windowSizeMs = 1000
    for (let second = 0; second < 60; second += 1) {
      const result = computeQueueMetrics({ inflowMBps: 20, desiredOutflowMBps: 10, backlogGB, windowSizeMs })
      backlogGB = result.backlogGB
    }
    expect(backlogGB).toBeGreaterThan(0.6 * 0.95)
    expect(backlogGB).toBeLessThan(0.6 * 1.05)
  })

  it('drains monotonically to 0 once inflow drops below desired outflow', () => {
    let backlogGB = 0.01
    const windowSizeMs = 1000
    let previous = backlogGB
    for (let second = 0; second < 20; second += 1) {
      const result = computeQueueMetrics({ inflowMBps: 1, desiredOutflowMBps: 5, backlogGB, windowSizeMs })
      backlogGB = result.backlogGB
      expect(backlogGB).toBeLessThanOrEqual(previous)
      previous = backlogGB
    }
    expect(backlogGB).toBeCloseTo(0, 5)
  })

  it('never goes negative even when outflow briefly exceeds inflow plus backlog', () => {
    const result = computeQueueMetrics({ inflowMBps: 1, desiredOutflowMBps: 1000, backlogGB: 0, windowSizeMs: 1000 })
    expect(result.backlogGB).toBeGreaterThanOrEqual(0)
    expect(result.outflowMBps).toBeCloseTo(1, 5)
  })

  it('with no consumer demand (desiredOutflowMBps=0), backlog grows unbounded but stays finite over a long run', () => {
    let backlogGB = 0
    const windowSizeMs = 1000
    for (let second = 0; second < 10_000; second += 1) {
      const result = computeQueueMetrics({ inflowMBps: 5, desiredOutflowMBps: 0, backlogGB, windowSizeMs })
      backlogGB = result.backlogGB
    }
    expect(Number.isFinite(backlogGB)).toBe(true)
    expect(backlogGB).toBeGreaterThan(0)
  })

  it('outflow can never exceed what is actually available (inflow + backlog/windowSec)', () => {
    const result = computeQueueMetrics({ inflowMBps: 2, desiredOutflowMBps: 100, backlogGB: 0, windowSizeMs: 1000 })
    expect(result.outflowMBps).toBeLessThanOrEqual(2)
  })
})
