#!/usr/bin/env node
/**
 * Controlled A/B benchmark runner (v2 — P0 + P1 + P2 complete) for evaluating
 * whether `execution-points` helps coding agents (via GitHub Copilot CLI)
 * debug and fix hard asynchronous concurrency bugs.
 *
 * See `bench/PROTOCOL.md` and `BENCHMARK-LOG.md` for pre-registered design,
 * endpoints, and evolution history.
 *
 * Usage:
 *   node bench/run.mjs --self-test
 *   node bench/run.mjs --tasks stale-cache,stale-cache-seam --arms control,treatment \
 *     --models gemini-4-neon:medium,gpt-6.2-astra:medium,claude-opus-5.5:medium \
 *     --prompt-style symptom --trials 1 --concurrency 2
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { auditProductionAst, auditTestAst, closeAuditApi } from './ast-audit.mjs'
import {
  buildBuggyRefactors,
  CALIBRATION_VARIANTS,
  REFERENCE_FIXES,
  SINGLE_BUG_MUTANTS,
  VALID_FIX_VARIANTS,
} from './calibration/variants.mjs'
import { extractUsageMetrics, formatUsd, MODEL_PRICING_PER_M } from './pricing.mjs'
import { formatCI, stratifiedCMH, wilsonCI } from './stats.mjs'
import { assertNoRepoLeak, prepareToolchains } from './toolchain.mjs'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const TASKS = {
  // ── Stratum A: closed-module (no DI/module seam) ──────────────────────────
  'stale-cache': {
    id: 'stale-cache',
    stratum: 'closed-module',
    targetRel: 'src/profile-store.ts',
    testRel: 'src/profile-store.test.ts',
    epTargets: ['src/profile-store.ts'],
    expectedExports: {
      resetStore: 0,
      clearCache: 0,
      seedProfile: 2,
      getProfile: 1,
      updateProfile: 2,
    },
    asyncHelpers: ['readFromDb', 'formatProfile', 'validateName', 'writeToDb', 'auditUpdate'],
    auxAsyncChecks: {},
    graderFile: path.join(__dirname, 'graders/stale-cache.grader.test.ts'),
  },
  'token-session': {
    id: 'token-session',
    stratum: 'closed-module',
    targetRel: 'src/session-manager.ts',
    testRel: 'src/session-manager.test.ts',
    epTargets: ['src/session-manager.ts'],
    expectedExports: {
      resetSessions: 0,
      login: 1,
      getActiveToken: 1,
      logout: 1,
    },
    asyncHelpers: [
      'requestNewToken',
      'verifyTokenPolicy',
      'prepareRevocation',
      'notifyAuthServer',
      'flushAuditLog',
    ],
    auxAsyncChecks: {},
    graderFile: path.join(__dirname, 'graders/token-session.grader.test.ts'),
  },
  'double-submit': {
    id: 'double-submit',
    stratum: 'closed-module',
    targetRel: 'src/payment-processor.ts',
    testRel: 'src/payment-processor.test.ts',
    epTargets: ['src/payment-processor.ts'],
    expectedExports: {
      resetPayments: 0,
      failNextCharge: 2,
      getGatewayChargeCount: 1,
      submitPayment: 2,
    },
    asyncHelpers: ['validatePayment', 'reserveFunds', 'chargeGateway'],
    auxAsyncChecks: {},
    graderFile: path.join(__dirname, 'graders/double-submit.grader.test.ts'),
  },

  // ── Stratum B: io-seam (separate mockable I/O modules) ────────────────────
  'stale-cache-seam': {
    id: 'stale-cache-seam',
    stratum: 'io-seam',
    targetRel: 'src/profile-store.ts',
    testRel: 'src/profile-store.test.ts',
    epTargets: ['src/profile-store.ts', 'src/storage.ts'],
    expectedExports: {
      resetStore: 0,
      clearCache: 0,
      seedProfile: 2,
      getProfile: 1,
      updateProfile: 2,
    },
    asyncHelpers: [],
    auxAsyncChecks: {
      'src/storage.ts': {
        expectedExports: {
          resetStorage: 0,
          seedStorage: 2,
          readFromDb: 1,
          formatProfile: 1,
          validateName: 1,
          writeToDb: 2,
          auditUpdate: 2,
        },
        asyncHelpers: ['readFromDb', 'formatProfile', 'validateName', 'writeToDb', 'auditUpdate'],
      },
    },
    graderFile: path.join(__dirname, 'graders/stale-cache.grader.test.ts'),
  },
  'single-flight': {
    id: 'single-flight',
    stratum: 'io-seam',
    targetRel: 'src/token-cache.ts',
    testRel: 'src/token-cache.test.ts',
    epTargets: ['src/token-cache.ts', 'src/auth-client.ts'],
    expectedExports: {
      resetTokenCache: 0,
      invalidateToken: 1,
      getToken: 1,
    },
    asyncHelpers: [],
    auxAsyncChecks: {
      'src/auth-client.ts': {
        expectedExports: {
          resetAuthClient: 0,
          getRefreshCallCount: 1,
          failNextRefresh: 2,
          fetchRefreshToken: 1,
        },
        asyncHelpers: ['fetchRefreshToken'],
      },
    },
    graderFile: path.join(__dirname, 'graders/single-flight.grader.test.ts'),
  },
  'retry-storm': {
    id: 'retry-storm',
    stratum: 'io-seam',
    targetRel: 'src/resilient-client.ts',
    testRel: 'src/resilient-client.test.ts',
    epTargets: ['src/resilient-client.ts', 'src/upstream.ts'],
    expectedExports: {
      createResilientClient: 1,
    },
    asyncHelpers: [],
    auxAsyncChecks: {
      'src/upstream.ts': {
        expectedExports: {
          resetUpstream: 0,
          setUpstreamFailures: 1,
          getUpstreamCallCount: 0,
          callUpstream: 1,
        },
        asyncHelpers: ['callUpstream'],
      },
    },
    graderFile: path.join(__dirname, 'graders/retry-storm.grader.test.ts'),
  },
  'event-order': {
    id: 'event-order',
    stratum: 'io-seam',
    targetRel: 'src/order-projector.ts',
    testRel: 'src/order-projector.test.ts',
    epTargets: ['src/order-projector.ts', 'src/order-repo.ts'],
    expectedExports: {
      resetProjector: 0,
      getOrder: 1,
      applyOrderEvent: 1,
    },
    asyncHelpers: [],
    auxAsyncChecks: {
      'src/order-repo.ts': {
        expectedExports: {
          resetOrderRepo: 0,
          readOrder: 1,
          enrichOrderStatus: 1,
          saveOrder: 1,
        },
        asyncHelpers: ['readOrder', 'enrichOrderStatus', 'saveOrder'],
      },
    },
    graderFile: path.join(__dirname, 'graders/event-order.grader.test.ts'),
  },
  'cross-module-transfer': {
    id: 'cross-module-transfer',
    stratum: 'io-seam',
    targetRel: 'src/ledger.ts',
    testRel: 'src/ledger.test.ts',
    epTargets: ['src/ledger.ts', 'src/account-store.ts', 'src/audit-log.ts'],
    expectedExports: {
      resetLedger: 0,
      createAccount: 2,
      getBalance: 1,
      transfer: 3,
    },
    asyncHelpers: [],
    auxAsyncChecks: {
      'src/account-store.ts': {
        expectedExports: {
          resetAccounts: 0,
          seedAccount: 2,
          readBalance: 1,
          writeBalance: 2,
        },
        asyncHelpers: ['readBalance', 'writeBalance'],
      },
      'src/audit-log.ts': {
        expectedExports: {
          resetAuditLog: 0,
          getAuditEntries: 0,
          recordTransfer: 1,
        },
        asyncHelpers: ['recordTransfer'],
      },
    },
    graderFile: path.join(__dirname, 'graders/cross-module-transfer.grader.test.ts'),
  },

  // ── Stratum C: real-async (real node:fs/promises + timers) ────────────────
  'cancel-commit': {
    id: 'cancel-commit',
    stratum: 'real-async',
    targetRel: 'src/job-runner.ts',
    testRel: 'src/job-runner.test.ts',
    epTargets: ['src/job-runner.ts'],
    expectedExports: {
      createJobRunner: 1,
    },
    asyncHelpers: [],
    auxAsyncChecks: {},
    graderFile: path.join(__dirname, 'graders/cancel-commit.grader.test.ts'),
  },
  'debounce-search': {
    id: 'debounce-search',
    stratum: 'real-async',
    targetRel: 'src/search-controller.ts',
    testRel: 'src/search-controller.test.ts',
    epTargets: ['src/search-controller.ts', 'src/search-api.ts'],
    expectedExports: {
      createSearchController: 1,
    },
    asyncHelpers: [],
    auxAsyncChecks: {
      'src/search-api.ts': {
        expectedExports: {
          resetSearchApi: 0,
          fetchSearchResults: 1,
        },
        asyncHelpers: ['fetchSearchResults'],
      },
    },
    graderFile: path.join(__dirname, 'graders/debounce-search.grader.test.ts'),
  },
}

function parseArgs(argv) {
  const opts = {
    selfTest: false,
    tasks: Object.keys(TASKS),
    arms: ['control', 'treatment'],
    models: ['gemini-4-neon:medium', 'gpt-6.2-astra:medium', 'claude-opus-5.5:medium'],
    promptStyle: 'symptom',
    trials: 1,
    concurrency: 2,
    timeoutSec: 360,
    maxCredits: 150,
    seed: 42,
    phaseSplit: true,
    keepWorkspaces: false,
    outDir: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--self-test') opts.selfTest = true
    else if (a === '--tasks') opts.tasks = argv[++i].split(',').filter(Boolean)
    else if (a === '--arms') opts.arms = argv[++i].split(',').filter(Boolean)
    else if (a === '--models') opts.models = argv[++i].split(',').filter(Boolean)
    else if (a === '--prompt-style') opts.promptStyle = argv[++i]
    else if (a === '--trials') opts.trials = Number(argv[++i])
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i])
    else if (a === '--timeout') opts.timeoutSec = Number(argv[++i])
    else if (a === '--max-credits') opts.maxCredits = Number(argv[++i])
    else if (a === '--seed') opts.seed = Number(argv[++i])
    else if (a === '--no-phase-split') opts.phaseSplit = false
    else if (a === '--phase-split') opts.phaseSplit = true
    else if (a === '--keep-workspaces') opts.keepWorkspaces = true
    else if (a === '--out') opts.outDir = path.resolve(argv[++i])
    else throw new Error(`Unknown argument: ${a}`)
  }
  if (opts.promptStyle !== 'symptom' && opts.promptStyle !== 'described') {
    throw new Error(`Invalid --prompt-style: ${opts.promptStyle} (expected symptom or described)`)
  }
  return opts
}

function getCopilotVersion() {
  try {
    return execFileSync('copilot', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return 'unknown'
  }
}

function mulberry32(seed) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function readTaskBaselineFiles(taskId) {
  const srcDir = path.join(__dirname, 'tasks', taskId, 'src')
  const files = {}
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    files[`src/${name}`] = readFileSync(path.join(srcDir, name), 'utf8')
  }
  return files
}

function collectRelativeFiles(rootDir, subDir = '') {
  const results = {}
  const fullDir = path.join(rootDir, subDir)
  if (!existsSync(fullDir)) return results
  for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.vitest')) continue
    const rel = subDir ? `${subDir}/${entry.name}` : entry.name
    const full = path.join(rootDir, rel)
    if (entry.isDirectory()) {
      Object.assign(results, collectRelativeFiles(rootDir, rel))
    } else if (entry.isFile()) {
      results[rel] = readFileSync(full, 'utf8')
    }
  }
  return results
}

function copyNonTestSrc(srcDir, destSrcDir) {
  mkdirSync(destSrcDir, { recursive: true })
  if (!existsSync(srcDir)) return
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destSrcDir, entry.name)
    if (entry.isDirectory()) {
      copyNonTestSrc(srcPath, destPath)
    } else if (entry.isFile() && !entry.name.endsWith('.test.ts')) {
      cpSync(srcPath, destPath)
    }
  }
}

function writePristineWorkspaceConfigs(dir, task, arm) {
  const pkg = {
    name: `bench-${task.id}-${arm}`,
    private: true,
    type: 'module',
    scripts: {
      test: 'vitest run',
      check: arm === 'treatment' ? 'tsc --noEmit --runExternalCode' : 'tsc --noEmit',
    },
    devDependencies: {
      typescript: '*',
      vitest: '*',
      '@types/node': '*',
      ...(arm === 'treatment' ? { 'execution-points-prototype': '*' } : {}),
    },
  }
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

  if (arm === 'treatment') {
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2023',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: ['node'],
          },
          contentMappers: [
            {
              package: 'execution-points-prototype',
              extensions: ['.ep'],
            },
          ],
          include: ['src/**/*.ts', 'points.ep'],
        },
        null,
        2,
      ) + '\n',
    )
    writeFileSync(
      path.join(dir, 'points.ep'),
      JSON.stringify(
        {
          tsconfig: 'tsconfig.json',
          targets: task.epTargets,
        },
        null,
        2,
      ) + '\n',
    )
    writeFileSync(
      path.join(dir, 'vitest.config.mjs'),
      `import { defineConfig } from 'vitest/config'
import { executionPoints } from 'execution-points-prototype/vite'

export default defineConfig({
  plugins: [executionPoints({ targets: ${JSON.stringify(task.epTargets)} })],
  test: { environment: 'node' },
})
`,
    )
  } else {
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2023',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: ['node'],
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ) + '\n',
    )
    writeFileSync(
      path.join(dir, 'vitest.config.mjs'),
      `import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
})
`,
    )
  }
}

