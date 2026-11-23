#!/usr/bin/env node
/**
 * Controlled A/B benchmark runner for evaluating whether `execution-points`
 * helps coding agents (via GitHub Copilot CLI) debug and fix hard async races.
 *
 * Usage:
 *   node bench/run.mjs --self-test
 *   node bench/run.mjs --tasks stale-cache,token-session --arms control,treatment \
 *     --models gemini-4-neon:low,gpt-6.2-astra:medium,claude-opus-5.5:medium \
 *     --trials 1 --concurrency 2
 */
import { execFile, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const VITEST_BIN = path.join(REPO_ROOT, 'node_modules/.bin/vitest')
const TSC_BIN = path.join(REPO_ROOT, 'node_modules/.bin/tsc')

const TASKS = {
  'stale-cache': {
    id: 'stale-cache',
    targetRel: 'src/profile-store.ts',
    testRel: 'src/profile-store.test.ts',
    expectedExports: ['resetStore', 'seedProfile', 'getProfile', 'updateProfile'],
    privateHelpers: ['readFromDb', 'formatProfile', 'validateName', 'writeToDb', 'auditUpdate'],
    graderFile: path.join(__dirname, 'graders/stale-cache.grader.test.ts'),
  },
  'token-session': {
    id: 'token-session',
    targetRel: 'src/session-manager.ts',
    testRel: 'src/session-manager.test.ts',
    expectedExports: ['resetSessions', 'login', 'getActiveToken', 'logout'],
    privateHelpers: [
      'requestNewToken',
      'verifyTokenPolicy',
      'prepareRevocation',
      'notifyAuthServer',
      'flushAuditLog',
    ],
    graderFile: path.join(__dirname, 'graders/token-session.grader.test.ts'),
  },
}

const REFERENCE_FIXES = {
  'stale-cache': `export interface Profile {
  id: string
  name: string
  displayName: string
}

const db = new Map<string, Profile>()
const cache = new Map<string, Profile>()
const versions = new Map<string, number>()
const updateQueues = new Map<string, Promise<unknown>>()

async function readFromDb(id: string): Promise<Profile | null> {
  await Promise.resolve()
  const row = db.get(id)
  return row ? { ...row } : null
}

async function formatProfile(profile: Profile): Promise<Profile> {
  await Promise.resolve()
  return { ...profile, displayName: profile.name.trim().toUpperCase() }
}

async function validateName(name: string): Promise<string> {
  await Promise.resolve()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Profile name cannot be empty')
  return trimmed
}

async function writeToDb(id: string, profile: Profile): Promise<void> {
  await Promise.resolve()
  db.set(id, { ...profile })
}

async function auditUpdate(_id: string, _profile: Profile): Promise<void> {
  await Promise.resolve()
}

export function resetStore(): void {
  db.clear()
  cache.clear()
  versions.clear()
  updateQueues.clear()
}

export function seedProfile(id: string, name: string): void {
  const clean = name.trim()
  db.set(id, { id, name: clean, displayName: clean.toUpperCase() })
  cache.delete(id)
  versions.set(id, (versions.get(id) ?? 0) + 1)
}

export async function getProfile(id: string): Promise<Profile | null> {
  const cached = cache.get(id)
  if (cached) return { ...cached }
  const startVersion = versions.get(id) ?? 0
  const raw = await readFromDb(id)
  if (!raw) return null
  const formatted = await formatProfile(raw)
  if ((versions.get(id) ?? 0) === startVersion) {
    cache.set(id, formatted)
  }
  return { ...formatted }
}

export async function updateProfile(id: string, name: string): Promise<Profile> {
  const prev = updateQueues.get(id) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(async () => {
    const clean = await validateName(name)
    const next: Profile = { id, name: clean, displayName: clean.toUpperCase() }
    versions.set(id, (versions.get(id) ?? 0) + 1)
    cache.delete(id)
    await writeToDb(id, next)
    await auditUpdate(id, next)
    cache.set(id, next)
    return { ...next }
  })
  updateQueues.set(id, run)
  return run
}
`,
  'token-session': `interface SessionRecord {
  userId: string
  generation: number
  token: string | null
}

const sessions = new Map<string, SessionRecord>()
let tokenSeq = 0
let generationSeq = 0

async function requestNewToken(userId: string): Promise<string> {
  await Promise.resolve()
  tokenSeq += 1
  return \`tok-\${userId}-\${tokenSeq}\`
}

async function verifyTokenPolicy(_userId: string, token: string): Promise<string> {
  await Promise.resolve()
  return token
}

async function prepareRevocation(_userId: string): Promise<void> {
  await Promise.resolve()
}

async function notifyAuthServer(_userId: string): Promise<void> {
  await Promise.resolve()
}

async function flushAuditLog(_userId: string): Promise<void> {
  await Promise.resolve()
}

export function resetSessions(): void {
  sessions.clear()
  tokenSeq = 0
  generationSeq = 0
}

export function login(userId: string): void {
  generationSeq += 1
  sessions.set(userId, { userId, generation: generationSeq, token: null })
}

export async function getActiveToken(userId: string): Promise<string | null> {
  const existing = sessions.get(userId)
  if (!existing) return null
  if (existing.token !== null) return existing.token
  const gen = existing.generation
  const raw = await requestNewToken(userId)
  const verified = await verifyTokenPolicy(userId, raw)
  const current = sessions.get(userId)
  if (!current || current.generation !== gen) return null
  current.token = verified
  return verified
}

export async function logout(userId: string): Promise<void> {
  const existing = sessions.get(userId)
  if (existing) {
    sessions.delete(userId)
  }
  await prepareRevocation(userId)
  await notifyAuthServer(userId)
  await flushAuditLog(userId)
}
`,
}

function linkNodeModules(workspaceDir, { includeExecutionPoints }) {
  const nmDir = path.join(workspaceDir, 'node_modules')
  mkdirSync(nmDir, { recursive: true })
  const rootNm = path.join(REPO_ROOT, 'node_modules')
  for (const entry of readdirSync(rootNm)) {
    if (entry === 'execution-points-prototype') continue
    symlinkSync(path.join(rootNm, entry), path.join(nmDir, entry))
  }
  if (includeExecutionPoints) {
    // Copy only package.json + src/ (never symlink REPO_ROOT, so bench/graders/ and .git/ are unreachable)
    const pkgDir = path.join(nmDir, 'execution-points-prototype')
    mkdirSync(pkgDir, { recursive: true })
    cpSync(path.join(REPO_ROOT, 'package.json'), path.join(pkgDir, 'package.json'))
    cpSync(path.join(REPO_ROOT, 'src'), path.join(pkgDir, 'src'), { recursive: true })
  }
}

function materializeWorkspace(workspaceDir, task, arm) {
  mkdirSync(path.join(workspaceDir, 'src'), { recursive: true })
  const taskDir = path.join(__dirname, 'tasks', task.id)
  cpSync(path.join(taskDir, 'src'), path.join(workspaceDir, 'src'), { recursive: true })

  const isTreatment = arm === 'treatment' || arm === 'grader'
  linkNodeModules(workspaceDir, { includeExecutionPoints: isTreatment })

  writeFileSync(
    path.join(workspaceDir, 'package.json'),
    JSON.stringify(
      {
        name: `bench-${task.id}-${arm}`,
        private: true,
        type: 'module',
        scripts: {
          test: 'vitest run',
          check: isTreatment ? 'tsc --noEmit --runExternalCode' : 'tsc --noEmit',
        },
        devDependencies: {
          '@types/node': '^24.0.0',
          typescript: '7.1.0-dev.20261121.1',
          vite: '8.3.8',
          vitest: '5.1.1',
          ...(isTreatment ? { 'magic-string': '1.4.5' } : {}),
        },
      },
      null,
      2,
    ),
  )

  const tsconfig = {
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      noEmit: true,
      skipLibCheck: true,
      types: ['node'],
    },
    ...(isTreatment
      ? {
          contentMappers: [
            {
              package: 'execution-points-prototype',
              extensions: ['.ep'],
            },
          ],
          include: ['src/**/*.ts', 'points.ep', ...(arm === 'grader' ? ['*.grader.test.ts'] : [])],
        }
      : {
          include: ['src/**/*.ts'],
        }),
  }
  writeFileSync(path.join(workspaceDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2))

  if (isTreatment) {
    writeFileSync(
      path.join(workspaceDir, 'points.ep'),
      JSON.stringify({ tsconfig: 'tsconfig.json', targets: [task.targetRel] }, null, 2),
    )
    writeFileSync(
      path.join(workspaceDir, 'vitest.config.mjs'),
      `import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { executionPoints } from 'execution-points-prototype/vite'

const manifest = JSON.parse(readFileSync(new URL('./points.ep', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [executionPoints({ root: import.meta.dirname, ...manifest })],
  test: {
    include: [${arm === 'grader' ? "'*.grader.test.ts'" : "'src/**/*.test.ts'"}],
    environment: 'node',
    isolate: true,
  },
})
`,
    )
    if (arm === 'treatment') {
      cpSync(
        path.join(__dirname, 'EXECUTION_POINTS_GUIDE.md'),
        path.join(workspaceDir, 'EXECUTION_POINTS_GUIDE.md'),
      )
    }
  } else {
    writeFileSync(
      path.join(workspaceDir, 'vitest.config.mjs'),
      `import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    isolate: true,
  },
})
`,
    )
  }
}

