import type { NodeSim } from '../ports.js'

export function resolveModelId(sim: NodeSim): string {
  if (sim.kind === 'queue') return 'queue'
  if (sim.kind === 'host') {
    if (sim.profile === 'client_pool') return 'client_pool'
    if (sim.profile === 'external_api') return 'external_api'
    return 'saturating_host'
  }
  const dynamicKind = (sim as { kind?: unknown }).kind
  return typeof dynamicKind === 'string' ? dynamicKind : ''
}