function createWorkspace({ taskId, arm, promptStyle, toolchains }) {
  const task = TASKS[taskId]
  const taskDir = path.join(__dirname, 'tasks', taskId)
  const dir = mkdtempSync(path.join(tmpdir(), `ep-bench-${taskId}-${arm}-`))

  cpSync(path.join(taskDir, 'src'), path.join(dir, 'src'), { recursive: true })

  const promptFile =
    promptStyle === 'symptom' && existsSync(path.join(taskDir, 'PROMPT_SYMPTOM.md'))
      ? path.join(taskDir, 'PROMPT_SYMPTOM.md')
      : path.join(taskDir, 'PROMPT.md')
  cpSync(promptFile, path.join(dir, 'PROMPT.md'))

  const guideFile =
    arm === 'treatment'
      ? path.join(__dirname, 'guides/treatment-guide.md')
      : path.join(__dirname, 'guides/control-guide.md')
  cpSync(guideFile, path.join(dir, 'TESTING_GUIDE.md'))

  writePristineWorkspaceConfigs(dir, task, arm)
  toolchains.installForTrial(arm, dir)

  return dir
}

function buildAgentPrompt(task) {
  return [
    'You are debugging and fixing an asynchronous concurrency bug in this standalone TypeScript + Vitest workspace.',
    'Start by reading `PROMPT.md` and `TESTING_GUIDE.md`, then inspect all files under `src/`.',
    `Follow every constraint in \`PROMPT.md\` and \`TESTING_GUIDE.md\`, add deterministic regression tests in \`${task.testRel}\`, fix the bug in \`${task.targetRel}\`, and verify \`npm test\` and \`npm run check\` both pass before finishing.`,
    'Do not monkey-patch JavaScript or Node.js globals, do not add real-time sleeps or retry loops, and do not add test-only hooks or extra exports to production files.',
  ].join('\n')
}

async function runCmd(bin, args, cwd, timeoutMs = 90_000) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', CI: '1' },
    })
    return { ok: true, code: 0, stdout, stderr }
  } catch (err) {
    return {
      ok: false,
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(err.message ?? err),
    }
  }
}

/**
 * Runs Vitest with JSON reporter and classifies outcome (P1.1):
 * - 'passed': all tests passed (numPassedTests > 0)
 * - 'true_red': at least one test executed and failed with a genuine AssertionError
 * - 'timeout': failed due to Vitest test/hook timeout (NEVER counts as true_red!)
 * - 'loud_break': compile/import/transform/selection error or 0 executed tests
 */
