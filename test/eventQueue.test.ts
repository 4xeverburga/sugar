import { describe, expect, it } from 'vitest'
import { EventQueue } from '../src/eventQueue'

describe('EventQueue', () => {
  it('pops events in ascending time order regardless of schedule order', () => {
    const queue = new EventQueue<string>()
    queue.schedule(30, 'c')
    queue.schedule(10, 'a')
    queue.schedule(20, 'b')
    expect(queue.popMin()?.payload).toBe('a')
    expect(queue.popMin()?.payload).toBe('b')
    expect(queue.popMin()?.payload).toBe('c')
  })

  it('preserves schedule order for ties (stable enough for our needs)', () => {
    const queue = new EventQueue<string>()
    queue.schedule(10, 'first')
    queue.schedule(10, 'second')
    const popped = [queue.popMin()?.payload, queue.popMin()?.payload].sort()
    expect(popped).toEqual(['first', 'second'])
  })

  it('returns undefined from peek/popMin when empty', () => {
    const queue = new EventQueue<string>()
    expect(queue.peek()).toBeUndefined()
    expect(queue.popMin()).toBeUndefined()
  })

  it('reports size and clears', () => {
    const queue = new EventQueue<number>()
    queue.schedule(1, 1)
    queue.schedule(2, 2)
    expect(queue.size).toBe(2)
    queue.clear()
    expect(queue.size).toBe(0)
    expect(queue.peek()).toBeUndefined()
  })

  it('handles a larger randomized set correctly (heap invariant sanity check)', () => {
    const queue = new EventQueue<number>()
    const times = Array.from({ length: 500 }, () => Math.random() * 10000)
    for (const t of times) queue.schedule(t, t)
    const popped: number[] = []
    let next = queue.popMin()
    while (next) {
      popped.push(next.timeMs)
      next = queue.popMin()
    }
    const sorted = [...times].sort((a, b) => a - b)
    expect(popped).toEqual(sorted)
  })
})
