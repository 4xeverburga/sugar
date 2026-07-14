#!/usr/bin/env node
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as {
  name: string
  version: string
  repository?: string | { type?: string; url?: string }
}

const DEFAULT_RUNTIME_DIR = '.sugar'

const SUGAR_ASCII_ART = [
  '  _____ _    _  _____          _____  ',
  ' / ____| |  | |/ ____|   /\\   |  __ \\ ',
  '| (___ | |  | | |  __   /  \\  | |__) |',
  ' \\___ \\| |  | | | |_ | / /\\ \\ |  _  / ',
  ' ____) | |__| | |__| |/ ____ \\| | \\ \\ ',
  '|_____/ \\____/ \\_____/_/    \\_\\_|  \\_\\',
]

const SUGAR_ACRONYM_LINES = [
  'SUGAR =',
  '  Simulation',
  '  Utility',
  '  Generally',
  '  Available for',
  '  Runtime Systems',
]

const HELP_TEXT = `${pkg.name} installer v${pkg.version}

Usage:
  sugar-skills install [owner/repo] [options] [skills add flags]
  sugar-skills --help

Examples:
  npx sugar-skills install
  npx sugar-skills install chiffonstack/sugar
  npx sugar-skills install --runtime-dir .sugar --global
  npx sugar-skills install --no-runtime

Notes:
  - This command wraps: npx skills add <source>
  - If <source> is omitted, it is inferred from package.json repository URL.
  - By default, runtime is installed in ./${DEFAULT_RUNTIME_DIR}/ via npm.

Installer options:
  --no-runtime          Skip runtime install (only install skill metadata)
  --runtime-dir <path>  Runtime target directory (default: ${DEFAULT_RUNTIME_DIR})
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
export type RuntimeInstallExecutor = (args: string[]) => ExecResult

export interface InstallerExecutors {
  skillsAdd: SkillsAddExecutor
  runtimeInstall: RuntimeInstallExecutor
}

interface InstallInvocationArgs {
  sourceArg?: string
  passThroughArgs: string[]
  installRuntime: boolean
  runtimeDir: string
  error?: string
}

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

function parseInstallInvocationArgs(args: string[]): InstallInvocationArgs {
  const parsed: InstallInvocationArgs = {
    sourceArg: undefined,
    passThroughArgs: [],
    installRuntime: true,
    runtimeDir: DEFAULT_RUNTIME_DIR,
    error: undefined,
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--no-runtime') {
      parsed.installRuntime = false
      continue
    }
    if (arg === '--runtime-dir') {
      const next = args[i + 1]
      if (next === undefined || next.startsWith('-')) {
        parsed.error = 'SUGAR: --runtime-dir expects a path value.'
        return parsed
      }
      parsed.runtimeDir = next
      i += 1
      continue
    }
    if (parsed.sourceArg === undefined && !arg.startsWith('-')) {
      parsed.sourceArg = arg
      continue
    }
    parsed.passThroughArgs.push(arg)
  }

  return parsed
}

function printSugarAcronym(io: InstallerIO): void {
  for (const line of SUGAR_ASCII_ART) io.out(line)
  io.out('')
  for (const line of SUGAR_ACRONYM_LINES) io.out(line)
}

/**
 * CLI entry point for `sugar-skills install`.
 */
export function runSkillsInstaller(argv: string[], io: InstallerIO, executors: InstallerExecutors): number {
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

  const parsed = parseInstallInvocationArgs(rest)
  if (parsed.error) {
    io.err(parsed.error)
    return 1
  }

  const source = parsed.sourceArg ?? resolveDefaultSkillSource()
  if (!source) {
    io.err('SUGAR: could not infer a default skill source from package.json repository URL.')
    io.err('Provide one explicitly, e.g.: sugar-skills install owner/repo')
    return 1
  }

  const skillsAddResult = executors.skillsAdd(['--yes', 'skills', 'add', source, ...parsed.passThroughArgs])
  if (skillsAddResult.error) {
    io.err(skillsAddResult.error.message)
    return 1
  }
  if (skillsAddResult.status !== 0) return skillsAddResult.status ?? 1

  if (!parsed.installRuntime) {
    io.out('SUGAR: skill installed. Runtime install skipped (--no-runtime).')
    printSugarAcronym(io)
    return 0
  }

  io.out(`SUGAR: installing runtime in ${parsed.runtimeDir} ...`)
  const runtimePackage = `${pkg.name}@${pkg.version}`
  const runtimeResult = executors.runtimeInstall(['install', '--prefix', parsed.runtimeDir, '--no-save', runtimePackage])
  if (runtimeResult.error) {
    io.err(runtimeResult.error.message)
    return 1
  }
  if (runtimeResult.status !== 0) return runtimeResult.status ?? 1

  io.out(`SUGAR: runtime installed in ${parsed.runtimeDir}.`)
  io.out(`SUGAR: use ${parsed.runtimeDir}/node_modules/.bin/sugar run <diagram.json> --duration 120s`)
  printSugarAcronym(io)
  return 0
}
