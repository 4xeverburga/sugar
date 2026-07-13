// Headless simulation runner (assessment.md A1): loads a SimTopology, ticks
// virtual time as fast as the CPU allows — no wall-clock timers, unlike the
// browser worker (simWorker.ts) which drives the same engine off setInterval
// — and collects every emitted MetricsWindow. This is the pure data layer
// under the CLI: the CLI only does argv parsing, file IO, and formatting.
//
// Determinism (constitution: deterministic engine): given the same topology,
// seed, windowSizeMs, and durationMs, the emitted windows are identical run
// to run and machine to machine. The Poisson source is seeded (mulberry32),
// and time advances in exact windowSizeMs steps so each tick lands on a
// window boundary and flushes exactly one window (createSimulation splits a
// tick into window-sized sub-steps internally, so the outer step size only
// controls how often we hand control back — the results are identical).

import { createSimulation } from './simulation.js'
import { mulberry32, PoissonTrafficSource } from './poisson.js'
import { SIM_TICK_MS } from './config.js'
import type { MetricsWindow, SimTopology } from './ports.js'

export interface RunOptions {
  /** Total simulated time to run, in ms. */
  durationMs: number
  /** Metrics aggregation window in ms. Defaults to SIM_TICK_MS (the value
   *  the browser app uses), so CLI and canvas results line up. */
  windowSizeMs?: number
  /** Poisson seed. Fixed default keeps CLI runs reproducible by default. */
  seed?: number
}

export interface RunResult {
  windows: MetricsWindow[]
  durationMs: number
  windowSizeMs: number
  seed: number
}

export const DEFAULT_RUN_SEED = 42

/**
 * Run a topology for durationMs of simulated time and return every window.
 * Throws CycleError (from loadTopology) if the graph has a cycle.
 */
export function runSimulation(topology: SimTopology, options: RunOptions): RunResult {
  const windowSizeMs = options.windowSizeMs ?? SIM_TICK_MS
  const seed = options.seed ?? DEFAULT_RUN_SEED
  if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) {
    throw new Error('SUGAR: run duration must be a positive number of milliseconds.')
  }
  if (!Number.isFinite(windowSizeMs) || windowSizeMs <= 0) {
    throw new Error('SUGAR: window size must be a positive number of milliseconds.')
  }

  const windows: MetricsWindow[] = []
  const sink = { emitWindow: (window: MetricsWindow) => windows.push(window) }
  const simulation = createSimulation(new PoissonTrafficSource(mulberry32(seed)), sink, windowSizeMs)

  simulation.loadTopology(topology)
  simulation.start()

  // Tick in whole windows so every step flushes exactly one window; the
  // final partial window (if durationMs isn't a multiple of windowSizeMs) is
  // dropped rather than emitted half-aggregated.
  const stepCount = Math.floor(options.durationMs / windowSizeMs)
  for (let i = 0; i < stepCount; i += 1) {
    simulation.tick(windowSizeMs)
  }

  return { windows, durationMs: stepCount * windowSizeMs, windowSizeMs, seed }
}
