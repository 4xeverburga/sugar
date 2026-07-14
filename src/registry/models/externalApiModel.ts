import { edgeTrafficShare } from '../../components.js'
import { computeExternalApiMetrics } from '../../hostModel.js'
import type { HostNodeSim } from '../../ports.js'
import type { NodeModel, Result } from '../nodeModel.js'

function isExternalApi(raw: unknown): raw is Extract<HostNodeSim, { profile: 'external_api' }> {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: string }).kind === 'host' &&
    (raw as { profile?: string }).profile === 'external_api' &&
    typeof (raw as { manualBaselineLatencyMs?: unknown }).manualBaselineLatencyMs === 'number'
  )
}

function validateExternalApi(raw: unknown): Result<Extract<HostNodeSim, { profile: 'external_api' }>> {
  if (!isExternalApi(raw)) {
    return { ok: false, message: 'SUGAR: external_api config is invalid.' }
  }
  if (raw.manualBaselineLatencyMs < 0) {
    return { ok: false, message: 'SUGAR: external_api manualBaselineLatencyMs must be >= 0.' }
  }
  return { ok: true, value: raw }
}

export const externalApiModel: NodeModel<Extract<HostNodeSim, { profile: 'external_api' }>, null> = {
  id: 'external_api',
  label: 'External API',
  paramSchema: {
    params: [{ name: 'manualBaselineLatencyMs', type: 'number', min: 0, unit: 'ms' }],
  },
  formulaDescriptors: [],
  validateConfig: validateExternalApi,
  initialState() {
    return null
  },
  reconcileState() {
    return null
  },
  acceptCapacityRPS() {
    return Number.POSITIVE_INFINITY
  },
  computeWindow(ctx) {
    const metrics = computeExternalApiMetrics(ctx.incomingRPS, ctx.config.manualBaselineLatencyMs)
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
