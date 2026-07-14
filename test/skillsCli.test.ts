import { describe, expect, it } from 'vitest'
import { inferSkillSourceFromRepositoryUrl, runSkillsInstaller, type InstallerIO, type SkillsAddExecutor } from '../src/skillsCli'

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

  it('runs skills add for install using explicit source', () => {
    const calls: string[][] = []
    const exec: SkillsAddExecutor = (args) => {
      calls.push(args)
      return { status: 0 }
    }
    const c = capture()
    const code = runSkillsInstaller(['install', 'chiffonstack/sugar', '--global'], c.io, exec)

    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['--yes', 'skills', 'add', 'chiffonstack/sugar', '--global'])
  })

  it('prints help for empty args', () => {
    const exec: SkillsAddExecutor = () => ({ status: 0 })
    const c = capture()
    const code = runSkillsInstaller([], c.io, exec)

    expect(code).toBe(0)
    expect(c.out()).toContain('Usage:')
  })

  it('fails for unknown commands', () => {
    const exec: SkillsAddExecutor = () => ({ status: 0 })
    const c = capture()
    const code = runSkillsInstaller(['deploy'], c.io, exec)

    expect(code).toBe(1)
    expect(c.err()).toContain('Unknown command')
  })
})