async function runVitestClassified(dir, testRel) {
  const jsonPath = path.join(
    dir,
    `.vitest-report-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  )
  const vitestBin = path.join(dir, 'node_modules/.bin/vitest')
  const res = await runCmd(
    vitestBin,
    ['run', testRel, '--testTimeout=1500', '--reporter=json', `--outputFile=${jsonPath}`],
    dir,
    90_000,
  )

  let report = null
  try {
    if (existsSync(jsonPath)) {
      report = JSON.parse(readFileSync(jsonPath, 'utf8'))
    }
  } catch {
    report = null
  } finally {
    rmSync(jsonPath, { force: true })
  }

  if (!report || !Array.isArray(report.testResults) || report.testResults.length === 0) {
    const raw = (res.stderr || res.stdout).slice(0, 400)
    const isTimeout = /timed out|timeout/i.test(raw)
    return {
      ok: res.ok,
      outcome: res.ok ? 'passed' : isTimeout ? 'timeout' : 'loud_break',
      numPassed: 0,
      numFailed: 0,
      summary: raw,
    }
  }

  const allAssertions = report.testResults.flatMap((tr) => tr.assertionResults ?? [])
  const failedAssertions = allAssertions.filter((a) => a.status === 'failed')
  const passedAssertions = allAssertions.filter((a) => a.status === 'passed')
  const fileLevelErrors = report.testResults.filter(
    (tr) => tr.status === 'failed' && (!tr.assertionResults || tr.assertionResults.length === 0),
  )

  if (report.success && passedAssertions.length > 0 && failedAssertions.length === 0) {
    return {
      ok: true,
      outcome: 'passed',
      numPassed: passedAssertions.length,
      numFailed: 0,
      summary: `${passedAssertions.length} passed`,
    }
  }

  if (fileLevelErrors.length > 0 && failedAssertions.length === 0) {
    const msg = fileLevelErrors.map((f) => f.message || '').join('\n')
    return {
      ok: false,
      outcome: 'loud_break',
      numPassed: passedAssertions.length,
      numFailed: 0,
      summary: msg.slice(0, 400),
    }
  }

  const timeoutPattern = /Test timed out|Hook timed out|timed out in \d+ms/i
  const loudBreakPattern =
    /matched 0|matched \d+|Cannot find module|SyntaxError|Transform failed|ExecutionPoint|Failed to resolve import|is not a function/i

  let hasGenuineAssertionFail = false
  let hasTimeout = false
  for (const a of failedAssertions) {
    const msg = (a.failureMessages ?? []).join('\n')
    if (timeoutPattern.test(msg)) {
      hasTimeout = true
    } else if (!loudBreakPattern.test(msg)) {
      hasGenuineAssertionFail = true
    }
  }

  const outcome = hasGenuineAssertionFail ? 'true_red' : hasTimeout ? 'timeout' : 'loud_break'

  return {
    ok: false,
    outcome,
    numPassed: passedAssertions.length,
    numFailed: failedAssertions.length,
    summary: (failedAssertions[0]?.failureMessages?.[0] ?? res.stderr ?? '').slice(0, 400),
  }
}

/**
 * Runs the hidden `yield-engine` oracle grader in a fresh isolated sandbox
 * over the ENTIRE `src/` tree (so multi-file fixes like V7 work cleanly) using
 * pristine configs and the separate checksum-verified grader toolchain.
 */
async function runHiddenOracleGrader({ taskId, srcFilesOrDir, toolchains, runVisibleToo = true }) {
  toolchains.verifyGraderChecksum()
  const task = TASKS[taskId]
  const graderDir = mkdtempSync(path.join(tmpdir(), `ep-grader-${taskId}-`))
  try {
    const destSrc = path.join(graderDir, 'src')
    mkdirSync(destSrc, { recursive: true })

    if (typeof srcFilesOrDir === 'string') {
      copyNonTestSrc(srcFilesOrDir, destSrc)
    } else {
      const baseline = readTaskBaselineFiles(taskId)
      for (const [rel, content] of Object.entries({ ...baseline, ...srcFilesOrDir })) {
        const outPath = path.join(graderDir, rel)
        mkdirSync(path.dirname(outPath), { recursive: true })
        writeFileSync(outPath, content)
      }
    }

    cpSync(path.join(__dirname, 'graders/yield-engine.mjs'), path.join(graderDir, 'yield-engine.mjs'))
    cpSync(path.join(__dirname, 'graders/yield-plugin.mjs'), path.join(graderDir, 'yield-plugin.mjs'))
    cpSync(task.graderFile, path.join(graderDir, '__grader__.test.ts'))

    if (runVisibleToo) {
      cpSync(
        path.join(__dirname, 'tasks', taskId, task.testRel),
        path.join(graderDir, '__visible__.test.ts'),
      )
      const visPath = path.join(graderDir, '__visible__.test.ts')
      const visText = readFileSync(visPath, 'utf8').replace(
        /from\s+(['"])\.\/([^'"]+)\1/g,
        'from $1./src/$2$1',
      )
      writeFileSync(visPath, visText)
    }

    writeFileSync(
      path.join(graderDir, 'package.json'),
      JSON.stringify({ name: `grader-${taskId}`, private: true, type: 'module' }, null, 2) + '\n',
    )
    writeFileSync(
      path.join(graderDir, 'vitest.config.mjs'),
      `import { defineConfig } from 'vitest/config'
import { benchYieldPlugin } from './yield-plugin.mjs'

export default defineConfig({
  plugins: [benchYieldPlugin({ root: ${JSON.stringify(graderDir)} })],
  test: { environment: 'node', testTimeout: 30000 },
})
`,
    )

    toolchains.installForGrader(graderDir)
    const vitestBin = path.join(graderDir, 'node_modules/.bin/vitest')

    const oracleRes = await runCmd(vitestBin, ['run', '__grader__.test.ts'], graderDir, 90_000)
    let visibleRes = { ok: true, stdout: '', stderr: '' }
    if (runVisibleToo) {
      visibleRes = await runCmd(vitestBin, ['run', '__visible__.test.ts'], graderDir, 60_000)
    }

    return {
      oraclePass: oracleRes.ok,
      visibleTestsPass: visibleRes.ok,
      output: (oracleRes.stdout + '\n' + oracleRes.stderr).trim().slice(-1500),
      visibleOutput: (visibleRes.stdout + '\n' + visibleRes.stderr).trim().slice(-800),
    }
  } finally {
    rmSync(graderDir, { recursive: true, force: true })
  }
}

/**
 * Evaluates the agent's test suite (including any support files it added under `src/`)
 * against:
 * 1. Pristine buggy baseline (`redReproducesBug` — must be `true_red`, NOT `timeout` or `loud_break`!)
 * 2. Single-bug mutants (`P1.2` `singleBugMutants` -> `adequateReproduction`)
 * 3. Behavior-preserving buggy refactors (`P1.3` false-green rate)
 * 4. Valid alternative fixes (`P1.3` false-red assertion rate vs loud breaks)
 */
async function evaluateAgentTests({ taskId, arm, agentSrcFiles, toolchains }) {
  const task = TASKS[taskId]
  const baselineFiles = readTaskBaselineFiles(taskId)
  const evalDir = mkdtempSync(path.join(tmpdir(), `ep-test-eval-${taskId}-${arm}-`))

  try {
    writePristineWorkspaceConfigs(evalDir, task, arm)
    toolchains.installForTrial(arm, evalDir)

    const writeFiles = (filesMap) => {
      // Remove previously written non-test production files before overlaying variant
      const srcDir = path.join(evalDir, 'src')
      rmSync(srcDir, { recursive: true, force: true })
      mkdirSync(srcDir, { recursive: true })
      // P1.1: Copy agent's test file AND any extra test-helper files not in baseline production files
      for (const [rel, content] of Object.entries(agentSrcFiles)) {
        if (!rel.startsWith('src/')) continue
        if (rel === task.testRel || rel.endsWith('.test.ts') || !(rel in baselineFiles)) {
          const out = path.join(evalDir, rel)
          mkdirSync(path.dirname(out), { recursive: true })
          writeFileSync(out, content)
        }
      }
      // Overlay the variant's production files
      for (const [rel, content] of Object.entries(filesMap)) {
        const out = path.join(evalDir, rel)
        mkdirSync(path.dirname(out), { recursive: true })
        writeFileSync(out, content)
      }
    }

    // 1. Baseline RED check
    writeFiles(baselineFiles)
    const redResult = await runVitestClassified(evalDir, task.testRel)

    // 2. P1.2 Single-bug mutants
    const mutants = SINGLE_BUG_MUTANTS[taskId] ?? []
    const mutantResults = []
    for (const m of mutants) {
      writeFiles({ ...baselineFiles, ...m.files })
      const r = await runVitestClassified(evalDir, task.testRel)
      mutantResults.push({ id: m.id, outcome: r.outcome, detected: r.outcome === 'true_red' })
    }
    const allMutantsDetected = mutantResults.every((m) => m.detected)

    // 3. P1.3 Buggy refactors (false-green rate)
    const refactors = buildBuggyRefactors(taskId, baselineFiles)
    const refactorResults = []
    for (const ref of refactors) {
      writeFiles(ref.files)
      const r = await runVitestClassified(evalDir, task.testRel)
      refactorResults.push({
        id: ref.id,
        outcome: r.outcome === 'passed' ? 'false_green' : r.outcome,
        summary: r.summary,
      })
    }

    // 4. P1.3 Valid alternative fixes (false-red assertion rate vs loud breaks)
    const validAlts = VALID_FIX_VARIANTS[taskId] ?? []
    const validResults = []
    for (const alt of validAlts) {
      writeFiles({ ...baselineFiles, ...alt.files })
      const r = await runVitestClassified(evalDir, task.testRel)
      validResults.push({
        id: alt.id,
        outcome:
          r.outcome === 'passed'
            ? 'true_green'
            : r.outcome === 'true_red'
              ? 'false_red_assertion'
              : r.outcome,
      })
    }

    return {
      redReproducesBug: redResult.outcome === 'true_red',
      redOutcome: redResult.outcome,
      redSummary: redResult.summary,
      singleBugMutants: {
        total: mutantResults.length,
        detectedCount: mutantResults.filter((m) => m.detected).length,
        allDetected: allMutantsDetected,
        results: mutantResults,
      },
      refactorRobustness: {
        total: refactorResults.length,
        trueRedCount: refactorResults.filter((r) => r.outcome === 'true_red').length,
        loudBreakCount: refactorResults.filter((r) => r.outcome === 'loud_break' || r.outcome === 'timeout').length,
        falseGreenCount: refactorResults.filter((r) => r.outcome === 'false_green').length,
        results: refactorResults,
      },
      validFixRobustness: {
        total: validResults.length,
        trueGreenCount: validResults.filter((r) => r.outcome === 'true_green').length,
        falseRedAssertionCount: validResults.filter((r) => r.outcome === 'false_red_assertion').length,
        loudBreakCount: validResults.filter((r) => r.outcome === 'loud_break' || r.outcome === 'timeout').length,
        results: validResults,
      },
    }
  } finally {
    rmSync(evalDir, { recursive: true, force: true })
  }
}

function runCopilotTrial({ workspaceDir, model, reasoning, prompt, timeoutSec, maxCredits }) {
  const sidecarDir = mkdtempSync(path.join(tmpdir(), 'ep-copilot-home-'))
  const usageFile = path.join(sidecarDir, 'usage.json')

  return new Promise((resolve) => {
    const start = Date.now()
    const args = [
      '-p',
      prompt,
      '--model',
      model,
      '--reasoning-effort',
      reasoning,
      '--allow-all-tools',
      '--allow-all-paths',
      '--no-auto-update',
      '--dynamic-retrieval',
      'skills=off',
      '--no-custom-instructions',
      '--disable-builtin-mcps',
      '--no-ask-user',
      '--disallow-temp-dir',
      '--output-format',
      'json',
      '--usage-output-file',
      usageFile,
    ]
    if (maxCredits >= 30) {
      args.push('--max-ai-credits', String(maxCredits))
    }

    const child = spawn('copilot', args, {
      cwd: workspaceDir,
      detached: true,
      env: {
        ...process.env,
        COPILOT_HOME: sidecarDir,
        COPILOT_AUTO_UPDATE: 'false',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let spawnError = null

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    const killGroup = () => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // already exited
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // already exited
        }
      }, 3_000).unref()
    }

    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, timeoutSec * 1000)

    const finalize = (exitCode) => {
      clearTimeout(timer)
      const durationMs = Date.now() - start
      let usageRaw = null
      try {
        if (existsSync(usageFile)) {
          usageRaw = JSON.parse(readFileSync(usageFile, 'utf8'))
        }
      } catch {
        usageRaw = null
      }
      rmSync(sidecarDir, { recursive: true, force: true })
      resolve({
        exitCode: exitCode ?? -1,
        timedOut,
        spawnError,
        durationMs,
        stdout,
        stderr,
        usageRaw,
      })
    }

    child.on('error', (err) => {
      spawnError = err.message
      finalize(-1)
    })
    child.on('close', (code) => {
      finalize(code)
    })
  })
}

function parseCopilotEvents(stdout, targetRel) {
  const toolCalls = {}
  const filesRead = new Set()
  let totalToolCalls = 0
  let compactions = 0
  let deniedToolCalls = 0
  let firstSourceEditIndex = -1
  let firstFailingTestIndex = -1
  let firstSourceEditAt = null
  let firstFailingTestAt = null
  let eventIndex = 0
  const testCallIds = new Set()

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const ev = JSON.parse(trimmed)
      eventIndex++
      const type = ev.type ?? ''
      const ts = ev.timestamp ?? null
      if (/compact/i.test(type)) compactions++

      if (type === 'tool.execution_start') {
        const name = ev.data?.toolName ?? ev.toolName ?? 'unknown'
        toolCalls[name] = (toolCalls[name] ?? 0) + 1
        totalToolCalls++
        const argsObj = ev.data?.arguments ?? ev.arguments ?? {}
        const rawArgs = JSON.stringify(argsObj)
        if (name === 'view' && typeof argsObj?.path === 'string') {
          filesRead.add(path.basename(argsObj.path))
        }
        if (
          (name === 'edit' || name === 'create' || name === 'apply_patch') &&
          rawArgs.includes(path.basename(targetRel)) &&
          !rawArgs.includes('.test.ts') &&
          firstSourceEditIndex === -1
        ) {
          firstSourceEditIndex = eventIndex
          firstSourceEditAt = ts
        }
        if (
          (name === 'bash' || name === 'shell' || name === 'run_shell_command') &&
          /npm test|vitest/.test(rawArgs)
        ) {
          const callId = ev.data?.toolCallId ?? ev.toolCallId
          if (callId) testCallIds.add(callId)
        }
      } else if (type === 'tool.execution_complete') {
        const callId = ev.data?.toolCallId ?? ev.toolCallId
        const success = ev.data?.success ?? ev.success
        const content = String(ev.data?.result?.content ?? ev.data?.content ?? '')
        if (/denied|permission denied/i.test(content)) deniedToolCalls++
        if (callId && testCallIds.has(callId)) {
          if (success === false || /FAIL\s+src\/|AssertionError|expected .+ to/i.test(content)) {
            if (firstFailingTestIndex === -1) {
              firstFailingTestIndex = eventIndex
              firstFailingTestAt = ts
            }
          }
        }
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  return {
    toolCalls,
    totalToolCalls,
    compactions,
    deniedToolCalls,
    filesRead: [...filesRead],
    firstFailingTestIndex,
    firstSourceEditIndex,
    firstFailingTestAt,
    firstSourceEditAt,
    firstRedBeforeFirstSourceEdit:
      firstFailingTestIndex !== -1 &&
      (firstSourceEditIndex === -1 || firstFailingTestIndex < firstSourceEditIndex),
  }
}

async function runAgentPhase({
  taskId,
  arm,
  model,
  reasoning,
  trialIndex,
  promptStyle,
  timeoutSec,
  maxCredits,
  outDir,
  toolchains,
}) {
  const task = TASKS[taskId]
  const workspaceDir = createWorkspace({ taskId, arm, promptStyle, toolchains })
  const trialId = `${taskId}__${arm}__${model}__${reasoning}__t${trialIndex}`
  const trialLogDir = path.join(outDir, 'trials', trialId)
  mkdirSync(trialLogDir, { recursive: true })

  const prompt = buildAgentPrompt(task)
  const cli = await runCopilotTrial({
    workspaceDir,
    model,
    reasoning,
    prompt,
    timeoutSec,
    maxCredits,
  })

  writeFileSync(path.join(trialLogDir, 'events.jsonl'), cli.stdout)
  if (cli.stderr) writeFileSync(path.join(trialLogDir, 'stderr.txt'), cli.stderr)
  if (cli.usageRaw) {
    writeFileSync(path.join(trialLogDir, 'usage.json'), JSON.stringify(cli.usageRaw, null, 2))
  }

  const allWorkspaceFiles = collectRelativeFiles(workspaceDir)
  const agentSrcDir = path.join(workspaceDir, 'src')
  if (existsSync(agentSrcDir)) {
    cpSync(agentSrcDir, path.join(trialLogDir, 'src'), { recursive: true })
  }

  return {
    trialId,
    taskId,
    arm,
    model,
    reasoning,
    trialIndex,
    promptStyle,
    workspaceDir,
    trialLogDir,
    cli,
    allWorkspaceFiles,
  }
}

async function gradeTrialPhase({ phase1, copilotVersion, keepWorkspaces, toolchains }) {
  const {
    trialId,
    taskId,
    arm,
    model,
    reasoning,
    trialIndex,
    promptStyle,
    workspaceDir,
    trialLogDir,
    cli,
    allWorkspaceFiles,
  } = phase1
  const task = TASKS[taskId]

  try {
    const usage = extractUsageMetrics(cli.usageRaw, model)
    const eventStats = parseCopilotEvents(cli.stdout, task.targetRel)
    const agentSrcDir = path.join(workspaceDir, 'src')
    const targetText = allWorkspaceFiles[task.targetRel] ?? ''
    const testText = allWorkspaceFiles[task.testRel] ?? ''

    // Detect config tampering (did agent edit package.json, tsconfig.json, vitest.config.mjs, or points.ep?)
    const configFilesTouched = ['package.json', 'tsconfig.json', 'vitest.config.mjs', 'points.ep'].filter(
      (f) => f in allWorkspaceFiles,
    )

    // 1. AST audits (production + auxiliary files + test file)
    const productionAudit = targetText
      ? auditProductionAst(targetText, {
          targetRel: task.targetRel,
          expectedExports: Object.keys(task.expectedExports),
          expectedParamCounts: task.expectedExports,
          privateHelpers: task.asyncHelpers,
          requiredAsyncHelpers: task.asyncHelpers,
        })
      : {
          clean: false,
          extraExports: [],
          missingExports: ['<missing file>'],
          exportedPrivates: [],
          missingPrivates: [],
          syncStrippedHelpers: [],
          signatureChanges: [],
        }

    const prodViolations = []
    if (productionAudit.extraExports.length) prodViolations.push(`extraExports:${productionAudit.extraExports.join(',')}`)
    if (productionAudit.missingExports.length) prodViolations.push(`missingExports:${productionAudit.missingExports.join(',')}`)
    if (productionAudit.exportedPrivates.length) prodViolations.push(`exportedPrivates:${productionAudit.exportedPrivates.join(',')}`)
    if (productionAudit.missingPrivates.length) prodViolations.push(`missingPrivates:${productionAudit.missingPrivates.join(',')}`)
    if (productionAudit.syncStrippedHelpers.length) prodViolations.push(`syncStripped:${productionAudit.syncStrippedHelpers.join(',')}`)
    if (productionAudit.signatureChanges.length) prodViolations.push(`sigChanges:${JSON.stringify(productionAudit.signatureChanges)}`)

    const auxViolations = []
    for (const [auxRel, auxSpec] of Object.entries(task.auxAsyncChecks)) {
      const auxText = allWorkspaceFiles[auxRel]
      if (!auxText) {
        auxViolations.push(`missing ${auxRel}`)
      } else {
        // Aux seam files intentionally export their async helpers -> privateHelpers: []
        const auxAudit = auditProductionAst(auxText, {
          targetRel: auxRel,
          expectedExports: Object.keys(auxSpec.expectedExports),
          expectedParamCounts: auxSpec.expectedExports,
          privateHelpers: [],
          requiredAsyncHelpers: auxSpec.asyncHelpers,
        })
        if (!auxAudit.clean) {
          auxViolations.push(`${auxRel}: ${JSON.stringify(auxAudit)}`)
        }
      }
    }
    const cleanProduction = productionAudit.clean && auxViolations.length === 0

    const testAudit = testText
      ? auditTestAst(testText, task.testRel)
      : {
          technique: 'missing',
          usesExecutionPoints: false,
          usesModuleMock: false,
          usesFakeTimers: false,
          usesGlobalPatch: false,
          globalPatches: [],
          usesRealSleep: false,
          realSleeps: [],
        }
    const noGlobalMonkeyPatch = !testAudit.usesGlobalPatch
    const noRealSleeps = !testAudit.usesRealSleep

    // 2. Re-run agent's tests & type checks with PRISTINE workspace configs in a fresh sandbox
    writePristineWorkspaceConfigs(workspaceDir, task, arm)
    const tscBin = path.join(workspaceDir, 'node_modules/.bin/tsc')
    const agentTestRun = testText
      ? await runVitestClassified(workspaceDir, task.testRel)
      : { ok: false, outcome: 'loud_break', numPassed: 0, numFailed: 0, summary: 'missing test file' }

    // Equal production-only type check across both arms (`tsc --noEmit` on non-test src/)
    const prodTsconfig = path.join(workspaceDir, '.tsconfig.prod.json')
    writeFileSync(
      prodTsconfig,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ['node'],
        },
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.test.ts'],
      }),
    )
    const prodTypecheckRes = await runCmd(tscBin, ['-p', prodTsconfig, '--noEmit'], workspaceDir, 60_000)
    rmSync(prodTsconfig, { force: true })

    // Full workspace type check: plain `tsc --noEmit` in Control, `tsc --noEmit --runExternalCode` in Treatment
    const fullTypecheckRes =
      arm === 'treatment'
        ? await runCmd(tscBin, ['--noEmit', '--runExternalCode'], workspaceDir, 60_000)
        : await runCmd(tscBin, ['--noEmit'], workspaceDir, 60_000)

    const typecheckPass = prodTypecheckRes.ok && (arm === 'control' ? fullTypecheckRes.ok : true)
    const contractTypecheckPass = arm === 'treatment' ? fullTypecheckRes.ok : true

    // 3. Evaluate agent's test suite: RED + P1.2 single-bug mutants + P1.3 false-green & false-red robustness
    const testEval = testText
      ? await evaluateAgentTests({ taskId, arm, agentSrcFiles: allWorkspaceFiles, toolchains })
      : {
          redReproducesBug: false,
          redOutcome: 'loud_break',
          redSummary: 'missing test file',
          singleBugMutants: { total: 0, detectedCount: 0, allDetected: false, results: [] },
          refactorRobustness: { total: 0, trueRedCount: 0, loudBreakCount: 0, falseGreenCount: 0, results: [] },
          validFixRobustness: { total: 0, trueGreenCount: 0, falseRedAssertionCount: 0, loudBreakCount: 0, results: [] },
        }

    const adequateReproduction =
      testEval.redReproducesBug && testEval.singleBugMutants.allDetected && agentTestRun.ok

    // 4. Hidden yield-engine oracle grader + pristine visible tests over entire `src/`
    const grader = await runHiddenOracleGrader({
      taskId,
      srcFilesOrDir: agentSrcDir,
      toolchains,
      runVisibleToo: true,
    })

    // Pre-registered primary endpoint (PROTOCOL.md §2)
    const solved =
      grader.oraclePass &&
      grader.visibleTestsPass &&
      agentTestRun.ok &&
      adequateReproduction &&
      typecheckPass &&
      contractTypecheckPass &&
      cleanProduction &&
      noGlobalMonkeyPatch &&
      noRealSleeps

    const record = {
      trialId,
      taskId,
      stratum: task.stratum,
      arm,
      promptStyle,
      model,
      actualModel: usage.servedModel,
      reasoning,
      trialIndex,
      copilotVersion,
      graderChecksum: toolchains.graderChecksum,
      solved,
      oraclePass: grader.oraclePass,
      visibleTestsPass: grader.visibleTestsPass,
      agentTestsPass: agentTestRun.ok,
      redReproducesBug: testEval.redReproducesBug,
      redOutcome: testEval.redOutcome,
      adequateReproduction,
      singleBugMutants: testEval.singleBugMutants,
      typecheckPass,
      contractTypecheckPass,
      cleanProduction,
      productionViolations: [...prodViolations, ...auxViolations],
      noGlobalMonkeyPatch,
      globalMonkeyPatchViolations: testAudit.globalPatches,
      noRealSleeps,
      realSleepViolations: testAudit.realSleeps,
      technique: testAudit.technique,
      usesExecutionPoints: testAudit.usesExecutionPoints,
      usesViMock: testAudit.usesModuleMock,
      refactorRobustness: testEval.refactorRobustness,
      validFixRobustness: testEval.validFixRobustness,
      firstRedBeforeFirstSourceEdit: eventStats.firstRedBeforeFirstSourceEdit,
      firstFailingTestAt: eventStats.firstFailingTestAt,
      firstSourceEditAt: eventStats.firstSourceEditAt,
      compactions: eventStats.compactions,
      deniedToolCalls: eventStats.deniedToolCalls,
      filesRead: eventStats.filesRead,
      totalToolCalls: eventStats.totalToolCalls,
      toolCalls: eventStats.toolCalls,
      workspaceFileList: Object.keys(allWorkspaceFiles).sort(),
      configFilesPresent: configFilesTouched,
      durationMs: cli.durationMs,
      exitCode: cli.exitCode,
      timedOut: cli.timedOut,
      spawnError: cli.spawnError,
      usage,
      graderOutput: grader.oraclePass ? undefined : grader.output,
      typecheckError: typecheckPass
        ? undefined
        : (prodTypecheckRes.stdout + prodTypecheckRes.stderr + fullTypecheckRes.stdout + fullTypecheckRes.stderr).slice(0, 600),
      contractTypecheckError: contractTypecheckPass
        ? undefined
        : (fullTypecheckRes.stdout + fullTypecheckRes.stderr).slice(0, 600),
      workspaceDir: keepWorkspaces ? workspaceDir : undefined,
    }

    writeFileSync(path.join(trialLogDir, 'result.json'), JSON.stringify(record, null, 2))
    return record
  } catch (err) {
    const errorRecord = {
      trialId,
      taskId,
      stratum: task.stratum,
      arm,
      promptStyle,
      model,
      actualModel: model,
      reasoning,
      trialIndex,
      copilotVersion,
      solved: false,
      oraclePass: false,
      visibleTestsPass: false,
      agentTestsPass: false,
      redReproducesBug: false,
      adequateReproduction: false,
      typecheckPass: false,
      contractTypecheckPass: false,
      cleanProduction: false,
      noGlobalMonkeyPatch: false,
      noRealSleeps: false,
      technique: 'error',
      durationMs: cli.durationMs ?? 0,
      usage: extractUsageMetrics(cli.usageRaw, model),
      harnessError: err instanceof Error ? err.stack || err.message : String(err),
    }
    writeFileSync(path.join(trialLogDir, 'result.json'), JSON.stringify(errorRecord, null, 2))
    return errorRecord
  } finally {
    if (!keepWorkspaces) {
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  }
}

async function runSelfTest() {
  console.log('Running v2 benchmark harness self-test (P0 + P1 + P2)...\n')
  const toolchains = prepareToolchains(REPO_ROOT)
  let failures = 0

  try {
    // 1. CoW toolchain isolation + checksum verification
    console.log('1) Toolchain isolation & checksum verification...')
    assertNoRepoLeak(toolchains.controlNm, REPO_ROOT)
    assertNoRepoLeak(toolchains.treatmentNm, REPO_ROOT)
    toolchains.verifyGraderChecksum()
    if (existsSync(path.join(toolchains.controlNm, 'execution-points-prototype'))) {
      throw new Error('Control toolchain should not contain execution-points-prototype')
    }
    if (existsSync(path.join(toolchains.controlNm, '@tanstack'))) {
      throw new Error('Trial toolchain should not contain @tanstack')
    }
    if (existsSync(path.join(toolchains.controlNm, 'fast-check'))) {
      throw new Error('Trial toolchain should not contain fast-check')
    }
    console.log(`   PASS: isolated CoW toolchains verified (grader sha256=${toolchains.graderChecksum.slice(0, 12)}).\n`)

    // 2. AST auditor calibration (E8) + aux-file check
    console.log('2) AST auditor calibration...')
    const astCases = [
      {
        name: 'catches vi.spyOn(Promise, "resolve")',
        code: `import { vi } from 'vitest'; vi.spyOn(Promise, 'resolve')`,
        check: (r) => r.usesGlobalPatch && r.technique === 'global-patch',
      },
      {
        name: 'catches globalThis.Promise mutation',
        code: `globalThis.Promise.resolve = () => ({}) as any`,
        check: (r) => r.usesGlobalPatch,
      },
      {
        name: 'catches Object.defineProperty on Promise',
        code: `Object.defineProperty(Promise, 'resolve', { value: () => {} })`,
        check: (r) => r.usesGlobalPatch,
      },
      {
        name: 'catches vi.stubGlobal',
        code: `vi.stubGlobal('MessageChannel', class {})`,
        check: (r) => r.usesGlobalPatch,
      },
      {
        name: 'ignores setTimeout inside comment',
        code: `// Do not use setTimeout here\nimport { expect, test } from 'vitest'\ntest('ok', () => expect(1).toBe(1))`,
        check: (r) => !r.usesRealSleep && !r.usesGlobalPatch,
      },
      {
        name: 'allows setTimeout with vi.useFakeTimers()',
        code: `vi.useFakeTimers(); setTimeout(() => {}, 10); vi.advanceTimersByTimeAsync(10)`,
        check: (r) => !r.usesRealSleep && r.usesFakeTimers,
      },
      {
        name: 'flags real setTimeout without fake timers',
        code: `await new Promise((r) => setTimeout(r, 50))`,
        check: (r) => r.usesRealSleep,
      },
      {
        name: 'classifies select() + withReplacement()',
        code: `import { select } from 'execution-points-prototype'\nconst p = select('src/a.ts', n => n)\np.withReplacement(() => 1, () => 2)`,
        check: (r) => r.usesExecutionPoints && r.technique === 'execution-points' && !r.usesGlobalPatch,
      },
      {
        name: 'classifies vi.mock()',
        code: `import { vi } from 'vitest'\nvi.mock('./storage', () => ({}))`,
        check: (r) => r.usesModuleMock && r.technique === 'module-mock' && !r.usesGlobalPatch,
      },
    ]
    for (const c of astCases) {
      const res = auditTestAst(c.code)
      if (!c.check(res)) {
        console.error(`   FAIL: ${c.name} ->`, res)
        failures++
      }
    }
    // Verify aux seam file (exported async helpers) is clean when privateHelpers: []
    const storageSrc = readFileSync(path.join(__dirname, 'tasks/stale-cache-seam/src/storage.ts'), 'utf8')
    const storageAudit = auditProductionAst(storageSrc, {
      targetRel: 'src/storage.ts',
      expectedExports: Object.keys(TASKS['stale-cache-seam'].auxAsyncChecks['src/storage.ts'].expectedExports),
      expectedParamCounts: TASKS['stale-cache-seam'].auxAsyncChecks['src/storage.ts'].expectedExports,
      privateHelpers: [],
      requiredAsyncHelpers: TASKS['stale-cache-seam'].auxAsyncChecks['src/storage.ts'].asyncHelpers,
    })
    if (!storageAudit.clean) {
      console.error('   FAIL: aux seam storage.ts audit failed:', storageAudit)
      failures++
    }
    console.log(`   PASS: ${astCases.length} test-audit cases + aux seam audit verified.\n`)

    // 3. Treatment virtual contract type-check verification (`contentMappers` + `select()`)
    console.log('3) Treatment virtual contract check (select() + tsc --noEmit --runExternalCode)...')
    {
      const ws = createWorkspace({
        taskId: 'stale-cache',
        arm: 'treatment',
        promptStyle: 'symptom',
        toolchains,
      })
      try {
        writeFileSync(
          path.join(ws, 'src/profile-store.test.ts'),
          `import { expect, test } from 'vitest'
import { select } from 'execution-points-prototype'
import { getProfile, resetStore, seedProfile } from './profile-store'

const readPt = select('src/profile-store.ts', (n) =>
  n.inFunction === 'getProfile' && n.kind === 'CallExpression' && n.callee === 'readFromDb' ? n : undefined,
)

test('select virtual contract typechecks and executes', async () => {
  resetStore()
  seedProfile('u1', 'Alice')
  const res = await readPt.withReplacement(async ({ original }) => original(), () => getProfile('u1'))
  expect(res?.name).toBe('Alice')
})
`,
        )
        const tscBin = path.join(ws, 'node_modules/.bin/tsc')
        const tscRes = await runCmd(tscBin, ['--noEmit', '--runExternalCode'], ws)
        const vitestRes = await runVitestClassified(ws, 'src/profile-store.test.ts')
        if (!tscRes.ok || !vitestRes.ok) {
          console.error('   FAIL: Treatment select() contract check failed:', tscRes.stdout, tscRes.stderr, vitestRes)
          failures++
        } else {
          console.log('   PASS: Treatment select() passes tsc --noEmit --runExternalCode + vitest.\n')
        }
      } finally {
        rmSync(ws, { recursive: true, force: true })
      }
    }

    // 4. Timeout != true_red verification (P1.1)
    console.log('4) Timeout classification check (timeout must NOT count as true_red)...')
    {
      const ws = createWorkspace({
        taskId: 'stale-cache',
        arm: 'control',
        promptStyle: 'symptom',
        toolchains,
      })
      try {
        writeFileSync(
          path.join(ws, 'src/profile-store.test.ts'),
          `import { test } from 'vitest'
test('hangs forever waiting for uncalled seam', async () => {
  await new Promise(() => {})
}, 150)
`,
        )
        const res = await runVitestClassified(ws, 'src/profile-store.test.ts')
        if (res.outcome !== 'timeout') {
          console.error(`   FAIL: expected timeout, got ${res.outcome}:`, res.summary)
          failures++
        } else {
          console.log('   PASS: hanging test classified as timeout (not true_red).\n')
        }
      } finally {
        rmSync(ws, { recursive: true, force: true })
      }
    }

    // 5. Baseline workspace checks across all 10 tasks (control + treatment)
    console.log(`5) Baseline workspace checks across all ${Object.keys(TASKS).length} tasks (control + treatment)...`)
    for (const taskId of Object.keys(TASKS)) {
      const task = TASKS[taskId]
      for (const arm of ['control', 'treatment']) {
        const ws = createWorkspace({ taskId, arm, promptStyle: 'symptom', toolchains })
        try {
          const vitestRes = await runVitestClassified(ws, task.testRel)
          const tscBin = path.join(ws, 'node_modules/.bin/tsc')
          const tscArgs = arm === 'treatment' ? ['--noEmit', '--runExternalCode'] : ['--noEmit']
          const tscRes = await runCmd(tscBin, tscArgs, ws)
          const ok = vitestRes.ok && tscRes.ok
          console.log(
            `   ${ok ? 'PASS' : 'FAIL'} ${taskId.padEnd(22)} ${arm.padEnd(10)} baseline=${vitestRes.outcome} tsc=${tscRes.ok}`,
          )
          if (!ok) {
            failures++
            console.error('     ', vitestRes.summary, tscRes.stdout, tscRes.stderr)
          }
        } finally {
          rmSync(ws, { recursive: true, force: true })
        }
      }
    }
    console.log()

    // 6. Full calibration corpus across all 10 tasks
    console.log(`6) Grader calibration corpus (${CALIBRATION_VARIANTS.length} variants across 10 tasks)...`)
    for (const v of CALIBRATION_VARIANTS) {
      const srcFiles = v.useBaseline ? {} : v.files
      const res = await runHiddenOracleGrader({
        taskId: v.task,
        srcFilesOrDir: srcFiles,
        toolchains,
        runVisibleToo: true,
      })
      const actualPass = res.oraclePass && res.visibleTestsPass
      const matched = actualPass === v.expectPass
      const mark = matched ? 'PASS' : 'FAIL'
      console.log(
        `   ${mark} ${v.id.padEnd(5)} (${v.task.padEnd(21)}) expect=${String(v.expectPass).padEnd(5)} got=${String(actualPass).padEnd(5)} | ${v.label}`,
      )
      if (!matched) {
        failures++
        console.error('     oracle:', res.oraclePass, 'visible:', res.visibleTestsPass)
        console.error('     output:', res.output.slice(0, 600))
      }
    }
    console.log()

    // 7. Production AST audit on all 10 reference fixes
    console.log(`7) Production AST audit on all ${Object.keys(REFERENCE_FIXES).length} reference fixes...`)
    for (const [taskId, files] of Object.entries(REFERENCE_FIXES)) {
      const task = TASKS[taskId]
      const audit = auditProductionAst(files[task.targetRel], {
        targetRel: task.targetRel,
        expectedExports: Object.keys(task.expectedExports),
        expectedParamCounts: task.expectedExports,
        privateHelpers: task.asyncHelpers,
        requiredAsyncHelpers: task.asyncHelpers,
      })
      console.log(`   ${audit.clean ? 'PASS' : 'FAIL'} ${taskId}`)
      if (!audit.clean) {
        failures++
        console.error('     audit:', audit)
      }
    }
  } finally {
    closeAuditApi()
    toolchains.cleanup()
  }

  console.log()
  if (failures > 0) {
    console.error(`Self-test FAILED (${failures} failures).`)
    process.exit(1)
  }
  console.log(
    `Self-test PASSED (isolation, AST, contract tsc, timeout!=RED, 10 tasks, and ${CALIBRATION_VARIANTS.length} calibration variants matched).`,
  )
}

