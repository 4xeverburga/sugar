#!/usr/bin/env node
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { parseDiagramTopology } from './diagramInput.js'
import { runSimulation, DEFAULT_RUN_SEED } from './runner.js'
import { summarizeRun, type RunSummary } from './summary.js'
import { sweepParam, type SweepResult } from './sweep.js'
import { CycleError } from './ports.js'
import { SIM_TICK_MS } from './config.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { name: string; version: string; description: string }

const HELP_TEXT = `${pkg.name} v${pkg.version}
${pkg.description}

Usage:
  sugar run <diagram.json> [options]     Simulate a topology and print a summary
  sugar sweep <diagram.json> [options]   Find the breaking point of one parameter
  sugar install                          Confirm the CLI is installed
  sugar --version                        Print the installed version
  sugar --help                           Show this help

run options:
  --duration <t>   Simulated time to run (e.g. 300s, 5m, 200000ms). Default 120s.
  --window <ms>    Metrics window size in ms. Default ${SIM_TICK_MS}.
  --seed <n>       Poisson seed for reproducibility. Default ${DEFAULT_RUN_SEED}.
  --json           Emit the machine-readable summary as JSON.
  --raw            Emit every raw metrics window as JSON (large; for tooling).

sweep options:
  --param <id.field>   Numeric node field to vary, e.g. web-client.requestRatePerSec
  --from <n>           Range start (a value the system holds at).
  --to <n>             Range end (a value the system breaks at).
  --duration <t>       Simulated time per trial. Default 120s.
  --window <ms>        Metrics window size in ms. Default ${SIM_TICK_MS}.
  --seed <n>           Poisson seed. Default ${DEFAULT_RUN_SEED}.
  --json               Emit the machine-readable sweep result as JSON.

Diagram JSON is the format the SUGAR canvas exports and this CLI reads (see
SCHEMA.md). Read a topology from a file path or "-" for stdin.
`

/** Output sink so the command logic is testable without capturing globals. */
export interface CliIO {
  out: (line: string) => void
  err: (line: string) => void
}

interface Flags {
  positionals: string[]
  options: Map<string, string>
  booleans: Set<string>
}

// Minimal argv parser: "--flag value" for the known value flags, "--flag"
// for the known booleans. No dependency, no surprises — the flag set is
// small and fixed.
const BOOLEAN_FLAGS = new Set(['--json', '--raw', '--help', '-h', '--version', '-v'])

function parseFlags(argv: string[]): Flags {
  const positionals: string[] = []
  const options = new Map<string, string>()
  const booleans = new Set<string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--') || arg === '-h' || arg === '-v') {
      if (BOOLEAN_FLAGS.has(arg)) {
        booleans.add(arg)
      } else {
        const next = argv[i + 1]
        if (next === undefined) throw new CliError(`SUGAR: flag "${arg}" expects a value.`)
        options.set(arg, next)
        i += 1
      }
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, options, booleans }
}

// Parses "300s" / "5m" / "200000ms" / bare seconds -> milliseconds.
function parseDuration(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(raw.trim())
  if (!match) throw new CliError(`SUGAR: invalid duration "${raw}" (use e.g. 300s, 5m, 200000ms).`)
  const value = Number(match[1])
  switch (match[2]) {
    case 'ms':
      return value
    case 'm':
      return value * 60_000
    case 's':
    case undefined:
    default:
      return value * 1000
  }
}

function parseNumberFlag(flags: Flags, flag: string, fallback: number): number {
  const raw = flags.options.get(flag)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new CliError(`SUGAR: flag "${flag}" expects a number, got "${raw}".`)
  return value
}

function readTopologySource(pathOrDash: string): string {
  if (pathOrDash === '-') return readFileSync(0, 'utf-8')
  return readFileSync(pathOrDash, 'utf-8')
}

function round(value: number, places = 2): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function formatSeconds(ms: number): string {
  return `${round(ms / 1000, 1)}s`
}

