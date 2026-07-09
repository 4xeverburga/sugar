import type { SimTopology } from './ports.js'

// Above this per-client-pool rate, per-item event scheduling would burn CPU
// for no observable difference once metrics are windowed — the client pool
// switches to fixed-cadence batches instead (research.md D1, formerly D2).
export const GENERATOR_BATCH_RATE_THRESHOLD_PER_SEC = 5000
export const GENERATOR_BATCH_SUBINTERVALS_PER_WINDOW = 10

export interface TopologyGraph {
  nodeIds: string[]
  simByNode: Map<string, SimTopology['nodes'][number]['sim']>
  outgoingEdgesByNode: Map<string, string[]>
  incomingEdgesByNode: Map<string, string[]>
  edgeById: Map<string, { source: string; target: string; config: SimTopology['edges'][number]['config'] }>
  generatorNodeIds: string[]
  /** Kahn topological order over the simulated subgraph, computed once at
   *  load time (research.md D5) — client pools first, then every
   *  downstream host/queue in dependency order. Absent (empty) if the
   *  graph has a cycle; callers must run detectCycle first. */
  topologicalOrder: string[]
}

// Each outgoing edge's `trafficShareRatio` is an INDEPENDENT multiplier on
// its source's output — deliberately NOT normalized across a source's
// edges (spec.md Edge Cases, revised: real systems fan out with both
// "split" and "broadcast" shapes at once. A ratio of 1.0 means "this call
// happens for every upstream request" — e.g. a host that makes sequential/
// parallel calls to two downstream services should give BOTH edges a
// ratio of 1.0, not 0.5/0.5; multiple edges summing to more than 1 is the
// broadcast/fan-out pattern, not an error. A conditional branch (e.g. "20%
// of requests also hit a slow path") is expressed the same way, just with
// a ratio below 1. Values are clamped at >= 0; an edge with ratio 0 yields
// zero flow on that edge specifically (spec.md "Zero/absent values").
export function edgeTrafficShare(edge: { config: { trafficShareRatio: number } } | undefined): number {
  return Math.max(0, edge?.config.trafficShareRatio ?? 0)
}

export function buildTopologyGraph(topology: SimTopology): TopologyGraph {
  const simByNode = new Map(topology.nodes.map((node) => [node.id, node.sim] as const))
  const outgoingEdgesByNode = new Map<string, string[]>()
  const incomingEdgesByNode = new Map<string, string[]>()
  const edgeById = new Map<string, { source: string; target: string; config: SimTopology['edges'][number]['config'] }>()
  for (const edge of topology.edges) {
    edgeById.set(edge.id, { source: edge.source, target: edge.target, config: edge.config })
    const outgoing = outgoingEdgesByNode.get(edge.source) ?? []
    outgoing.push(edge.id)
    outgoingEdgesByNode.set(edge.source, outgoing)
    const incoming = incomingEdgesByNode.get(edge.target) ?? []
    incoming.push(edge.id)
    incomingEdgesByNode.set(edge.target, incoming)
  }
  const nodeIds = topology.nodes.map((node) => node.id)
  const generatorNodeIds = topology.nodes
    .filter((node) => node.sim.kind === 'host' && node.sim.profile === 'client_pool')
    .map((node) => node.id)

  const graph: TopologyGraph = {
    nodeIds,
    simByNode,
    outgoingEdgesByNode,
    incomingEdgesByNode,
    edgeById,
    generatorNodeIds,
    topologicalOrder: [],
  }
  graph.topologicalOrder = kahnTopologicalOrder(graph)
  return graph
}

// Kahn's algorithm over the simulated subgraph — only nodes carrying a sim
// role participate. Assumes the graph is acyclic (detectCycle must run
// first); returns [] if a cycle makes a full ordering impossible so
// callers never silently propagate through a partial order.
function kahnTopologicalOrder(graph: TopologyGraph): string[] {
  const inDegree = new Map<string, number>()
  for (const nodeId of graph.nodeIds) inDegree.set(nodeId, 0)
  for (const edge of graph.edgeById.values()) {
    if (!inDegree.has(edge.target)) continue
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
  }
  const queue: string[] = graph.nodeIds.filter((nodeId) => (inDegree.get(nodeId) ?? 0) === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const nodeId = queue.shift()!
    order.push(nodeId)
    for (const edgeId of graph.outgoingEdgesByNode.get(nodeId) ?? []) {
      const edge = graph.edgeById.get(edgeId)
      if (!edge || !inDegree.has(edge.target)) continue
      const remaining = (inDegree.get(edge.target) ?? 0) - 1
      inDegree.set(edge.target, remaining)
      if (remaining === 0) queue.push(edge.target)
    }
  }
  return order.length === graph.nodeIds.length ? order : []
}

// DFS cycle detection over the simulated subgraph (only nodes carrying a
// sim role participate). Returns the cycle's node ids (closed loop) if
// found, otherwise undefined. Iterative to avoid stack-depth surprises on
// larger topologies.
export function detectCycle(graph: TopologyGraph): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>()

  for (const startId of graph.nodeIds) {
    if (state.get(startId) === 'done') continue
    const stack: string[] = [startId]
    const path: string[] = []

    while (stack.length > 0) {
      const nodeId = stack[stack.length - 1]
      const status = state.get(nodeId)
      if (status === undefined) {
        state.set(nodeId, 'visiting')
        path.push(nodeId)
        for (const edgeId of graph.outgoingEdgesByNode.get(nodeId) ?? []) {
          const edge = graph.edgeById.get(edgeId)
          if (!edge || !graph.simByNode.has(edge.target)) continue
          const targetStatus = state.get(edge.target)
          if (targetStatus === 'visiting') {
            const cycleStart = path.indexOf(edge.target)
            return path.slice(cycleStart).concat(edge.target)
          }
          if (targetStatus !== 'done') stack.push(edge.target)
        }
        continue
      }
      stack.pop()
      if (status === 'visiting') {
        state.set(nodeId, 'done')
        path.pop()
      }
    }
  }
  return undefined
}

// Fan-out: a node's departures split as evenly as possible across its
// outgoing edges, round-robin by call sequence (data-model.md fan-out rule).
export function nextOutgoingEdgeIndex(previousIndex: number, edgeCount: number): number {
  if (edgeCount <= 0) return 0
  return (previousIndex + 1) % edgeCount
}

// Above GENERATOR_BATCH_RATE_THRESHOLD_PER_SEC, a client pool emits fixed-
// cadence batches (GENERATOR_BATCH_SUBINTERVALS_PER_WINDOW per window)
// instead of one event per arrival (research.md D1).
export function generatorUsesBatchMode(ratePerSec: number): boolean {
  return ratePerSec > GENERATOR_BATCH_RATE_THRESHOLD_PER_SEC
}

// Expected item count for one batch sub-interval, given the client pool's
// mean rate and the window/sub-interval sizing.
export function batchSizeForSubinterval(ratePerSec: number, windowSizeMs: number): number {
  const subIntervalSec = windowSizeMs / GENERATOR_BATCH_SUBINTERVALS_PER_WINDOW / 1000
  return Math.max(0, Math.round(ratePerSec * subIntervalSec))
}

