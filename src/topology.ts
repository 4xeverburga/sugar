// Pure, xyflow-free topology assembly (assessment.md A2). Accepts a
// structural node/edge shape — the same one any headless consumer (CLI
// runner, tests, future non-React UI) would build — rather than React
// Flow's `Node`/`Edge` types. The app layer (src/sim/store.ts) is
// responsible for unwrapping xyflow's `data.sim`/`data.simConfig` into this
// shape before calling in.

import type { EdgeSimConfig, NodeSim, SimTopology } from './ports.js'

export interface TopologyNodeInput {
  id: string
  sim: NodeSim | undefined
}

export interface TopologyEdgeInput {
  id: string
  source: string
  target: string
  config: EdgeSimConfig | undefined
}

// Builds the engine's SimTopology view (data-model.md): only nodes
// carrying a `sim` role participate, and only edges between two
// participating nodes that also carry a full EdgeSimConfig are included
// (an edge missing its config isn't ready to simulate yet — e.g.
// mid-authoring — so it's simply omitted rather than guessing default
// values, per CLAUDE.md's no-default-parameters rule).
export function buildSimTopology(nodes: TopologyNodeInput[], edges: TopologyEdgeInput[]): SimTopology {
  const simNodeIds = new Set<string>()
  const topologyNodes = nodes.flatMap((node) => {
    if (!node.sim) return []
    simNodeIds.add(node.id)
    return [{ id: node.id, sim: node.sim }]
  })
  const topologyEdges = edges.flatMap((edge) => {
    if (!simNodeIds.has(edge.source) || !simNodeIds.has(edge.target)) return []
    if (!edge.config) return []
    return [{ id: edge.id, source: edge.source, target: edge.target, config: edge.config }]
  })
  return { nodes: topologyNodes, edges: topologyEdges }
}

// A simulation needs at least one traffic source to be worth running —
// exactly one host profile emits traffic without any inbound edges: the
// client pool (data-model.md).
export function hasGeneratorRole(nodes: TopologyNodeInput[]): boolean {
  return nodes.some((node) => node.sim?.kind === 'host' && node.sim.profile === 'client_pool')
}
