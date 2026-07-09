#!/usr/bin/env node
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as {
  name: string
  version: string
  description: string
}

const HELP_TEXT = `${pkg.name} v${pkg.version}
${pkg.description}

Usage:
  sugar install     Confirm the CLI is installed and ready to use
  sugar --version   Print the installed version
  sugar --help      Show this help message

This CLI is a placeholder — SUGAR is currently consumed as a library
(see the package README for the public API in src/index.ts). A headless
simulation runner will land here in a future release.
`

const args = process.argv.slice(2)
const [command] = args

if (args.includes('--version') || args.includes('-v')) {
  console.log(pkg.version)
} else if (command === 'install') {
  console.log(
    `${pkg.name} v${pkg.version} is installed and ready.\nRun "npx sugar-skills --help" to see available commands.`,
  )
} else if (!command || args.includes('--help') || args.includes('-h')) {
  console.log(HELP_TEXT)
} else {
  console.error(`Unknown command: ${command}\n`)
  console.log(HELP_TEXT)
  process.exitCode = 1
}
