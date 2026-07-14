#!/usr/bin/env node
import { runSkillsInstaller } from './skillsCli.js'
import { spawnSync } from 'node:child_process'

const code = runSkillsInstaller(process.argv.slice(2), {
  out: (line) => {
    console.log(line)
  },
  err: (line) => {
    console.error(line)
  },
}, {
  skillsAdd: (args) => {
    const result = spawnSync('npx', args, { stdio: 'inherit' })
    return { status: result.status, error: result.error }
  },
  runtimeInstall: (args) => {
    const result = spawnSync('npm', args, { stdio: 'inherit' })
    return { status: result.status, error: result.error }
  },
})

process.exit(code)
