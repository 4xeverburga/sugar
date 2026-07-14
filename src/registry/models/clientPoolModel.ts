import { edgeTrafficShare } from '../../components.js'
import { computeClientPoolMetrics } from '../../hostModel.js'
import type { HostNodeSim } from '../../ports.js'
import type { NodeModel, Result } from '../nodeModel.js'

function isClientPool(raw: unknown): raw is Extract<HostNodeSim, { profile: 'client_pool' }> {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: string }).kind === 'host' &&
    (raw as { profile?: string }).profile === 'client_pool' &&
    typeof (raw as { requestRatePerSec?: unknown }).requestRatePerSec === 'number'
  )
}

function validateClientPool(raw: unknown): Result<Extract<HostNodeSim, { profile: 'client_pool' }>> {
  if (!isClientPool(raw)) {
    return { ok: false, message: 'SUGAR: client_pool config is invalid.' }
  }
  if (raw.requestRatePerSec < 0) {
    return { ok: false, message: 'SUGAR: client_pool requestRatePerSec must be >= 0.' }
  }
  return { ok: true, value: raw }
}

export const clientPoolModel: NodeModel<Extract<HostNodeSim, { profile: 'client_pool' }>, null> = {
  id: 'client_pool',
  label: 'Client Pool',
  paramSchema: {
    params: [{ name: 'requestRatePerSec', type: 'number', min: 0, unit: 'rps' }],
  },
  formulaDescriptors: [],
  validateConfig: validateClientPool,
  initialState() {
    return null
  },
  reconcileState() {
    return null
  },
  acceptCapacityRPS() {
    return 0
  },
  computeWindow(ctx) {
    const metrics = computeClientPoolMetrics(ctx.incomingRPS)
    const edgeOutputRPS = new Map<string, number>()
    for (const edgeId of ctx.outgoingEdgeIds) {
      edgeOutputRPS.set(edgeId, metrics.forwardedRPS * edgeTrafficShare(ctx.graph.edgeById.get(edgeId)))
    }
    return {
      metrics: {
        throughputPerSec: metrics.forwardedRPS,
        queueDepth: 0,
        host: metrics,
        formulaDescriptors: [],
      },
      nextState: null,
      edgeOutputRPS,
    }
  },
}