// Human-readable summary render (the CLI default; --json emits the object).
function renderSummary(summary: RunSummary, warnings: string[]): string {
  const lines: string[] = []
  for (const warning of warnings) lines.push(`! ${warning}`)
  lines.push(
    `Simulated ${formatSeconds(summary.durationMs)} (${summary.windowCount} windows, ${summary.windowSizeMs}ms each, seed ${summary.seed})`,
  )
  lines.push('')
  lines.push('Steady state per node:')
  for (const node of summary.nodes) {
    if (node.kind === 'host') {
      const parts = [
        `  ${node.label} [${node.status}]`,
        `rho=${round(node.saturationRatio)}`,
        `latency=${round(node.latencyMs)}ms`,
        `in=${round(node.incomingRPS)}rps`,
        `fwd=${round(node.forwardedRPS)}rps`,
      ]
      if (node.shedRPS > 0) parts.push(`shed=${round(node.shedRPS)}rps`)
      if (node.replicas) parts.push(`replicas=${node.replicas.finalNominal} (max ${node.replicas.maxNominal}, ${node.replicas.scalingEventCount} events)`)
      lines.push(parts.join('  '))
    } else {
      const parts = [
        `  ${node.label} [queue]`,
        `backlog=${round(node.backlogGB, 3)}GB`,
        `in=${round(node.inflowMBps)}MB/s`,
        `out=${round(node.outflowMBps)}MB/s`,
      ]
      if (node.backlogGrowthGBPerSec > 1e-6) parts.push(`growing +${round(node.backlogGrowthGBPerSec, 3)}GB/s`)
      lines.push(parts.join('  '))
    }
  }
  lines.push('')
  if (summary.firstSaturationOrder.length === 0) {
    lines.push('No node left a healthy state — the system held for the whole run.')
  } else {
    lines.push('First-saturation order:')
    for (const event of summary.firstSaturationOrder) {
      lines.push(`  ${event.label} -> ${event.status} at ${formatSeconds(event.atMs)}`)
    }
    if (summary.bottleneckNodeId) {
      const bottleneck = summary.nodes.find((node) => node.id === summary.bottleneckNodeId)
      lines.push('')
      lines.push(`Bottleneck: ${bottleneck?.label ?? summary.bottleneckNodeId} saturates first.`)
    }
  }
  if (summary.totalScalingEvents > 0) lines.push(`Autoscaling: ${summary.totalScalingEvents} scaling event(s) across the run.`)
  return lines.join('\n')
}

function renderSweep(result: SweepResult): string {
  const lines: string[] = []
  lines.push(`Swept ${result.param} over [${result.from}, ${result.to}] in ${result.iterations} trials.`)
  lines.push('')
  if (result.largestHolding === null) {
    lines.push(`The system already breaks at the minimum (${result.from}).`)
    const b = result.smallestBreaking
    if (b?.bottleneckNodeId) lines.push(`First to give: ${bottleneckLabel(b)}.`)
    return lines.join('\n')
  }
  if (result.smallestBreaking === null) {
    lines.push(`The system holds across the whole range — no break up to ${result.to}.`)
    return lines.join('\n')
  }
  lines.push(`Holds up to ~${round(result.largestHolding.value)}.`)
  lines.push(`Breaks at ~${round(result.smallestBreaking.value)} (breaking point).`)
  const label = bottleneckLabel(result.smallestBreaking)
  if (label) lines.push(`First to give at the breaking point: ${label}.`)
  return lines.join('\n')
}

function bottleneckLabel(point: { bottleneckNodeId: string | null; summary: RunSummary }): string | null {
  if (!point.bottleneckNodeId) return null
  const node = point.summary.nodes.find((n) => n.id === point.bottleneckNodeId)
  return node?.label ?? point.bottleneckNodeId
}

// Thrown for any user-facing failure (bad flags, missing file, cycle, empty
// topology). runCli catches it, prints the message, and returns exit code 1 —
// so command logic can `throw` linearly instead of threading exit codes.
class CliError extends Error {}

