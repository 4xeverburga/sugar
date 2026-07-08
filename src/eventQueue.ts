// Binary-heap future-event list keyed by virtual time (research.md D1).
// Kept generic over the event payload so the DES loop (simulation.ts) can
// use it without this module knowing about node ids or event kinds.

export interface ScheduledEvent<T> {
  timeMs: number
  payload: T
}

export class EventQueue<T> {
  private heap: ScheduledEvent<T>[] = []

  get size(): number {
    return this.heap.length
  }

  schedule(timeMs: number, payload: T): void {
    this.heap.push({ timeMs, payload })
    this.bubbleUp(this.heap.length - 1)
  }

  peek(): ScheduledEvent<T> | undefined {
    return this.heap[0]
  }

  popMin(): ScheduledEvent<T> | undefined {
    const size = this.heap.length
    if (size === 0) return undefined
    const min = this.heap[0]
    const last = this.heap.pop()
    if (size > 1 && last) {
      this.heap[0] = last
      this.bubbleDown(0)
    }
    return min
  }

  clear(): void {
    this.heap = []
  }

  private bubbleUp(index: number): void {
    let i = index
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2)
      if (this.heap[parent].timeMs <= this.heap[i].timeMs) break
      this.swap(parent, i)
      i = parent
    }
  }

  private bubbleDown(index: number): void {
    let i = index
    const size = this.heap.length
    for (;;) {
      const left = i * 2 + 1
      const right = i * 2 + 2
      let smallest = i
      if (left < size && this.heap[left].timeMs < this.heap[smallest].timeMs) smallest = left
      if (right < size && this.heap[right].timeMs < this.heap[smallest].timeMs) smallest = right
      if (smallest === i) break
      this.swap(i, smallest)
      i = smallest
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.heap[a]
    this.heap[a] = this.heap[b]
    this.heap[b] = tmp
  }
}
