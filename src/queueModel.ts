// Zero-configuration queue backlog model (research.md D4). A queue has no
// user-facing parameters (FR-010) — its only state is the backlog itself,
// integrated window over window and floored at 0 (never negative,
// unbounded above — no retention ceiling).

export interface QueueComputeInput {
  /** MB/s arriving this window (sum of inbound edges' RPS × payload size). */
  inflowMBps: number
  /** MB/s the downstream consumers could still accept this window, before
   *  factoring in backlog drain (research.md D4). */
  desiredOutflowMBps: number
  /** Backlog carried over from the previous window, in GB. */
  backlogGB: number
  windowSizeMs: number
}

export interface QueueComputeResult {
  inflowMBps: number
  outflowMBps: number
  /** Backlog at the end of this window, in GB — floored at 0. */
  backlogGB: number
}

const MB_PER_GB = 1024

// Actual outflow can never exceed what's actually available (this window's
// inflow plus whatever's already queued, spread over the window) even if
// downstream demand is higher; it can never exceed downstream demand
// either. Backlog absorbs the difference each window.
export function computeQueueMetrics(input: QueueComputeInput): QueueComputeResult {
  const inflowMBps = Math.max(0, input.inflowMBps)
  const desiredOutflowMBps = Math.max(0, input.desiredOutflowMBps)
  const backlogMB = Math.max(0, input.backlogGB) * MB_PER_GB
  const windowSec = input.windowSizeMs / 1000
  const availableMBps = inflowMBps + (windowSec > 0 ? backlogMB / windowSec : 0)
  const outflowMBps = Math.min(desiredOutflowMBps, availableMBps)
  const backlogDeltaMB = (inflowMBps - outflowMBps) * windowSec
  const nextBacklogMB = Math.max(0, backlogMB + backlogDeltaMB)
  return { inflowMBps, outflowMBps, backlogGB: nextBacklogMB / MB_PER_GB }
}
