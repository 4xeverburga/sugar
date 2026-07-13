// Agent-friendly reduction of a run's MetricsWindow[] (assessment.md A2). A
// window per windowSizeMs of sim time would blow any context budget (300s at
// 200ms = 1500 windows), so the runner's default output is this summary:
// steady-state per node, first-saturation ordering, backlog growth, and
// scaling events. Raw windows stay available behind an explicit flag on the
// CLI. Everything here is a pure function of the windows — no engine state.

import type { HostNodeMetrics, MetricsWindow, QueueNodeMetrics } from './ports.js'

export type NodeKind = 'host' | 'queue'

export interface HostNodeSummary {
  id: string
  label: string
  kind: 'host'
  /** Steady state = the last emitted window. */
  status: HostNodeMetrics['status']
  saturationRatio: number
  latencyMs: number
  incomingRPS: number
  forwardedRPS: number
  shedRPS: number
  /** Sim time (ms) this host first left 'healthy', or null if it never did. */
  firstUnhealthyAtMs: number | null
  /** Its status at that first-unhealthy window (saturated/overloaded/collapsed). */
  firstUnhealthyStatus: HostNodeMetrics['status'] | null
  replicas?: {
    finalNominal: number
    maxNominal: number
    scalingEventCount: number
  }
}

export interface QueueNodeSummary {
  id: string
  label: string
  kind: 'queue'
  backlogGB: number
  inflowMBps: number
  outflowMBps: number
  /** (finalBacklog - firstBacklog) / runSeconds; > 0 means an unbounded,
   *  never-draining backlog — the queue's consumers can't keep up. */
  backlogGrowthGBPerSec: number
}

export type NodeSummary = HostNodeSummary | QueueNodeSummary

export interface SaturationEvent {
  nodeId: string
  label: string
  atMs: number
  status: HostNodeMetrics['status']
}

export interface RunSummary {
  durationMs: number
  windowSizeMs: number
  seed: number
  windowCount: number
  nodes: NodeSummary[]
  /** Hosts that went non-healthy, earliest first — "db-1 saturates first at
   *  t=42s". Empty if nothing saturated. */
  firstSaturationOrder: SaturationEvent[]
  /** The first host to leave 'healthy' (tie-break: higher final saturation),
   *  or null if the system stayed healthy the whole run. */
  bottleneckNodeId: string | null
  totalScalingEvents: number
}

const NON_HEALTHY: ReadonlySet<HostNodeMetrics['status']> = new Set(['saturated', 'overloaded', 'collapsed'])

// Steady state is read from a trailing slice of the run, not the single last
// window: a client pool is a Poisson process, so a 200ms window at 150 rps
// sees ~30 arrivals with real variance — one window's snapshot is noisy, and
// every downstream node inherits that noise (flowPropagation derives their
// load from the measured pool rate). Averaging the last quarter of the run
// smooths the sampling noise into a representative settled reading, while
// still reflecting late-run autoscaling because the tail is where the system
// has settled.
const STEADY_STATE_TAIL_FRACTION = 0.25

function labelFor(labels: Map<string, string>, id: string): string {
  return labels.get(id) ?? id
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

// Most-frequent status across the trailing windows — the state the host
// settles into, consistent with the averaged numeric fields (a lone noisy
// window flipping to 'saturated' shouldn't override a healthy tail).
function modalStatus(statuses: HostNodeMetrics['status'][]): HostNodeMetrics['status'] {
  const counts = new Map<HostNodeMetrics['status'], number>()
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1)
  let best: HostNodeMetrics['status'] = statuses[statuses.length - 1] ?? 'healthy'
  let bestCount = -1
  for (const [status, count] of counts) {
    if (count > bestCount) {
      best = status
      bestCount = count
    }
  }
  return best
}

