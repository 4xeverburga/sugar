import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runCli, type CliIO } from '../src/cli'

const examplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples')

// Collect stdout/stderr separately so tests can assert on either stream and
// on the returned exit code — the CLI's whole observable contract.
function capture(): { io: CliIO; out: () => string; err: () => string } {
  const outLines: string[] = []
  const errLines: string[] = []
  return {
    io: { out: (line) => outLines.push(line), err: (line) => errLines.push(line) },
    out: () => outLines.join('\n'),
    err: () => errLines.join('\n'),
  }
}

function example(name: string): string {
  return path.join(examplesDir, name)
}

describe('runCli — meta commands', () => {
  it('prints the version and exits 0', () => {
    const c = capture()
    const pkg = JSON.parse(readFileSync(path.join(examplesDir, '..', 'package.json'), 'utf-8')) as { version: string }
    expect(runCli(['--version'], c.io)).toBe(0)
    expect(c.out()).toBe(pkg.version)
  })

  it('prints help with no args and exits 0', () => {
    const c = capture()
    expect(runCli([], c.io)).toBe(0)
    expect(c.out()).toContain('Usage:')
    expect(c.out()).toContain('sugar run')
    expect(c.out()).toContain('sugar sweep')
  })

  it('reports an unknown command on stderr and exits 1', () => {
    const c = capture()
    expect(runCli(['frobnicate'], c.io)).toBe(1)
    expect(c.err()).toContain('Unknown command')
  })
})

describe('runCli — run', () => {
  it('summarizes a healthy topology and exits 0', () => {
    const c = capture()
    expect(runCli(['run', example('web-tier-and-db.json'), '--duration', '30s'], c.io)).toBe(0)
    expect(c.out()).toContain('Steady state per node:')
    expect(c.out()).toContain('web api')
    expect(c.out()).toContain('held for the whole run')
  })

  it('names the bottleneck for a collapsing topology', () => {
    const c = capture()
    expect(runCli(['run', example('collapse-demo.json'), '--duration', '30s'], c.io)).toBe(0)
    expect(c.out()).toContain('First-saturation order:')
    expect(c.out()).toMatch(/Bottleneck: single api/)
  })

  it('emits valid JSON with --json', () => {
    const c = capture()
    expect(runCli(['run', example('web-tier-and-db.json'), '--duration', '20s', '--json'], c.io)).toBe(0)
    const parsed = JSON.parse(c.out()) as { warnings: unknown[]; summary: { nodes: unknown[]; seed: number } }
    expect(Array.isArray(parsed.summary.nodes)).toBe(true)
    expect(parsed.summary.seed).toBe(42)
  })

  it('is reproducible across two runs at the same seed', () => {
    const a = capture()
    const b = capture()
    runCli(['run', example('checkout-system.json'), '--duration', '20s', '--seed', '7', '--json'], a.io)
    runCli(['run', example('checkout-system.json'), '--duration', '20s', '--seed', '7', '--json'], b.io)
    expect(a.out()).toBe(b.out())
  })

  it('errors (exit 1) when the diagram path is missing', () => {
    const c = capture()
    expect(runCli(['run'], c.io)).toBe(1)
    expect(c.err()).toContain('needs a diagram path')
  })

  it('errors (exit 1) on a topology with no simulatable nodes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sugar-cli-'))
    const file = path.join(dir, 'empty.json')
    writeFileSync(file, JSON.stringify({ nodes: [], edges: [] }))
    const c = capture()
    expect(runCli(['run', file], c.io)).toBe(1)
    expect(c.err()).toContain('no simulatable nodes')
    rmSync(dir, { recursive: true, force: true })
  })

  it('errors (exit 1) on an invalid duration', () => {
    const c = capture()
    expect(runCli(['run', example('web-tier-and-db.json'), '--duration', 'soon'], c.io)).toBe(1)
    expect(c.err()).toContain('invalid duration')
  })
})

describe('runCli — sweep', () => {
  it('finds and reports a breaking point', () => {
    const c = capture()
    expect(
      runCli(['sweep', example('collapse-demo.json'), '--param', 'flood.requestRatePerSec', '--from', '100', '--to', '4000', '--duration', '30s'], c.io),
    ).toBe(0)
    expect(c.out()).toMatch(/Breaks at ~|breaks at the minimum/)
  })

  it('errors (exit 1) when --param is missing', () => {
    const c = capture()
    expect(runCli(['sweep', example('collapse-demo.json'), '--from', '1', '--to', '2'], c.io)).toBe(1)
    expect(c.err()).toContain('--param')
  })

  it('errors (exit 1) on a --param that names a missing node', () => {
    const c = capture()
    expect(
      runCli(['sweep', example('collapse-demo.json'), '--param', 'ghost.requestRatePerSec', '--from', '1', '--to', '2', '--duration', '5s'], c.io),
    ).toBe(1)
    expect(c.err()).toContain('not in the diagram')
  })
})
