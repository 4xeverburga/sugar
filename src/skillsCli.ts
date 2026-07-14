#!/usr/bin/env node
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as {
  name: string
  version: string
  repository?: string | { type?: string; url?: string }
}

const HELP_TEXT = `${pkg.name} installer v${pkg.version}

Usage:
  sugar-skills install [owner/repo] [skills add flags]
  sugar-skills --help

Examples:
  npx sugar-skills install
  npx sugar-skills install chiffonstack/sugar
  npx sugar-skills install --global

Notes:
  - This command wraps: npx skills add <source>
  - If <source> is omitted, it is inferred from package.json repository URL.
`

export interface InstallerIO {
  out: (line: string) => void
  err: (line: string) => void
}

export interface ExecResult {
  status: number | null
  error?: Error
}

export type SkillsAddExecutor = (args: string[]) => ExecResult

function repositoryUrlFromPackage(repository: string | { type?: string; url?: string } | undefined): string | undefined {
  if (typeof repository === 'string') return repository
  if (repository && typeof repository.url === 'string') return repository.url
  return undefined
}

export function inferSkillSourceFromRepositoryUrl(repositoryUrl: string): string | undefined {
  const sanitized = repositoryUrl.replace(/^git\+/, '')
  const match = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i.exec(sanitized)
  if (!match) return undefined
  return `${match[1]}/${match[2]}`
}

function resolveDefaultSkillSource(): string | undefined {
  const repositoryUrl = repositoryUrlFromPackage(pkg.repository)
  if (!repositoryUrl) return undefined
  return inferSkillSourceFromRepositoryUrl(repositoryUrl)
}

/**
 * CLI entry point for `sugar-skills install`.
 */
export function runSkillsInstaller(argv: string[], io: InstallerIO, executor: SkillsAddExecutor): number {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === '-h') {
    io.out(HELP_TEXT)
    return 0
  }
  if (command !== 'install') {
    io.err(`Unknown command: ${command}`)
    io.out(HELP_TEXT)
    return 1
  }

  let sourceArg: string | undefined
  const passThroughArgs: string[] = []
  for (const arg of rest) {
    if (sourceArg === undefined && !arg.startsWith('-')) {
      sourceArg = arg
      continue
    }
    passThroughArgs.push(arg)
  }

  const source = sourceArg ?? resolveDefaultSkillSource()
  if (!source) {
    io.err('SUGAR: could not infer a default skill source from package.json repository URL.')
    io.err('Provide one explicitly, e.g.: sugar-skills install owner/repo')
    return 1
  }

  const args = ['--yes', 'skills', 'add', source, ...passThroughArgs]
  const result = executor(args)
  if (result.error) {
    io.err(result.error.message)
    return 1
  }
  return result.status ?? 1
}