async function runCmd(bin, args, cwd, timeoutMs = 60_000) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    })
    return { ok: true, code: 0, stdout, stderr }
  } catch (err) {
    return {
      ok: false,
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
    }
  }
}

function auditProductionDiff(task, patchedSource) {
  const exportedFns = [...patchedSource.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map(
    (m) => m[1],
  )
  const exportedConsts = [...patchedSource.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)/g)].map(
    (m) => m[1],
  )
  const allExports = [...new Set([...exportedFns, ...exportedConsts])]
  const extraExports = allExports.filter((name) => !task.expectedExports.includes(name))
  const missingExports = task.expectedExports.filter((name) => !allExports.includes(name))
  const exportedPrivates = task.privateHelpers.filter((h) => allExports.includes(h))
  const missingPrivates = task.privateHelpers.filter(
    (h) => !new RegExp(`function\\s+${h}\\b`).test(patchedSource),
  )

  return {
    clean:
      extraExports.length === 0 &&
      missingExports.length === 0 &&
      exportedPrivates.length === 0 &&
      missingPrivates.length === 0,
    extraExports,
    missingExports,
    exportedPrivates,
    missingPrivates,
  }
}

async function runHiddenOracleGrader(task, patchedSource) {
  const graderDir = mkdtempSync(path.join(tmpdir(), `ep-bench-grade-${task.id}-`))
  try {
    materializeWorkspace(graderDir, task, 'grader')
    writeFileSync(path.join(graderDir, task.targetRel), patchedSource)
    const graderBase = path.basename(task.graderFile)
    cpSync(task.graderFile, path.join(graderDir, graderBase))

    const res = await runCmd(VITEST_BIN, ['run', graderBase], graderDir, 90_000)
    return {
      oraclePass: res.ok,
      outputSnippet: (res.stdout + '\n' + res.stderr).slice(-1200),
    }
  } finally {
    rmSync(graderDir, { recursive: true, force: true })
  }
}

