import { KB_PER_MB } from '../../config.js'
import { edgeTrafficShare } from '../../components.js'
import {
  buildQueueBacklogDescriptor,
  validateFormulaDescriptorsHaveSources,
} from '../../formulaCatalog.js'
import { computeQueueMetrics } from '../../queueModel.js'
import type { QueueNodeSim } from '../../ports.js'
import type { NodeModel, Result } from '../nodeModel.js'

function isQueue(raw: unknown): raw is QueueNodeSim {
  return typeof raw === 'object' && raw !== null && (raw as { kind?: string }).kind === 'queue'
}

function validateQueue(raw: unknown): Result<QueueNodeSim> {
  if (!isQueue(raw)) return { ok: false, message: 'SUGAR: queue config is invalid.' }
  return { ok: true, value: raw }
}

function readBacklogGB(state: unknown): number {
  if (typeof state === 'number' && Number.isFinite(state) && state >= 0) return state
  return 0
}

export const queueModel: NodeModel<QueueNodeSim, number> = {
  id: 'queue',
  label: 'Queue',
  paramSchema: { params: [] },
  formulaDescriptors: [],
  validateConfig: validateQueue,
  initialState() {
    return 0
  },
  reconcileState(input) {
    return readBacklogGB(input.previousState)
  },
  acceptCapacityRPS() {
    return Number.POSITIVE_INFINITY
  },
  computeWindow(ctx) {
    let inflowMBps = 0
    for (const edgeId of ctx.incomingEdgeIds) {
      const edge = ctx.graph.edgeById.get(edgeId)
      const rps = ctx.edgeOutputRPS.get(edgeId) ?? 0
      inflowMBps += (rps * (edge?.config.averagePayloadSizeKB ?? 0)) / KB_PER_MB
    }

    const desiredByEdge = new Map<string, number>()
    let totalDesiredMBps = 0
    let hasUnboundedEdge = false
    for (const edgeId of ctx.outgoingEdgeIds) {
      const edge = ctx.graph.edgeById.get(edgeId)
      const share = edgeTrafficShare(edge)
      const acceptRPS = ctx.resolveDownstreamAcceptCapacityRPS(edgeId)
      const desiredMBps =
        Number.isFinite(acceptRPS) && edge
          ? (acceptRPS * share * edge.config.averagePayloadSizeKB) / KB_PER_MB
          : Number.POSITIVE_INFINITY
      desiredByEdge.set(edgeId, desiredMBps)
      if (!Number.isFinite(desiredMBps)) hasUnboundedEdge = true
      else totalDesiredMBps += desiredMBps
    }

    const queueResult = computeQueueMetrics({
      inflowMBps,
      desiredOutflowMBps: hasUnboundedEdge ? Number.POSITIVE_INFINITY : totalDesiredMBps,
      backlogGB: readBacklogGB(ctx.prevState),
      windowSizeMs: ctx.windowSizeMs,
    })

    const edgeOutputRPS = new Map<string, number>()
    for (const edgeId of ctx.outgoingEdgeIds) {
      const edge = ctx.graph.edgeById.get(edgeId)
      const desired = desiredByEdge.get(edgeId) ?? 0
      const edgeShareOfOutflow =
        hasUnboundedEdge || totalDesiredMBps <= 0
          ? edgeTrafficShare(edge)
          : desired / totalDesiredMBps
      const edgeMBps = queueResult.outflowMBps * edgeShareOfOutflow
      const payloadKB = edge?.config.averagePayloadSizeKB ?? 0
      edgeOutputRPS.set(edgeId, payloadKB > 0 ? (edgeMBps * KB_PER_MB) / payloadKB : 0)
    }

    const throughputPerSec = [...edgeOutputRPS.values()].reduce((sum, rps) => sum + rps, 0)
    const backlogDescriptor = buildQueueBacklogDescriptor(queueResult)
    validateFormulaDescriptorsHaveSources([backlogDescriptor])

    return {
      metrics: {
        throughputPerSec,
        queueDepth: queueResult.backlogGB * 1024,
        queue: {
          inflowMBps: queueResult.inflowMBps,
          outflowMBps: queueResult.outflowMBps,
          backlogGB: queueResult.backlogGB,
        },
        formulaDescriptors: [backlogDescriptor],
      },
      nextState: queueResult.backlogGB,
      edgeOutputRPS,
    }
  },
}