function summarizeByArm(results) {
  const groups = {}
  for (const r of results) {
    const g = (groups[r.arm] ??= {
      trials: 0,
      solved: 0,
      oraclePass: 0,
      redPass: 0,
      adequateRed: 0,
      cleanProduction: 0,
      noGlobalMonkeyPatch: 0,
      monkeyPatched: 0,
      usedExecutionPoints: 0,
      usedViMock: 0,
      firstRedBeforeEdit: 0,
      refactorTotal: 0,
      refactorFalseGreens: 0,
      refactorLoudBreaks: 0,
      validAltTotal: 0,
      validAltFalseReds: 0,
      validAltLoudBreaks: 0,
      totalTokens: 0,
      totalAiCredits: 0,
      totalUsd: 0,
      totalDurationMs: 0,
      techniques: {},
    })
    g.trials++
    if (r.solved) g.solved++
    if (r.oraclePass) g.oraclePass++
    if (r.redReproducesBug) g.redPass++
    if (r.adequateReproduction) g.adequateRed++
    if (r.cleanProduction) g.cleanProduction++
    if (r.noGlobalMonkeyPatch) g.noGlobalMonkeyPatch++
    else g.monkeyPatched++
    if (r.usesExecutionPoints) g.usedExecutionPoints++
    if (r.usesViMock) g.usedViMock++
    if (r.firstRedBeforeFirstSourceEdit) g.firstRedBeforeEdit++
    if (r.refactorRobustness) {
      g.refactorTotal += r.refactorRobustness.total ?? 0
      g.refactorFalseGreens += r.refactorRobustness.falseGreenCount ?? 0
      g.refactorLoudBreaks += r.refactorRobustness.loudBreakCount ?? 0
    }
    if (r.validFixRobustness) {
      g.validAltTotal += r.validFixRobustness.total ?? 0
      g.validAltFalseReds += r.validFixRobustness.falseRedAssertionCount ?? 0
      g.validAltLoudBreaks += r.validFixRobustness.loudBreakCount ?? 0
    }
    const u = r.usage ?? {}
    g.totalTokens += u.totalTokens ?? 0
    g.totalAiCredits += u.aiCredits ?? 0
    if (typeof u.estimatedUsd === 'number') g.totalUsd += u.estimatedUsd
    g.totalDurationMs += r.durationMs ?? 0
    g.techniques[r.technique ?? 'unknown'] = (g.techniques[r.technique ?? 'unknown'] ?? 0) + 1
  }

  for (const g of Object.values(groups)) {
    g.solvedCI = wilsonCI(g.solved, g.trials)
    g.oracleCI = wilsonCI(g.oraclePass, g.trials)
    g.adequateRedCI = wilsonCI(g.adequateRed, g.trials)
    g.falseGreenCI = wilsonCI(g.refactorFalseGreens, g.refactorTotal)
    g.falseRedCI = wilsonCI(g.validAltFalseReds, g.validAltTotal)
    g.avgDurationSec = g.trials ? g.totalDurationMs / g.trials / 1000 : 0
    g.avgTokensPerTrial = g.trials ? Math.round(g.totalTokens / g.trials) : 0
    g.tokensPerSolved = g.solved > 0 ? Math.round(g.totalTokens / g.solved) : null
    g.avgUsdPerTrial = g.trials ? g.totalUsd / g.trials : 0
    g.usdPerSolved = g.solved > 0 ? g.totalUsd / g.solved : null
  }
  return groups
}