export function summarizeRun(
  windows: MetricsWindow[],
  meta: { durationMs: number; windowSizeMs: number; seed: number },
  labels: Map<string, string> = new Map(),
): RunSummary {
  const last = windows[windows.length - 1]
  const nodeIds = last ? Object.keys(last.nodes) : []

  // First window each host became non-healthy, and its status then.
  const firstUnhealthy = new Map<string, { atMs: number; status: HostNodeMetrics['status'] }>()
  const scalingEventIds = new Map<string, Set<string>>() // node -> unique event keys seen
  for (const window of windows) {
    for (const [nodeId, metrics] of Object.entries(window.nodes)) {
      const host = metrics.host
      if (!host) continue
      if (NON_HEALTHY.has(host.status) && !firstUnhealthy.has(nodeId)) {
        firstUnhealthy.set(nodeId, { atMs: window.windowEndSimTimeMs, status: host.status })
      }
      // Scaling events carry their own simTimeMs, so dedupe across windows
      // (the bounded ring re-reports the same recent events each window).
      const events = host.replicas?.events
      if (events && events.length > 0) {
        const seen = scalingEventIds.get(nodeId) ?? new Set<string>()
        for (const event of events) seen.add(`${event.simTimeMs}:${event.direction}:${event.newCount}`)
        scalingEventIds.set(nodeId, seen)
      }
    }
  }

  const runSeconds = meta.durationMs / 1000
  const tailStart = Math.max(0, windows.length - Math.max(1, Math.floor(windows.length * STEADY_STATE_TAIL_FRACTION)))
  const tail = windows.slice(tailStart)

  const nodes: NodeSummary[] = nodeIds.map((id) => {
    const metrics = last!.nodes[id]
    if (metrics.host) {
      const hosts = tail.map((window) => window.nodes[id]?.host).filter((host): host is HostNodeMetrics => host !== undefined)
      const first = firstUnhealthy.get(id) ?? null
      const summary: HostNodeSummary = {
        id,
        label: labelFor(labels, id),
        kind: 'host',
        status: modalStatus(hosts.map((host) => host.status)),
        saturationRatio: mean(hosts.map((host) => host.saturationRatio)),
        latencyMs: mean(hosts.map((host) => host.latencyMs)),
        incomingRPS: mean(hosts.map((host) => host.incomingRPS)),
        forwardedRPS: mean(hosts.map((host) => host.forwardedRPS)),
        shedRPS: mean(hosts.map((host) => host.shedRPS)),
        firstUnhealthyAtMs: first ? first.atMs : null,
        firstUnhealthyStatus: first ? first.status : null,
      }
      if (metrics.host.replicas) {
        summary.replicas = {
          finalNominal: metrics.host.replicas.nominalCount,
          maxNominal: maxReplicaCount(windows, id),
          scalingEventCount: scalingEventIds.get(id)?.size ?? 0,
        }
      }
      return summary
    }
    // Queue (or a node with neither host nor queue metrics — treat as queue
    // with zeros, which never happens for a valid sim node but keeps the
    // reduction total).
    const queues = tail.map((window) => window.nodes[id]?.queue).filter((queue): queue is QueueNodeMetrics => queue !== undefined)
    const finalBacklog = metrics.queue?.backlogGB ?? 0
    const firstBacklog = firstQueueBacklog(windows, id)
    return {
      id,
      label: labelFor(labels, id),
      kind: 'queue',
      backlogGB: finalBacklog,
      inflowMBps: mean(queues.map((queue) => queue.inflowMBps)),
      outflowMBps: mean(queues.map((queue) => queue.outflowMBps)),
      backlogGrowthGBPerSec: runSeconds > 0 ? (finalBacklog - firstBacklog) / runSeconds : 0,
    } satisfies QueueNodeSummary
  })

  const firstSaturationOrder: SaturationEvent[] = [...firstUnhealthy.entries()]
    .map(([nodeId, v]) => ({ nodeId, label: labelFor(labels, nodeId), atMs: v.atMs, status: v.status }))
    .sort((a, b) => a.atMs - b.atMs)

  const bottleneckNodeId = pickBottleneck(firstSaturationOrder, nodes)
  const totalScalingEvents = [...scalingEventIds.values()].reduce((sum, set) => sum + set.size, 0)

  return {
    durationMs: meta.durationMs,
    windowSizeMs: meta.windowSizeMs,
    seed: meta.seed,
    windowCount: windows.length,
    nodes,
    firstSaturationOrder,
    bottleneckNodeId,
    totalScalingEvents,
  }
}

function maxReplicaCount(windows: MetricsWindow[], nodeId: string): number {
  let max = 0
  for (const window of windows) {
    const count = window.nodes[nodeId]?.host?.replicas?.nominalCount
    if (typeof count === 'number' && count > max) max = count
  }
  return max
}

function firstQueueBacklog(windows: MetricsWindow[], nodeId: string): number {
  for (const window of windows) {
    const backlog = window.nodes[nodeId]?.queue?.backlogGB
    if (typeof backlog === 'number') return backlog
  }
  return 0
}

// The bottleneck is the first host to leave 'healthy'. If several went
// non-healthy in the same window (or none did), fall back to the highest
// final saturation among hosts so there's always a "worst" pointer when the
// system is under stress, and null only when everything stayed healthy.
function pickBottleneck(order: SaturationEvent[], nodes: NodeSummary[]): string | null {
  if (order.length > 0) {
    const earliestMs = order[0].atMs
    const tied = order.filter((event) => event.atMs === earliestMs)
    if (tied.length === 1) return tied[0].nodeId
    const bySaturation = tied
      .map((event) => nodes.find((node): node is HostNodeSummary => node.id === event.nodeId && node.kind === 'host'))
      .filter((node): node is HostNodeSummary => node !== undefined)
      .sort((a, b) => b.saturationRatio - a.saturationRatio)
    return bySaturation[0]?.id ?? tied[0].nodeId
  }
  return null
}
