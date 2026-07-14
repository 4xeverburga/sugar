import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import {
  inferSkillSourceFromRepositoryUrl,
  runSkillsInstaller,
  type InstallerIO,
  type InstallerExecutors,
} from '../src/skillsCli'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { name: string; version: string }
const runtimePackageSpec = `${pkg.name}@${pkg.version}`

function capture(): { io: InstallerIO; out: () => string; err: () => string } {
  const outLines: string[] = []
  const errLines: string[] = []
  return {
    io: {
      out: (line) => outLines.push(line),
      err: (line) => errLines.push(line),
    },
    out: () => outLines.join('\n'),
    err: () => errLines.join('\n'),
  }
}

describe('skills installer cli', () => {
  it('extracts owner/repo from common GitHub repository URL forms', () => {
    expect(inferSkillSourceFromRepositoryUrl('git+https://github.com/4xeverburga/sugar.git')).toBe('4xeverburga/sugar')
    expect(inferSkillSourceFromRepositoryUrl('https://github.com/4xeverburga/sugar')).toBe('4xeverburga/sugar')
    expect(inferSkillSourceFromRepositoryUrl('git@github.com:4xeverburga/sugar.git')).toBe('4xeverburga/sugar')
    expect(inferSkillSourceFromRepositoryUrl('https://gitlab.com/foo/bar')).toBeUndefined()
  })

  it('runs skills add and runtime install by default', () => {
    const skillsCalls: string[][] = []
    const runtimeCalls: string[][] = []
    const executors: InstallerExecutors = {
      skillsAdd: (args) => {
        skillsCalls.push(args)
        return { status: 0 }
      },
      runtimeInstall: (args) => {
        runtimeCalls.push(args)
        return { status: 0 }
      },
    }
    const c = capture()
    const code = runSkillsInstaller(['install', 'chiffonstack/sugar', '--global'], c.io, executors)

    expect(code).toBe(0)
    expect(skillsCalls).toHaveLength(1)
    expect(runtimeCalls).toHaveLength(1)
    expect(skillsCalls[0]).toEqual(['--yes', 'skills', 'add', 'chiffonstack/sugar', '--global'])
    expect(runtimeCalls[0]).toEqual(['install', '--prefix', '.sugar', '--no-save', runtimePackageSpec])
    expect(c.out()).toContain('SUGAR =')
    expect(c.out()).toContain('Runtime Systems')
  })

  it('supports --no-runtime to install only skill metadata', () => {
    const runtimeCalls: string[][] = []
    const executors: InstallerExecutors = {
      skillsAdd: () => ({ status: 0 }),
      runtimeInstall: (args) => {
        runtimeCalls.push(args)
        return { status: 0 }
      },
    }
    const c = capture()
    const code = runSkillsInstaller(['install', 'chiffonstack/sugar', '--no-runtime'], c.io, executors)

    expect(code).toBe(0)
    expect(runtimeCalls).toHaveLength(0)
    expect(c.out()).toContain('Runtime install skipped')
    expect(c.out()).toContain('SUGAR =')
  })

  it('supports --runtime-dir to place runtime under a custom folder', () => {
    const runtimeCalls: string[][] = []
    const executors: InstallerExecutors = {
      skillsAdd: () => ({ status: 0 }),
      runtimeInstall: (args) => {
        runtimeCalls.push(args)
        return { status: 0 }
      },
    }
    const c = capture()
    const code = runSkillsInstaller(['install', 'chiffonstack/sugar', '--runtime-dir', '.sugar-custom'], c.io, executors)

    expect(code).toBe(0)
    expect(runtimeCalls).toHaveLength(1)
    expect(runtimeCalls[0]).toEqual(['install', '--prefix', '.sugar-custom', '--no-save', runtimePackageSpec])
  })

  it('fails when --runtime-dir is missing a value', () => {
    const executors: InstallerExecutors = {
      skillsAdd: () => ({ status: 0 }),
      runtimeInstall: () => ({ status: 0 }),
    }
    const c = capture()
    const code = runSkillsInstaller(['install', '--runtime-dir'], c.io, executors)

    expect(code).toBe(1)
    expect(c.err()).toContain('--runtime-dir expects a path value')
  })

  it('prints help for empty args', () => {
    const executors: InstallerExecutors = {
      skillsAdd: () => ({ status: 0 }),
      runtimeInstall: () => ({ status: 0 }),
    }
    const c = capture()
    const code = runSkillsInstaller([], c.io, executors)

    expect(code).toBe(0)
    expect(c.out()).toContain('Usage:')
  })

  it('fails for unknown commands', () => {
    const executors: InstallerExecutors = {
      skillsAdd: () => ({ status: 0 }),
      runtimeInstall: () => ({ status: 0 }),
    }
    const c = capture()
    const code = runSkillsInstaller(['deploy'], c.io, executors)

    expect(code).toBe(1)
    expect(c.err()).toContain('Unknown command')
  })
})