function printSummary(results, byArm, outDir) {
  console.log('\n=== Per-Trial Results ===')
  const header = [
    'Task'.padEnd(21),
    'Stratum'.padEnd(13),
    'Arm'.padEnd(9),
    'Model'.padEnd(15),
    'Solv',
    'Orcl',
    'AdqR',
    'NoMP',
    'FG',
    'FR',
    'Technique'.padEnd(16),
    'Tokens'.padStart(8),
    'USD'.padStart(8),
    'Sec'.padStart(4),
  ].join(' | ')
  console.log(header)
  console.log('-'.repeat(header.length))

  for (const r of results) {
    const fg = r.refactorRobustness
      ? `${r.refactorRobustness.falseGreenCount}/${r.refactorRobustness.total}`
      : 'n/a'
    const fr = r.validFixRobustness
      ? `${r.validFixRobustness.falseRedAssertionCount}/${r.validFixRobustness.total}`
      : 'n/a'
    const row = [
      r.taskId.padEnd(21),
      (r.stratum ?? '').padEnd(13),
      r.arm.padEnd(9),
      r.model.slice(0, 15).padEnd(15),
      (r.solved ? 'PASS' : 'FAIL').padEnd(4),
      (r.oraclePass ? 'PASS' : 'FAIL').padEnd(4),
      (r.adequateReproduction ? 'YES' : 'NO').padEnd(4),
      (r.noGlobalMonkeyPatch ? 'YES' : 'NO').padEnd(4),
      fg.padEnd(3),
      fr.padEnd(3),
      String(r.technique ?? '').slice(0, 16).padEnd(16),
      String(r.usage?.totalTokens ?? 0).padStart(8),
      formatUsd(r.usage?.estimatedUsd).padStart(8),
      (r.durationMs / 1000).toFixed(0).padStart(4),
    ].join(' | ')
    console.log(row)
  }

  console.log('\n=== Per-Arm Aggregates (with 95% Wilson CIs) ===')
  for (const [arm, g] of Object.entries(byArm)) {
    console.log(
      [
        `${arm.toUpperCase()}: solved=${g.solved}/${g.trials} ${formatCI(g.solvedCI)}`,
        `oracle=${formatCI(g.oracleCI)}`,
        `adqRED=${formatCI(g.adequateRedCI)}`,
        `monkeyPatch=${g.monkeyPatched}/${g.trials}`,
        `FG=${formatCI(g.falseGreenCI)}`,
        `FR=${formatCI(g.falseRedCI)}`,
        `cost=${formatUsd(g.totalUsd)} (${formatUsd(g.usdPerSolved)}/solved)`,
        `tokens=${g.totalTokens.toLocaleString()} (${g.tokensPerSolved?.toLocaleString() ?? 'n/a'}/solved)`,
        `tech=${JSON.stringify(g.techniques)}`,
      ].join(' | '),
    )
  }
  const cmh = stratifiedCMH(results, (r) => Boolean(r.solved))
  console.log(
    `\nStratified CMH (solved): strata=${cmh.strataCount}, z=${cmh.z}, p=${cmh.pValue}, commonOR=${cmh.commonOddsRatio ?? 'n/a'}`,
  )
  console.log(`Artifacts & JSONL saved to: ${outDir}`)
  console.log(`Run \`node bench/analyze.mjs ${path.join(outDir, 'results.jsonl')}\` for full stratified report.`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.selfTest) {
    await runSelfTest()
    return
  }

  for (const t of opts.tasks) {
    if (!TASKS[t]) throw new Error(`Unknown task: ${t} (valid: ${Object.keys(TASKS).join(', ')})`)
  }

  const copilotVersion = getCopilotVersion()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = opts.outDir ?? path.join(__dirname, 'results', `v2-${stamp}`)
  mkdirSync(outDir, { recursive: true })
  const jsonlPath = path.join(outDir, 'results.jsonl')

  const rand = mulberry32(opts.seed)
  const jobs = []
  for (let t = 1; t <= opts.trials; t++) {
    for (const taskId of opts.tasks) {
      for (const spec of opts.models) {
        const [model, reasoning = 'medium'] = spec.split(':')
        const blockArms = [...opts.arms]
        if (blockArms.length === 2 && rand() < 0.5) {
          blockArms.reverse()
        }
        for (const arm of blockArms) {
          jobs.push({ taskId, arm, model, reasoning, trialIndex: t })
        }
      }
    }
  }

  console.log(
    `Starting v2 benchmark: ${jobs.length} trials (prompt=${opts.promptStyle}, phaseSplit=${opts.phaseSplit}, concurrency=${opts.concurrency}, timeout=${opts.timeoutSec}s, seed=${opts.seed})`,
  )
  console.log(`Copilot CLI: ${copilotVersion}`)
  console.log(`Output directory: ${outDir}`)

  const toolchains = prepareToolchains(REPO_ROOT)
  const results = []

  try {
    if (opts.phaseSplit) {
      // Phase 1 (P2.2): Run all Copilot CLI agent sessions first so grading CPU never contends with agents
      console.log(`\n--- Phase 1: Running ${jobs.length} agent trials (concurrency=${opts.concurrency}) ---`)
      const phase1Outputs = new Array(jobs.length)
      let nextIdx = 0
      async function agentWorker() {
        while (true) {
          const idx = nextIdx++
          if (idx >= jobs.length) return
          const job = jobs[idx]
          console.log(
            `[P1 ${idx + 1}/${jobs.length}] START ${job.taskId} (${TASKS[job.taskId].stratum}) | ${job.arm} | ${job.model}:${job.reasoning}`,
          )
          const p1 = await runAgentPhase({
            ...job,
            promptStyle: opts.promptStyle,
            timeoutSec: opts.timeoutSec,
            maxCredits: opts.maxCredits,
            outDir,
            toolchains,
          })
          phase1Outputs[idx] = p1
          const u = extractUsageMetrics(p1.cli.usageRaw, job.model)
          console.log(
            `[P1 ${idx + 1}/${jobs.length}] DONE  ${job.taskId} | ${job.arm} | exit=${p1.cli.exitCode} tokens=${u.totalTokens} cost=${formatUsd(u.estimatedUsd)} (${(p1.cli.durationMs / 1000).toFixed(1)}s)`,
          )
        }
      }
      await Promise.all(Array.from({ length: Math.min(opts.concurrency, jobs.length) }, agentWorker))

      // Phase 2 (P2.2): Grade serially off the agents' CPUs, streaming each record to results.jsonl
      console.log(`\n--- Phase 2: Grading ${jobs.length} trials serially ---`)
      for (let i = 0; i < phase1Outputs.length; i++) {
        const p1 = phase1Outputs[i]
        const r = await gradeTrialPhase({
          phase1: p1,
          copilotVersion,
          keepWorkspaces: opts.keepWorkspaces,
          toolchains,
        })
        results.push(r)
        appendFileSync(jsonlPath, JSON.stringify(r) + '\n')
        console.log(
          `[P2 ${i + 1}/${jobs.length}] GRADED ${r.taskId} | ${r.arm} -> solved=${r.solved} oracle=${r.oraclePass} adqRed=${r.adequateReproduction} noMP=${r.noGlobalMonkeyPatch} tech=${r.technique}`,
        )
      }
    } else {
      let nextIdx = 0
      async function inlineWorker() {
        while (true) {
          const idx = nextIdx++
          if (idx >= jobs.length) return
          const job = jobs[idx]
          console.log(
            `[${idx + 1}/${jobs.length}] START ${job.taskId} (${TASKS[job.taskId].stratum}) | ${job.arm} | ${job.model}:${job.reasoning}`,
          )
          const p1 = await runAgentPhase({
            ...job,
            promptStyle: opts.promptStyle,
            timeoutSec: opts.timeoutSec,
            maxCredits: opts.maxCredits,
            outDir,
            toolchains,
          })
          const r = await gradeTrialPhase({
            phase1: p1,
            copilotVersion,
            keepWorkspaces: opts.keepWorkspaces,
            toolchains,
          })
          results.push(r)
          appendFileSync(jsonlPath, JSON.stringify(r) + '\n')
          console.log(
            `[${idx + 1}/${jobs.length}] DONE  ${r.taskId} | ${r.arm} -> solved=${r.solved} oracle=${r.oraclePass} adqRed=${r.adequateReproduction} cost=${formatUsd(r.usage?.estimatedUsd)}`,
          )
        }
      }
      await Promise.all(Array.from({ length: Math.min(opts.concurrency, jobs.length) }, inlineWorker))
    }
  } finally {
    closeAuditApi()
    toolchains.cleanup()
  }

  const byArm = summarizeByArm(results)
  const cmh = stratifiedCMH(results, (r) => Boolean(r.solved))
  const summary = {
    version: 'v2-p2',
    generatedAt: new Date().toISOString(),
    copilotVersion,
    graderChecksum: toolchains.graderChecksum,
    config: {
      tasks: opts.tasks,
      arms: opts.arms,
      models: opts.models,
      promptStyle: opts.promptStyle,
      trials: opts.trials,
      concurrency: opts.concurrency,
      phaseSplit: opts.phaseSplit,
      timeoutSec: opts.timeoutSec,
      maxCredits: opts.maxCredits,
      seed: opts.seed,
    },
    pricingTablePerMillionUsd: MODEL_PRICING_PER_M,
    byArm,
    stratifiedCMH: cmh,
    results,
  }
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  printSummary(results, byArm, outDir)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