function runCommand(flags: Flags, io: CliIO): void {
  const source = flags.positionals[1]
  if (!source) throw new CliError('SUGAR: `run` needs a diagram path (or "-" for stdin).')
  const { topology, labels, warnings } = parseDiagramTopology(readTopologySource(source))
  if (topology.nodes.length === 0) throw new CliError('SUGAR: this diagram has no simulatable nodes (assign a host/queue role first).')

  const durationMs = parseDuration(flags.options.get('--duration') ?? '120s')
  const windowSizeMs = parseNumberFlag(flags, '--window', SIM_TICK_MS)
  const seed = parseNumberFlag(flags, '--seed', DEFAULT_RUN_SEED)

  let result
  try {
    result = runSimulation(topology, { durationMs, windowSizeMs, seed })
  } catch (error) {
    if (error instanceof CycleError) throw new CliError(`SUGAR: ${error.message}`)
    throw error
  }

  if (flags.booleans.has('--raw')) {
    io.out(JSON.stringify(result.windows))
    return
  }
  const summary = summarizeRun(result.windows, result, labels)
  if (flags.booleans.has('--json')) {
    io.out(JSON.stringify({ warnings, summary }, null, 2))
    return
  }
  io.out(renderSummary(summary, warnings))
}

function sweepCommand(flags: Flags, io: CliIO): void {
  const source = flags.positionals[1]
  if (!source) throw new CliError('SUGAR: `sweep` needs a diagram path (or "-" for stdin).')
  const param = flags.options.get('--param')
  if (!param) throw new CliError('SUGAR: `sweep` needs --param <nodeId>.<field>.')
  const from = flags.options.get('--from')
  const to = flags.options.get('--to')
  if (from === undefined || to === undefined) throw new CliError('SUGAR: `sweep` needs both --from and --to.')

  const diagramValue = JSON.parse(readTopologySource(source)) as unknown
  const durationMs = parseDuration(flags.options.get('--duration') ?? '120s')
  const windowSizeMs = parseNumberFlag(flags, '--window', SIM_TICK_MS)
  const seed = parseNumberFlag(flags, '--seed', DEFAULT_RUN_SEED)

  let result: SweepResult
  try {
    result = sweepParam(diagramValue, { param, from: Number(from), to: Number(to), durationMs, windowSizeMs, seed })
  } catch (error) {
    if (error instanceof CycleError) throw new CliError(`SUGAR: ${error.message}`)
    if (error instanceof Error) throw new CliError(error.message)
    throw error
  }

  if (flags.booleans.has('--json')) {
    io.out(JSON.stringify(result, null, 2))
    return
  }
  io.out(renderSweep(result))
}

/**
 * Run the CLI with the given argv (without the node/script prefix) and return
 * a process exit code. All output goes through `io`, so this is exercised
 * directly in tests — the bin wrapper at the bottom is the only place that
 * touches process globals.
 */
export function runCli(argv: string[], io: CliIO): number {
  let flags: Flags
  try {
    flags = parseFlags(argv)
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
  const [command] = flags.positionals

  try {
    if (flags.booleans.has('--version') || flags.booleans.has('-v')) {
      io.out(pkg.version)
      return 0
    }
    if (command === 'run') {
      runCommand(flags, io)
      return 0
    }
    if (command === 'sweep') {
      sweepCommand(flags, io)
      return 0
    }
    if (command === 'install') {
      io.out(`${pkg.name} v${pkg.version} is installed and ready.\nRun "sugar --help" to see available commands.`)
      return 0
    }
    if (!command || flags.booleans.has('--help') || flags.booleans.has('-h')) {
      io.out(HELP_TEXT)
      return 0
    }
    io.err(`Unknown command: ${command}\n`)
    io.out(HELP_TEXT)
    return 1
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message)
      return 1
    }
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}