async function gradeDeterministicRed(task, arm, agentTestSource, redRuns = 10) {
  const usesSleep = /\bsetTimeout\s*\(|\bsetInterval\s*\(/.test(agentTestSource)
  const usesGlobalPatch =
    /spyOn\s*\(\s*(?:Promise|Map|Set|globalThis)\b|(?:Promise|Map\.prototype)\.\w+\s*=/.test(
      agentTestSource,
    )
  const redDir = mkdtempSync(path.join(tmpdir(), `ep-bench-red-${task.id}-`))
  try {
    materializeWorkspace(redDir, task, arm)
    // Keep unmodified buggy targetRel, overwrite ONLY the test file with agent's test
    writeFileSync(path.join(redDir, task.testRel), agentTestSource)
    let failures = 0
    for (let i = 0; i < redRuns; i++) {
      const res = await runCmd(VITEST_BIN, ['run'], redDir, 30_000)
      if (!res.ok) failures++
    }
    return {
      usesSleep,
      usesGlobalPatch,
      redFailures: failures,
      redRuns,
      deterministicRed: failures === redRuns && !usesSleep,
    }
  } finally {
    rmSync(redDir, { recursive: true, force: true })
  }
}

function buildPrompt(task, arm) {
  const basePrompt = readFileSync(path.join(__dirname, 'tasks', task.id, 'PROMPT.md'), 'utf8')
  if (arm === 'treatment') {
    return (
      basePrompt +
      '\n## Tooling Available\n' +
      'This workspace has `execution-points-prototype` pre-configured. Read `EXECUTION_POINTS_GUIDE.md` first and use `select()` + `withReplacement()` to deterministically control internal async interleavings in your regression test. Run `npm test` and `npm run check` to verify (do not run package installs).\n'
    )
  }
  return (
    basePrompt +
    '\n## Tooling Available\n' +
    'This workspace uses standard Vitest and TypeScript. Run `npm test` and `npm run check` to verify (do not run package installs).\n'
  )
}

function parseCopilotJsonl(rawStdout) {
  let turns = 0
  let toolCalls = 0
  let premiumRequests = 0
  let apiDurationMs = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  const eventTypes = new Set()

  for (const line of rawStdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let ev
    try {
      ev = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (ev.type) eventTypes.add(ev.type)
    if (ev.type === 'assistant.turn_start' || ev.type === 'turn.started') turns++
    if (ev.type === 'tool.execution_start' || ev.type === 'tool.call') toolCalls++
    if (ev.type === 'result' && ev.usage) {
      premiumRequests = ev.usage.premiumRequests ?? premiumRequests
      apiDurationMs = ev.usage.totalApiDurationMs ?? apiDurationMs
    }
    if (ev.data?.usage) {
      totalInputTokens += ev.data.usage.inputTokens ?? 0
      totalOutputTokens += ev.data.usage.outputTokens ?? 0
    }
  }

  return {
    turns,
    toolCalls,
    premiumRequests,
    apiDurationMs,
    totalInputTokens,
    totalOutputTokens,
    eventTypes: [...eventTypes],
  }
}

async function runCopilotTrial({ task, arm, model, effort, trialIndex, outDir, maxCredits, timeoutMs }) {
  const trialId = `${task.id}__${arm}__${model}__${effort}__t${trialIndex}`
  const trialOutDir = path.join(outDir, trialId)
  mkdirSync(trialOutDir, { recursive: true })

  const workspaceDir = mkdtempSync(path.join(tmpdir(), `ep-bench-trial-${task.id}-`))
  const startedAt = Date.now()

  try {
    materializeWorkspace(workspaceDir, task, arm)
    const prompt = buildPrompt(task, arm)
    const transcriptPath = path.join(trialOutDir, 'transcript.md')

    const args = [
      '-C',
      workspaceDir,
      '-p',
      prompt,
      '--model',
      model,
      '--reasoning-effort',
      effort,
      '--output-format',
      'json',
      '--no-custom-instructions',
      '--no-ask-user',
      '--disable-builtin-mcps',
      '--disallow-temp-dir',
      '--allow-tool',
      'write',
      '--allow-tool',
      'shell(npm:*)',
      '--allow-tool',
      'shell(npx:*)',
      '--allow-tool',
      'shell(vitest:*)',
      '--allow-tool',
      'shell(tsc:*)',
      '--allow-tool',
      'shell(node:*)',
      ...(maxCredits > 0 ? ['--max-ai-credits', String(maxCredits)] : []),
      '--share',
      transcriptPath,
    ]

    const procResult = await new Promise((resolve) => {
      const child = spawn('copilot', args, {
        cwd: workspaceDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeoutMs)

      child.stdout.on('data', (d) => {
        stdout += d.toString('utf8')
      })
      child.stderr.on('data', (d) => {
        stderr += d.toString('utf8')
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code: code ?? 1, stdout, stderr, timedOut })
      })
    })

    const wallMs = Date.now() - startedAt
    writeFileSync(path.join(trialOutDir, 'events.jsonl'), procResult.stdout)
    if (procResult.stderr) writeFileSync(path.join(trialOutDir, 'stderr.log'), procResult.stderr)

    const patchedSource = readFileSync(path.join(workspaceDir, task.targetRel), 'utf8')
    const agentTestSource = readFileSync(path.join(workspaceDir, task.testRel), 'utf8')
    writeFileSync(path.join(trialOutDir, 'patched-source.ts'), patchedSource)
    writeFileSync(path.join(trialOutDir, 'agent-test.ts'), agentTestSource)

    const telemetry = parseCopilotJsonl(procResult.stdout)
    const designAudit = auditProductionDiff(task, patchedSource)
    const agentTestRun = await runCmd(VITEST_BIN, ['run'], workspaceDir, 30_000)
    const tscArgs =
      arm === 'treatment' ? ['--noEmit', '--runExternalCode'] : ['--noEmit']
    const typecheckRun = await runCmd(TSC_BIN, tscArgs, workspaceDir, 45_000)
    const redGrade = await gradeDeterministicRed(task, arm, agentTestSource, 10)
    const oracleGrade = await runHiddenOracleGrader(task, patchedSource)

    const record = {
      trialId,
      task: task.id,
      arm,
      model,
      effort,
      trialIndex,
      wallMs,
      timedOut: procResult.timedOut,
      cliExitCode: procResult.code,
      agentGreen: agentTestRun.ok,
      typecheckPass: typecheckRun.ok,
      deterministicRed: redGrade.deterministicRed,
      redFailures: redGrade.redFailures,
      redRuns: redGrade.redRuns,
      usesSleep: redGrade.usesSleep,
      usesGlobalPatch: redGrade.usesGlobalPatch,
      oraclePass: oracleGrade.oraclePass,
      designClean: designAudit.clean,
      designAudit,
      telemetry,
    }
    writeFileSync(path.join(trialOutDir, 'result.json'), JSON.stringify(record, null, 2))
    return record
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
}

async function runSelfTest() {
  console.log('Running benchmark self-test (baseline tests, buggy RED, reference fix GREEN)...')
  for (const task of Object.values(TASKS)) {
    for (const arm of ['control', 'treatment']) {
      const ws = mkdtempSync(path.join(tmpdir(), `ep-bench-self-${task.id}-${arm}-`))
      try {
        materializeWorkspace(ws, task, arm)
        const testRes = await runCmd(VITEST_BIN, ['run'], ws)
        const tscRes = await runCmd(
          TSC_BIN,
          arm === 'treatment' ? ['--noEmit', '--runExternalCode'] : ['--noEmit'],
          ws,
        )
        if (!testRes.ok) throw new Error(`Baseline test failed for ${task.id} (${arm}):\n${testRes.stdout}\n${testRes.stderr}`)
        if (!tscRes.ok) throw new Error(`Baseline tsc failed for ${task.id} (${arm}):\n${tscRes.stdout}\n${tscRes.stderr}`)
        console.log(`  PASS baseline ${task.id} (${arm}): vitest + tsc clean`)
      } finally {
        rmSync(ws, { recursive: true, force: true })
      }
    }

    const buggySource = readFileSync(
      path.join(__dirname, 'tasks', task.id, task.targetRel),
      'utf8',
    )
    const buggyGrade = await runHiddenOracleGrader(task, buggySource)
    if (buggyGrade.oraclePass) {
      throw new Error(`Hidden grader MUST FAIL on buggy ${task.id}, but it passed!`)
    }
    console.log(`  PASS hidden grader RED on buggy ${task.id}`)

    const refSource = REFERENCE_FIXES[task.id]
    const refAudit = auditProductionDiff(task, refSource)
    if (!refAudit.clean) {
      throw new Error(`Reference fix failed design audit for ${task.id}: ${JSON.stringify(refAudit)}`)
    }
    const refGrade = await runHiddenOracleGrader(task, refSource)
    if (!refGrade.oraclePass) {
      throw new Error(`Hidden grader FAILED on reference fix for ${task.id}:\n${refGrade.outputSnippet}`)
    }
    console.log(`  PASS hidden grader GREEN on reference fix for ${task.id}`)
  }
  console.log('All benchmark self-tests passed.')
}

function formatSummaryMarkdown(records) {
  const lines = [
    '# Execution Points Async Debugging Benchmark Results',
    '',
    '| Task | Arm | Model | Effort | Trial | RED (10x) | Sleep? | Global Patch? | Agent Green | Typecheck | Hidden Oracle | Design Clean | Turns | Tool Calls | Wall (s) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const r of records) {
    lines.push(
      `| ${r.task} | ${r.arm} | ${r.model} | ${r.effort} | ${r.trialIndex} | ${r.redFailures}/${r.redRuns} (${r.deterministicRed ? 'PASS' : 'FAIL'}) | ${r.usesSleep ? 'YES' : 'no'} | ${r.usesGlobalPatch ? 'YES' : 'no'} | ${r.agentGreen ? 'PASS' : 'FAIL'} | ${r.typecheckPass ? 'PASS' : 'FAIL'} | ${r.oraclePass ? 'PASS' : 'FAIL'} | ${r.designClean ? 'YES' : 'NO'} | ${r.telemetry.turns} | ${r.telemetry.toolCalls} | ${(r.wallMs / 1000).toFixed(1)} |`,
    )
  }
  return lines.join('\n') + '\n'
}

function parseArgs(argv) {
  const opts = {
    selfTest: false,
    tasks: Object.keys(TASKS),
    arms: ['control', 'treatment'],
    models: ['gemini-4-neon:medium'],
    trials: 1,
    concurrency: 2,
    maxCredits: 150,
    timeoutMs: 300_000,
    outDir: path.join(tmpdir(), `ep-bench-run-${Date.now()}`),
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--self-test') opts.selfTest = true
    else if (a === '--tasks') opts.tasks = argv[++i].split(',')
    else if (a === '--arms') opts.arms = argv[++i].split(',')
    else if (a === '--models') opts.models = argv[++i].split(',')
    else if (a === '--trials') opts.trials = Number(argv[++i])
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i])
    else if (a === '--max-credits') opts.maxCredits = Number(argv[++i])
    else if (a === '--timeout-ms') opts.timeoutMs = Number(argv[++i])
    else if (a === '--out') opts.outDir = path.resolve(argv[++i])
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.selfTest) {
    await runSelfTest()
    return
  }

  mkdirSync(opts.outDir, { recursive: true })
  const jobs = []
  for (const taskId of opts.tasks) {
    const task = TASKS[taskId]
    if (!task) throw new Error(`Unknown task: ${taskId}`)
    for (const arm of opts.arms) {
      for (const spec of opts.models) {
        const [model, effort = 'medium'] = spec.split(':')
        for (let trialIndex = 1; trialIndex <= opts.trials; trialIndex++) {
          jobs.push({
            task,
            arm,
            model,
            effort,
            trialIndex,
            outDir: opts.outDir,
            maxCredits: opts.maxCredits,
            timeoutMs: opts.timeoutMs,
          })
        }
      }
    }
  }

  console.log(`Starting ${jobs.length} trial(s) (concurrency=${opts.concurrency}), output: ${opts.outDir}`)
  const results = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(opts.concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++]
      console.log(`  RUN  ${job.task.id} | ${job.arm} | ${job.model}:${job.effort} | t${job.trialIndex}`)
      const rec = await runCopilotTrial(job)
      results.push(rec)
      console.log(
        `  DONE ${rec.trialId} -> RED=${rec.redFailures}/${rec.redRuns}(sleep=${rec.usesSleep}) oracle=${rec.oraclePass} clean=${rec.designClean} (${(rec.wallMs / 1000).toFixed(1)}s)`,
      )
    }
  })
  await Promise.all(workers)

  writeFileSync(path.join(opts.outDir, 'results.json'), JSON.stringify(results, null, 2))
  const md = formatSummaryMarkdown(results)
  writeFileSync(path.join(opts.outDir, 'summary.md'), md)
  console.log('\n' + md)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
