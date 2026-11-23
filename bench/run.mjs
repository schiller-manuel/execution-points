#!/usr/bin/env node
/**
 * Controlled A/B benchmark runner (v2.1 — hardened against all re-review findings)
 * for evaluating whether `execution-points` helps coding agents (via GitHub Copilot CLI)
 * debug and fix hard asynchronous concurrency bugs.
 *
 * Safe by default:
 *   - Importing this module NEVER starts a run (OPS-01).
 *   - Running with no `--run` and no `--self-test` prints the dry-run plan and exits 0.
 *   - Requires `--run --tasks <...> --models <...>` for any paid run, enforces
 *     `--max-total-credits`, and installs SIGINT/SIGTERM cleanup handlers (OPS-02).
 *
 * Usage:
 *   node bench/run.mjs --self-test
 *   node bench/run.mjs --tasks stale-cache-seam --models gpt-6.2-astra:medium        # dry-run plan
 *   node bench/run.mjs --run --tasks stale-cache-seam --models gpt-6.2-astra:medium --trials 1
 */
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  auditExtraProductionFile,
  auditProductionAst,
  auditTestAst,
  auditTestTree,
  closeAuditApi,
} from './ast-audit.mjs'
import {
  buildBuggyRefactors,
  CALIBRATION_VARIANTS,
  REFERENCE_FIXES,
  SINGLE_BUG_MUTANTS,
  VALID_FIX_VARIANTS,
} from './calibration/variants.mjs'
import { buildMustRejectCheats, GOOD_WITNESSES } from './calibration/witnesses.mjs'
import { extractUsageMetrics, formatUsd, MODEL_PRICING_PER_M } from './pricing.mjs'
import { formatCI, matchedRiskDifferenceCI, stratifiedCMH, wilsonCI } from './stats.mjs'
import { assertNoRepoLeak, prepareToolchains, sweepStaleTempDirs } from './toolchain.mjs'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const RUNTIME_GUARD_PATH = path.join(__dirname, 'runtime-guard.setup.mjs')

const ENV_ALLOWLIST_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM']

export const TASKS = {
  // ── Stratum A: closed-module (capability stratum: tool vs no module seam) ──
  'stale-cache': {
    id: 'stale-cache',
    stratum: 'closed-module',
    targetRel: 'src/profile-store.ts',
    testRel: 'src/profile-store.test.ts',
    epTargets: ['src/profile-store.ts'],
    allowedTimerProdRels: [],
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
    allowedTimerProdRels: [],
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
    allowedTimerProdRels: [],
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

  // ── Stratum B: io-seam (equal-capability head-to-head with mockable seams) ─
  'stale-cache-seam': {
    id: 'stale-cache-seam',
    stratum: 'io-seam',
    targetRel: 'src/profile-store.ts',
    testRel: 'src/profile-store.test.ts',
    epTargets: ['src/profile-store.ts', 'src/storage.ts'],
    allowedTimerProdRels: [],
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
    allowedTimerProdRels: [],
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
    allowedTimerProdRels: [],
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
    allowedTimerProdRels: [],
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
    allowedTimerProdRels: [],
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
    allowedTimerProdRels: [],
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
    allowedTimerProdRels: ['src/search-controller.ts'],
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

// ── Provenance helpers (L-01) ───────────────────────────────────────────────
function hashDirFiles(dirPaths) {
  const h = createHash('sha256')
  const files = []
  function walk(d) {
    if (!existsSync(d)) return
    const st = statSync(d)
    if (st.isFile()) {
      files.push(d)
      return
    }
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'results' || entry.name === 'node_modules') continue
      walk(path.join(d, entry.name))
    }
  }
  for (const dp of dirPaths) walk(dp)
  for (const f of files.sort()) {
    h.update(path.relative(REPO_ROOT, f))
    h.update(readFileSync(f))
  }
  return h.digest('hex').slice(0, 16)
}

export function computeProvenance() {
  let gitCommit = 'unknown'
  let gitDirty = null
  try {
    gitCommit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    gitDirty = status.length > 0
  } catch {
    // non-git checkout
  }

  let vitestVersion = 'unknown'
  let typescriptVersion = 'unknown'
  try {
    vitestVersion = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'node_modules/vitest/package.json'), 'utf8'),
    ).version
  } catch {
    // ignore
  }
  try {
    typescriptVersion = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'node_modules/typescript/package.json'), 'utf8'),
    ).version
  } catch {
    // ignore
  }

  return {
    gitCommit,
    gitDirty,
    vitestVersion,
    typescriptVersion,
    harnessSha256: hashDirFiles([
      path.join(__dirname, 'run.mjs'),
      path.join(__dirname, 'toolchain.mjs'),
      path.join(__dirname, 'ast-audit.mjs'),
      path.join(__dirname, 'runtime-guard.setup.mjs'),
      path.join(__dirname, 'pricing.mjs'),
      path.join(__dirname, 'stats.mjs'),
      path.join(__dirname, 'analyze.mjs'),
      path.join(__dirname, 'graders'),
    ]),
    calibrationSha256: hashDirFiles([path.join(__dirname, 'calibration')]),
    lockfileSha256: hashDirFiles([path.join(REPO_ROOT, 'pnpm-lock.yaml')]),
    toolSha256: hashDirFiles([path.join(REPO_ROOT, 'src'), path.join(REPO_ROOT, 'package.json')]),
    tasksSha256: hashDirFiles([path.join(__dirname, 'tasks'), path.join(__dirname, 'guides')]),
  }
}

function getCopilotVersion() {
  try {
    return execFileSync('copilot', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')[0]
  } catch {
    return 'unknown'
  }
}

function parseArgs(argv) {
  const opts = {
    selfTest: false,
    run: false,
    tasks: null,
    arms: ['control', 'treatment'],
    models: null,
    promptStyle: 'symptom',
    trials: 1,
    concurrency: 2,
    timeoutSec: 360,
    cliCreditCap: 0, // N-32: 0 omits --max-ai-credits so CLI doesn't inject live cost meter into tool results
    maxTotalCredits: 300,
    maxConsecutiveInfra: 3, // N-05: abort run after k consecutive infra failures
    skipPreflight: false,
    sweepStale: false, // N-01: opt-in sweep so concurrent runs are never clobbered
    seed: 42,
    phaseSplit: true,
    keepWorkspaces: false,
    outDir: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--self-test') opts.selfTest = true
    else if (a === '--run') opts.run = true
    else if (a === '--tasks') opts.tasks = argv[++i].split(',').filter(Boolean)
    else if (a === '--arms') opts.arms = argv[++i].split(',').filter(Boolean)
    else if (a === '--models') opts.models = argv[++i].split(',').filter(Boolean)
    else if (a === '--prompt-style') opts.promptStyle = argv[++i]
    else if (a === '--trials') opts.trials = Number(argv[++i])
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i])
    else if (a === '--timeout') opts.timeoutSec = Number(argv[++i])
    else if (a === '--max-credits' || a === '--cli-credit-cap') opts.cliCreditCap = Number(argv[++i])
    else if (a === '--max-total-credits') opts.maxTotalCredits = Number(argv[++i])
    else if (a === '--max-consecutive-infra') opts.maxConsecutiveInfra = Number(argv[++i])
    else if (a === '--skip-preflight') opts.skipPreflight = true
    else if (a === '--sweep-stale') opts.sweepStale = true
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
  const task = TASKS[taskId]
  const files = {}
  for (const name of readdirSync(srcDir)) {
    const rel = `src/${name}`
    if (!name.endsWith('.ts') || rel === task.testRel) continue
    files[rel] = readFileSync(path.join(srcDir, name), 'utf8')
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

/**
 * Unified predicate: copies EVERY file under `src/` EXCEPT `task.testRel`
 * (closes R-01: `.spec.ts` files are copied AND transformed by role in yield-plugin!).
 */
function copyProductionSrcFromMap(filesMap, destRoot, excludeTestRel) {
  mkdirSync(path.join(destRoot, 'src'), { recursive: true })
  for (const [rel, content] of Object.entries(filesMap)) {
    if (!rel.startsWith('src/')) continue
    if (rel === excludeTestRel) continue
    const out = path.join(destRoot, rel)
    mkdirSync(path.dirname(out), { recursive: true })
    writeFileSync(out, content)
  }
}

/**
 * Writes pristine configs (blinded package name — closes R-06).
 * When `includeRuntimeGuard` is true (for grading sandboxes), injects
 * `bench/runtime-guard.setup.mjs` into `setupFiles`.
 */
function writePristineWorkspaceConfigs(dir, task, arm, { includeRuntimeGuard = false } = {}) {
  const pkg = {
    name: 'bench-workspace',
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

  const setupLine = includeRuntimeGuard
    ? `setupFiles: [${JSON.stringify(RUNTIME_GUARD_PATH)}],\n    `
    : ''
  // N-23: Pin exact include to task.testRel (blocks sibling .tsx/.test files from running!)
  // N-31: Pin reporters: ['default'] so COPILOT_CLI=1 doesn't switch to minimal agent reporter!
  const testBlock = `{ ${setupLine}include: [${JSON.stringify(task.testRel)}], reporters: ['default'], environment: 'node' }`
  const tsInclude = ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.mts', 'src/**/*.cts']

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
            allowJs: true,
            checkJs: true,
            types: ['node'],
          },
          contentMappers: [
            {
              package: 'execution-points-prototype',
              extensions: ['.ep'],
            },
          ],
          include: [...tsInclude, 'points.ep'],
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
  test: ${testBlock},
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
            allowJs: true,
            checkJs: true,
            types: ['node'],
          },
          include: tsInclude,
        },
        null,
        2,
      ) + '\n',
    )
    writeFileSync(
      path.join(dir, 'vitest.config.mjs'),
      `import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: ${testBlock},
})
`,
    )
  }

  return path.join(dir, 'vitest.config.mjs')
}

export function createWorkspace({ taskId, arm, promptStyle, toolchains, parentDir = realpathSync(tmpdir()) }) {
  const task = TASKS[taskId]
  const taskDir = path.join(__dirname, 'tasks', taskId)
  // N-00: Always realpath workspaceDir so /var -> /private/var matches Copilot CLI write rules!
  // R-06: Blinded workspace prefix (no arm or task name in path)
  const dir = realpathSync(mkdtempSync(path.join(parentDir, 'ep-ws-')))

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

  writePristineWorkspaceConfigs(dir, task, arm, { includeRuntimeGuard: false })
  const initialSnapshot = collectRelativeFiles(dir)
  toolchains.installForTrial(arm, dir)

  return { dir, initialSnapshot }
}

function buildAgentPrompt(task) {
  return [
    'You are debugging and fixing an asynchronous concurrency bug in this standalone TypeScript + Vitest workspace.',
    'Start by reading `PROMPT.md` and `TESTING_GUIDE.md`, then inspect all files under `src/`.',
    `Follow every constraint in \`PROMPT.md\` and \`TESTING_GUIDE.md\`, add deterministic regression tests in \`${task.testRel}\`, fix the bug in \`${task.targetRel}\`, and verify \`npm test\` and \`npm run check\` both pass before finishing.`,
    'Do not monkey-patch JavaScript or Node.js globals, do not add real-time sleeps or retry loops, and do not add test-only hooks or extra exports to production files.',
  ].join('\n')
}

async function runCmd(bin, args, cwd, { timeoutMs = 90_000, extraEnv = {} } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', CI: '1', ...extraEnv },
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
 * Runs Vitest with explicit `--config <pristineConfig>` (closes R-19),
 * JSON reporter, and runtime integrity guard (`BENCH_GUARD_REPORT`).
 *
 * Classifies outcome:
 * - 'passed': all tests passed AND numPassed > 0 AND 0 runtime guard violations
 * - 'runtime_violation': runtime guard detected global patch or real sleep
 * - 'true_red': >= 1 genuine AssertionError failure (no timeout/import/selector/guard error)
 * - 'timeout': Vitest test/hook timeout (NEVER counts as true_red!)
 * - 'loud_break': compile/import/transform/selection error or 0 executed tests
 */
async function runVitestClassified(
  dir,
  testRel,
  { configPath, testTimeoutMs = 1500, allowedTimerProdRels = [], requireGuardReport = false } = {},
) {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const jsonPath = path.join(dir, `.vitest-report-${token}.json`)
  // N-23: Per-worker report directory so sibling test files can NEVER erase another worker's sleep record!
  const guardReportDir = path.join(dir, `.guard-reports-${token}`)
  mkdirSync(guardReportDir, { recursive: true })
  const vitestBin = path.join(dir, 'node_modules/.bin/vitest')
  const cfg = configPath ?? path.join(dir, 'vitest.config.mjs')

  const allowedFiles = allowedTimerProdRels.map((r) => path.resolve(dir, r)).join(',')
  const res = await runCmd(
    vitestBin,
    [
      'run',
      testRel,
      '--config',
      cfg,
      `--testTimeout=${testTimeoutMs}`,
      '--reporter=json',
      `--outputFile=${jsonPath}`,
    ],
    dir,
    {
      timeoutMs: 90_000,
      extraEnv: {
        BENCH_GUARD_REPORT_DIR: guardReportDir,
        BENCH_GUARD_SRC_ROOT: path.join(dir, 'src'),
        BENCH_GUARD_ALLOWED_TIMER_FILES: allowedFiles,
      },
    },
  )

  let report = null
  const mergedGlobalPatches = new Set()
  const mergedRealSleeps = new Set()
  let guardFilesRead = 0
  try {
    if (existsSync(jsonPath)) report = JSON.parse(readFileSync(jsonPath, 'utf8'))
  } catch {
    report = null
  } finally {
    rmSync(jsonPath, { force: true })
  }
  try {
    if (existsSync(guardReportDir)) {
      for (const f of readdirSync(guardReportDir)) {
        if (!f.endsWith('.json')) continue
        const parsed = JSON.parse(readFileSync(path.join(guardReportDir, f), 'utf8'))
        guardFilesRead++
        for (const g of parsed.globalPatches ?? []) mergedGlobalPatches.add(g)
        for (const s of parsed.realSleeps ?? []) mergedRealSleeps.add(s)
      }
    }
  } catch {
    guardFilesRead = 0
  } finally {
    rmSync(guardReportDir, { recursive: true, force: true })
  }

  const guardMissing = requireGuardReport && guardFilesRead === 0
  const guardViolations = {
    globalPatches: [...mergedGlobalPatches],
    realSleeps: [...mergedRealSleeps],
    guardMissing,
  }

  const hasGuardViolation =
    guardViolations.globalPatches.length > 0 || guardViolations.realSleeps.length > 0

  if (guardMissing && res.ok) {
    // N-23: Fail closed — if guard setup produced zero report files while tests "passed", reject!
    return {
      ok: false,
      outcome: 'runtime_violation',
      numPassed: 0,
      numFailed: 0,
      guardViolations,
      summary: 'Fail-closed: runtime guard produced zero report files',
    }
  }

  if (!report || !Array.isArray(report.testResults) || report.testResults.length === 0) {
    const raw = (res.stderr || res.stdout).slice(0, 400)
    const isTimeout = /timed out|timeout/i.test(raw)
    return {
      ok: false, // NEVER pass when 0 test results executed (closes R-19 passWithNoTests!)
      outcome: hasGuardViolation ? 'runtime_violation' : isTimeout ? 'timeout' : 'loud_break',
      numPassed: 0,
      numFailed: 0,
      guardViolations,
      summary: raw || 'no tests executed',
    }
  }

  const allAssertions = report.testResults.flatMap((tr) => tr.assertionResults ?? [])
  const failedAssertions = allAssertions.filter((a) => a.status === 'failed')
  const passedAssertions = allAssertions.filter((a) => a.status === 'passed')
  const fileLevelErrors = report.testResults.filter(
    (tr) => tr.status === 'failed' && (!tr.assertionResults || tr.assertionResults.length === 0),
  )

  if (hasGuardViolation) {
    return {
      ok: false,
      outcome: 'runtime_violation',
      numPassed: passedAssertions.length,
      numFailed: failedAssertions.length,
      guardViolations,
      summary: `Runtime guard violations: ${JSON.stringify(guardViolations)}`,
    }
  }

  if (report.success && passedAssertions.length > 0 && failedAssertions.length === 0) {
    return {
      ok: true,
      outcome: 'passed',
      numPassed: passedAssertions.length,
      numFailed: 0,
      guardViolations,
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
      guardViolations,
      summary: msg.slice(0, 400),
    }
  }

  const timeoutPattern = /Test timed out|Hook timed out|timed out in \d+ms/i
  const loudBreakPattern =
    /matched 0|matched \d+|Cannot find module|SyntaxError|Transform failed|ExecutionPoint|Failed to resolve import|is not a function|Forbidden global monkey-patch|Forbidden sleep/i

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
    guardViolations,
    summary: (failedAssertions[0]?.failureMessages?.[0] ?? res.stderr ?? '').slice(0, 400),
  }
}

/**
 * Runs the hidden `yield-engine` oracle grader in a fresh isolated sandbox
 * over the ENTIRE `src/` tree (except `task.testRel`, so `.spec.ts` files ARE
 * copied and transformed — closes R-01!) with explicit `--config`.
 */
export async function runHiddenOracleGrader({
  taskId,
  srcFilesOrDir,
  toolchains,
  runVisibleToo = true,
  parentDir = realpathSync(tmpdir()),
}) {
  toolchains.verifyGraderChecksum()
  const task = TASKS[taskId]
  const graderDir = realpathSync(mkdtempSync(path.join(parentDir, `ep-grader-${taskId}-`)))
  try {
    if (typeof srcFilesOrDir === 'string') {
      const srcFiles = collectRelativeFiles(srcFilesOrDir, '')
      const prefixed = {}
      for (const [k, v] of Object.entries(srcFiles)) prefixed[`src/${k}`] = v
      copyProductionSrcFromMap(prefixed, graderDir, task.testRel)
    } else {
      const baseline = readTaskBaselineFiles(taskId)
      copyProductionSrcFromMap({ ...baseline, ...srcFilesOrDir }, graderDir, task.testRel)
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
      JSON.stringify({ name: 'grader-sandbox', private: true, type: 'module' }, null, 2) + '\n',
    )
    const graderCfg = path.join(graderDir, 'vitest.config.mjs')
    writeFileSync(
      graderCfg,
      `import { defineConfig } from 'vitest/config'
import { benchYieldPlugin } from './yield-plugin.mjs'

export default defineConfig({
  plugins: [benchYieldPlugin({ root: ${JSON.stringify(graderDir)} })],
  test: { environment: 'node', testTimeout: 30000, reporters: ['default'] },
})
`,
    )

    toolchains.installForGrader(graderDir)
    const vitestBin = path.join(graderDir, 'node_modules/.bin/vitest')

    // N-20: Use Vitest JSON reporter for oracle verdict and full per-test diagnostics
    const oracleJsonPath = path.join(graderDir, '.oracle-report.json')
    const oracleRes = await runCmd(
      vitestBin,
      ['run', '__grader__.test.ts', '--config', graderCfg, '--reporter=json', `--outputFile=${oracleJsonPath}`],
      graderDir,
    )
    let oracleReport = null
    try {
      if (existsSync(oracleJsonPath)) oracleReport = JSON.parse(readFileSync(oracleJsonPath, 'utf8'))
    } catch {
      oracleReport = null
    }
    const oracleTests = (oracleReport?.testResults ?? []).flatMap((tr) =>
      (tr.assertionResults ?? []).map((a) => ({
        title: a.fullName ?? a.title,
        status: a.status,
        failure: a.failureMessages?.[0]?.slice(0, 600),
      })),
    )
    const unhandledErrors = oracleReport?.numUnhandledErrors ?? 0
    const oraclePass =
      Boolean(oracleRes.ok) &&
      Boolean(oracleReport?.success) &&
      oracleTests.length > 0 &&
      oracleTests.every((t) => t.status === 'passed') &&
      unhandledErrors === 0

    let visibleRes = { ok: true, stdout: '', stderr: '' }
    if (runVisibleToo) {
      visibleRes = await runCmd(
        vitestBin,
        ['run', '__visible__.test.ts', '--config', graderCfg],
        graderDir,
        { timeoutMs: 60_000 },
      )
    }

    return {
      oraclePass,
      visibleTestsPass: visibleRes.ok,
      unhandledErrors,
      oracleTests,
      output: (oracleRes.stdout + '\n' + oracleRes.stderr).trim().slice(-2500),
      visibleOutput: (visibleRes.stdout + '\n' + visibleRes.stderr).trim().slice(-800),
    }
  } finally {
    rmSync(graderDir, { recursive: true, force: true })
  }
}

export async function evaluateAgentTests({
  taskId,
  arm,
  agentSrcFiles,
  toolchains,
  parentDir = realpathSync(tmpdir()),
}) {
  const task = TASKS[taskId]
  const baselineFiles = readTaskBaselineFiles(taskId)
  const evalDir = realpathSync(mkdtempSync(path.join(parentDir, `ep-test-eval-${taskId}-`)))

  try {
    const cfgPath = writePristineWorkspaceConfigs(evalDir, task, arm, {
      includeRuntimeGuard: true,
    })
    toolchains.installForTrial(arm, evalDir)

    const runtimeGlobalPatches = []
    const runtimeRealSleeps = []
    const collectGuard = (r) => {
      if (r.guardViolations?.globalPatches?.length) {
        runtimeGlobalPatches.push(...r.guardViolations.globalPatches)
      }
      if (r.guardViolations?.realSleeps?.length) {
        runtimeRealSleeps.push(...r.guardViolations.realSleeps)
      }
    }

    const writeVariant = (filesMap) => {
      const srcDir = path.join(evalDir, 'src')
      rmSync(srcDir, { recursive: true, force: true })
      mkdirSync(srcDir, { recursive: true })
      // Copy agent's test file and any extra helper files not in baseline production files
      for (const [rel, content] of Object.entries(agentSrcFiles)) {
        if (!rel.startsWith('src/')) continue
        if (rel === task.testRel || !(rel in baselineFiles)) {
          const out = path.join(evalDir, rel)
          mkdirSync(path.dirname(out), { recursive: true })
          writeFileSync(out, content)
        }
      }
      for (const [rel, content] of Object.entries(filesMap)) {
        const out = path.join(evalDir, rel)
        mkdirSync(path.dirname(out), { recursive: true })
        writeFileSync(out, content)
      }
    }

    const runOpts = {
      configPath: cfgPath,
      testTimeoutMs: 1500,
      allowedTimerProdRels: task.allowedTimerProdRels,
      requireGuardReport: true,
    }

    // 1. Baseline RED check
    writeVariant(baselineFiles)
    const redResult = await runVitestClassified(evalDir, task.testRel, runOpts)
    collectGuard(redResult)

    // 2. P1.2 Single-bug mutants
    const mutants = SINGLE_BUG_MUTANTS[taskId] ?? []
    const mutantResults = []
    for (const m of mutants) {
      writeVariant({ ...baselineFiles, ...m.files })
      const r = await runVitestClassified(evalDir, task.testRel, runOpts)
      collectGuard(r)
      mutantResults.push({ id: m.id, outcome: r.outcome, detected: r.outcome === 'true_red' })
    }
    const allMutantsDetected = mutantResults.every((m) => m.detected)

    // 3. Two-sided adequacy: MUST pass on the task's shipped reference fix (closes E-06 & L-11!)
    const refFiles = REFERENCE_FIXES[taskId]
    writeVariant({ ...baselineFiles, ...refFiles })
    const refRun = await runVitestClassified(evalDir, task.testRel, runOpts)
    collectGuard(refRun)
    const refFixPass = refRun.outcome === 'passed'

    // 4. E9 Buggy refactors (false-green rate)
    const refactors = buildBuggyRefactors(taskId, baselineFiles)
    const refactorResults = []
    for (const ref of refactors) {
      writeVariant(ref.files)
      const r = await runVitestClassified(evalDir, task.testRel, runOpts)
      collectGuard(r)
      refactorResults.push({
        id: ref.id,
        outcome: r.outcome === 'passed' ? 'false_green' : r.outcome,
        summary: r.summary,
      })
    }

    // 5. E9 Valid alternative fixes (E9-01: separate assertion, timeout, and selector/compile break!)
    const validAlts = VALID_FIX_VARIANTS[taskId] ?? []
    const validResults = []
    for (const alt of validAlts) {
      writeVariant({ ...baselineFiles, ...alt.files })
      const r = await runVitestClassified(evalDir, task.testRel, runOpts)
      collectGuard(r)
      validResults.push({
        id: alt.id,
        outcome:
          r.outcome === 'passed'
            ? 'true_green'
            : r.outcome === 'true_red'
              ? 'false_red_assertion'
              : r.outcome === 'timeout'
                ? 'timeout'
                : 'selector_or_compile_break',
      })
    }

    return {
      redReproducesBug: redResult.outcome === 'true_red',
      redOutcome: redResult.outcome,
      redSummary: redResult.summary,
      refFixPass,
      refFixOutcome: refRun.outcome,
      runtimeGlobalPatches: [...new Set(runtimeGlobalPatches)],
      runtimeRealSleeps: [...new Set(runtimeRealSleeps)],
      singleBugMutants: {
        total: mutantResults.length,
        detectedCount: mutantResults.filter((m) => m.detected).length,
        allDetected: allMutantsDetected,
        results: mutantResults,
      },
      refactorRobustness: {
        total: refactorResults.length,
        trueRedCount: refactorResults.filter((r) => r.outcome === 'true_red').length,
        loudBreakCount: refactorResults.filter(
          (r) => r.outcome === 'loud_break' || r.outcome === 'timeout',
        ).length,
        falseGreenCount: refactorResults.filter((r) => r.outcome === 'false_green').length,
        results: refactorResults,
      },
      validFixRobustness: {
        total: validResults.length,
        trueGreenCount: validResults.filter((r) => r.outcome === 'true_green').length,
        falseRedAssertionCount: validResults.filter((r) => r.outcome === 'false_red_assertion')
          .length,
        timeoutCount: validResults.filter((r) => r.outcome === 'timeout').length,
        selectorOrCompileBreakCount: validResults.filter(
          (r) => r.outcome === 'selector_or_compile_break',
        ).length,
        results: validResults,
      },
    }
  } finally {
    rmSync(evalDir, { recursive: true, force: true })
  }
}

/**
 * Builds an explicit allowlisted environment for each trial (closes I-04 & R-05).
 */
function buildAgentEnv(sidecarHome, trialTmpDir) {
  const env = {
    COPILOT_HOME: sidecarHome,
    COPILOT_AUTO_UPDATE: 'false',
    NO_COLOR: '1',
    TMPDIR: trialTmpDir,
    TMP: trialTmpDir,
    TEMP: trialTmpDir,
  }
  for (const key of ENV_ALLOWLIST_KEYS) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]
    }
  }
  return env
}

const activeChildren = new Set()
const activeTempDirs = new Set()

function killProcessGroup(pid) {
  if (!pid) return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // already exited
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // already exited
    }
  }, 2_000).unref()
}

/**
 * Configures Copilot CLI's OS-level `--sandbox` policy inside the per-trial
 * `COPILOT_HOME` sidecar (closes N-30 — verified live on macOS L3c–L3e!).
 */
function configureHardenedSandbox(sidecarDir, env) {
  const nodeInstallRoot = path.dirname(path.dirname(realpathSync(process.execPath)))
  const settings = [
    ['sandbox.userPolicy.filesystem.readonlyPaths', nodeInstallRoot],
    ['sandbox.auth.gh', 'false'],
    ['sandbox.auth.git', 'false'],
    ['sandbox.userPolicy.network.allowOutbound', 'false'],
    ['sandbox.userPolicy.network.blockedHosts', '*'],
    ['sandbox.allowBypass', 'false'],
  ]
  for (const [k, v] of settings) {
    const res = spawnSync('copilot', ['config', k, v], { env, encoding: 'utf8' })
    if (res.status !== 0) {
      throw new Error(`Failed to configure sandbox (${k}=${v}): ${res.stderr || res.stdout}`)
    }
  }
}

function runCopilotTrial({
  workspaceDir,
  model,
  reasoning,
  prompt,
  timeoutSec,
  cliCreditCap,
  parentDir = realpathSync(tmpdir()),
}) {
  const realWs = realpathSync(workspaceDir)
  const sidecarDir = realpathSync(mkdtempSync(path.join(parentDir, 'ep-copilot-home-')))
  const trialTmpDir = realpathSync(mkdtempSync(path.join(parentDir, 'ep-trial-tmp-')))
  activeTempDirs.add(sidecarDir)
  activeTempDirs.add(trialTmpDir)
  const usageFile = path.join(sidecarDir, 'usage.json')
  const env = buildAgentEnv(sidecarDir, trialTmpDir)

  // N-30: Write hardened OS sandbox policy before launching agent
  configureHardenedSandbox(sidecarDir, env)

  return new Promise((resolve) => {
    const start = Date.now()
    // N-00 (realWs), N-30 (--sandbox), I-02 (narrowed tools/paths), N-32 (omit --max-ai-credits unless explicitly set)
    const args = [
      '-p',
      prompt,
      '--model',
      model,
      '--reasoning-effort',
      reasoning,
      '--sandbox',
      '--disallow-temp-dir',
      '--add-dir',
      realWs,
      '--allow-tool',
      `write(${realWs}/src/**)`,
      '--allow-tool',
      'shell(npm test)',
      '--allow-tool',
      'shell(npm run)',
      '--deny-tool',
      'shell(npm install)',
      '--deny-tool',
      'shell(node)',
      '--deny-tool',
      'shell(npx)',
      '--excluded-tools',
      'web_fetch',
      'web_search',
      '--no-auto-update',
      '--dynamic-retrieval',
      'skills=off',
      '--no-custom-instructions',
      '--disable-builtin-mcps',
      '--no-ask-user',
      '--output-format',
      'json',
      '--usage-output-file',
      usageFile,
    ]
    // N-03 & N-32: Pass cap unconditionally when explicitly requested (> 0), omit by default to avoid live cost meter
    if (cliCreditCap > 0) {
      args.push('--max-ai-credits', String(cliCreditCap))
    }

    const child = spawn('copilot', args, {
      cwd: realWs,
      detached: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const handle = { pid: child.pid, usageFile }
    activeChildren.add(handle)

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

    const timer = setTimeout(() => {
      timedOut = true
      killProcessGroup(child.pid)
    }, timeoutSec * 1000)

    const finalize = (exitCode) => {
      clearTimeout(timer)
      activeChildren.delete(handle)
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
      rmSync(trialTmpDir, { recursive: true, force: true })
      activeTempDirs.delete(sidecarDir)
      activeTempDirs.delete(trialTmpDir)
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

/**
 * Mandatory live preflight (closes N-00 & N-30):
 * Runs one quick sandboxed CLI check before Trial 1 verifying:
 * 1) Writing `src/.preflight` succeeds (macOS realpath write rule works!)
 * 2) Writing `root-preflight.txt` outside `src/` is DENIED
 * 3) Running `npm test` works under `--sandbox` while reading outside workspace fails.
 */
async function runLivePreflight({ model, toolchains, parentDir }) {
  const { dir: ws } = createWorkspace({
    taskId: 'stale-cache',
    arm: 'control',
    promptStyle: 'symptom',
    toolchains,
    parentDir,
  })
  activeTempDirs.add(ws)
  try {
    const prompt = [
      'Preflight check. Perform exactly these 3 steps and then stop:',
      '1. Create the file `src/.preflight` with contents `ok`.',
      '2. Try to create `root-preflight.txt` at the workspace root with contents `blocked` (this should be denied).',
      '3. Run `npm test` once.',
    ].join('\n')
    const cli = await runCopilotTrial({
      workspaceDir: ws,
      model,
      reasoning: 'low',
      prompt,
      timeoutSec: 90,
      cliCreditCap: 0,
      parentDir,
    })
    const srcWritten = existsSync(path.join(ws, 'src/.preflight'))
    const rootBlocked = !existsSync(path.join(ws, 'root-preflight.txt'))
    if (!srcWritten || !rootBlocked) {
      throw new Error(
        `Live preflight FAILED (srcWritten=${srcWritten}, rootBlocked=${rootBlocked}, exitCode=${cli.exitCode}). Aborting run before spending credits on trials.`,
      )
    }
    return { ok: true, srcWritten, rootBlocked, usage: extractUsageMetrics(cli.usageRaw, model) }
  } finally {
    rmSync(ws, { recursive: true, force: true })
    activeTempDirs.delete(ws)
  }
}

/**
 * Parses Copilot CLI JSONL events:
 * - Keys denials (`deniedToolCalls`, `writeDenials`) on `tool.execution_complete`
 *   checking BOTH `error.code === 'denied'` and message text (closes N-04!).
 * - Keys `firstSourceEditAt` ONLY on `tool.execution_complete` with `success === true`
 *   (denied/failed edits NEVER count as source edits — closes N-04 & L-05!).
 */
export function parseCopilotEvents(stdout, targetRel) {
  const toolCalls = {}
  const filesRead = new Set()
  const shellCommands = []
  const suspiciousPaths = []
  let totalToolCalls = 0
  let compactions = 0
  let deniedToolCalls = 0
  let writeDenials = 0
  let firstSourceEditIndex = -1
  let firstFailingTestIndex = -1
  let firstSourceEditAt = null
  let firstFailingTestAt = null
  let eventIndex = 0
  const testCallIds = new Set()
  const pendingSourceEdits = new Map() // callId -> { isWriteTool, touchesTarget }
  const targetBase = path.basename(targetRel)

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
        const callId = ev.data?.toolCallId ?? ev.toolCallId
        toolCalls[name] = (toolCalls[name] ?? 0) + 1
        totalToolCalls++
        const argsObj = ev.data?.arguments ?? ev.arguments ?? {}
        const rawArgs = JSON.stringify(argsObj)

        if (name === 'view' && typeof argsObj?.path === 'string') {
          filesRead.add(path.basename(argsObj.path))
          if (argsObj.path.includes('..') || argsObj.path.includes('ep-grader')) {
            suspiciousPaths.push(argsObj.path)
          }
        }

        if (name === 'edit' || name === 'create') {
          const p = String(argsObj?.path ?? '')
          const touchesTarget = p.endsWith(targetBase) && !p.endsWith('.test.ts')
          if (callId) pendingSourceEdits.set(callId, { isWriteTool: true, touchesTarget })
        } else if (name === 'apply_patch') {
          const patchText = String(argsObj?.patch ?? argsObj?.input ?? rawArgs)
          const patchedFiles = [
            ...patchText.matchAll(/\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+([^\n\\"]+)/g),
          ].map((m) => m[1].trim())
          const touchesTarget = patchedFiles.some((f) => f.endsWith(targetBase) && !f.endsWith('.test.ts'))
          if (callId) pendingSourceEdits.set(callId, { isWriteTool: true, touchesTarget })
        }

        if (name === 'bash' || name === 'shell' || name === 'run_shell_command') {
          const cmd = String(argsObj?.command ?? rawArgs)
          shellCommands.push(cmd.slice(0, 200))
          for (const m of cmd.matchAll(
            /(?:cat|head|tail|sed|awk|less)\s+[^\n|;&]*?([\w./-]+\.(?:ts|mjs|js|md|json))/g,
          )) {
            filesRead.add(path.basename(m[1]))
          }
          if (/(?:^|\s)\.\.\/|\/tmp\/|ep-grader|ep-bench|execution-points/.test(cmd)) {
            suspiciousPaths.push(cmd.slice(0, 120))
          }
          if (/npm test|vitest/.test(cmd) && callId) {
            testCallIds.add(callId)
          }
        }
      } else if (type === 'tool.execution_complete') {
        const callId = ev.data?.toolCallId ?? ev.toolCallId
        const success = ev.data?.success ?? ev.success
        const errCode = ev.data?.error?.code ?? ''
        const errMsg = String(ev.data?.error?.message ?? '')
        const content = String(ev.data?.result?.content ?? ev.data?.content ?? '')
        const editMeta = callId ? pendingSourceEdits.get(callId) : undefined

        const isDenied =
          errCode === 'denied' ||
          /denied|permission denied/i.test(errMsg) ||
          /denied|permission denied/i.test(content)

        if (isDenied) {
          deniedToolCalls++
          if (editMeta?.isWriteTool) writeDenials++
        }

        // N-04: Only count source edits that actually SUCCEEDED!
        if (editMeta?.touchesTarget && success === true && firstSourceEditIndex === -1) {
          firstSourceEditIndex = eventIndex
          firstSourceEditAt = ts
        }

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
    writeDenials,
    filesRead: [...filesRead],
    shellCommandCount: shellCommands.length,
    suspiciousPaths: [...new Set(suspiciousPaths)],
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
  cliCreditCap,
  outDir,
  toolchains,
  keepWorkspaces,
  parentDir = realpathSync(tmpdir()),
}) {
  const task = TASKS[taskId]
  const { dir: workspaceDir, initialSnapshot } = createWorkspace({
    taskId,
    arm,
    promptStyle,
    toolchains,
    parentDir,
  })
  activeTempDirs.add(workspaceDir)
  const trialId = `${taskId}__${arm}__${model}__${reasoning}__t${trialIndex}`
  const trialLogDir = path.join(outDir, 'trials', trialId)
  mkdirSync(trialLogDir, { recursive: true })

  try {
    const prompt = buildAgentPrompt(task)
    const cli = await runCopilotTrial({
      workspaceDir,
      model,
      reasoning,
      prompt,
      timeoutSec,
      cliCreditCap,
      parentDir,
    })

    writeFileSync(path.join(trialLogDir, 'events.jsonl'), cli.stdout)
    if (cli.stderr) writeFileSync(path.join(trialLogDir, 'stderr.txt'), cli.stderr)
    if (cli.usageRaw) {
      writeFileSync(path.join(trialLogDir, 'usage.json'), JSON.stringify(cli.usageRaw, null, 2))
    }

    // Snapshot all workspace files immediately, then DELETE workspaceDir (closes R-03!)
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
      trialLogDir,
      cli,
      initialSnapshot,
      allWorkspaceFiles,
    }
  } finally {
    if (!keepWorkspaces) {
      rmSync(workspaceDir, { recursive: true, force: true })
      activeTempDirs.delete(workspaceDir)
    }
  }
}

/**
 * Grades a completed trial exclusively from its immutable `allWorkspaceFiles`
 * snapshot inside FRESH sandboxes (never runs tests inside the agent workspace —
 * closes R-19, R-01, E-01, E-04, E-05, E-06, A-01, R-11, R-12, R-18).
 */
export async function gradeTrialPhase({
  phase1,
  runId,
  provenance,
  copilotVersion,
  toolchains,
}) {
  const {
    trialId,
    taskId,
    arm,
    model,
    reasoning,
    trialIndex,
    promptStyle,
    trialLogDir,
    cli,
    initialSnapshot = {},
    allWorkspaceFiles,
  } = phase1
  const task = TASKS[taskId]
  const baselineFiles = readTaskBaselineFiles(taskId)
  let ownFixDir = null

  try {
    const usage = extractUsageMetrics(cli.usageRaw, model)
    const eventStats = parseCopilotEvents(cli.stdout, task.targetRel)
    const targetText = allWorkspaceFiles[task.targetRel] ?? ''
    const testText = allWorkspaceFiles[task.testRel] ?? ''

    // R-18: Real workspace diff against materialized baseline (detects config tampering & added root files)
    const addedRootFiles = Object.keys(allWorkspaceFiles).filter(
      (f) => !f.startsWith('src/') && !(f in initialSnapshot),
    )
    const modifiedConfigs = ['package.json', 'tsconfig.json', 'vitest.config.mjs', 'points.ep'].filter(
      (f) => f in initialSnapshot && allWorkspaceFiles[f] !== initialSnapshot[f],
    )
    const tamperedConfigs = addedRootFiles.length > 0 || modifiedConfigs.length > 0

    // 1. Hardened AST audits across ENTIRE `src/` tree (closes R-11, R-12, R-14, R-15, A-01, E-04, E-05)
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
          uncalledPrivates: [],
          unverifiedReexports: [],
          signatureChanges: [],
          globalHooks: [],
        }

    const prodViolations = []
    if (productionAudit.extraExports.length) prodViolations.push(`extraExports:${productionAudit.extraExports.join(',')}`)
    if (productionAudit.missingExports.length) prodViolations.push(`missingExports:${productionAudit.missingExports.join(',')}`)
    if (productionAudit.exportedPrivates.length) prodViolations.push(`exportedPrivates:${productionAudit.exportedPrivates.join(',')}`)
    if (productionAudit.missingPrivates.length) prodViolations.push(`missingPrivates:${productionAudit.missingPrivates.join(',')}`)
    if (productionAudit.syncStrippedHelpers.length) prodViolations.push(`syncStripped:${productionAudit.syncStrippedHelpers.join(',')}`)
    if (productionAudit.uncalledPrivates.length) prodViolations.push(`uncalledPrivates:${productionAudit.uncalledPrivates.join(',')}`)
    if (productionAudit.unverifiedReexports.length) prodViolations.push(`unverifiedReexports:${productionAudit.unverifiedReexports.join(',')}`)
    if (productionAudit.signatureChanges.length) prodViolations.push(`sigChanges:${JSON.stringify(productionAudit.signatureChanges)}`)
    if (productionAudit.globalHooks.length) prodViolations.push(`globalHooks:${productionAudit.globalHooks.join(',')}`)

    const auxViolations = []
    for (const [auxRel, auxSpec] of Object.entries(task.auxAsyncChecks)) {
      const auxText = allWorkspaceFiles[auxRel]
      if (!auxText) {
        auxViolations.push(`missing ${auxRel}`)
      } else {
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

    // Audit EVERY extra agent-created file under `src/` (R-11 + R-12)
    const testFilesToAudit = {}
    if (testText) testFilesToAudit[task.testRel] = testText
    for (const [rel, content] of Object.entries(allWorkspaceFiles)) {
      if (!rel.startsWith('src/') || rel === task.targetRel || rel === task.testRel) continue
      if (rel in task.auxAsyncChecks) continue
      if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(rel)) {
        // Audit as BOTH extra production file (no global hooks/test hooks) AND test support file (no global patches/sleeps)!
        const extraProd = auditExtraProductionFile(content, rel)
        if (!extraProd.clean) {
          auxViolations.push(`${rel}: ${JSON.stringify(extraProd)}`)
        }
        testFilesToAudit[rel] = content
      }
    }

    const cleanProduction = productionAudit.clean && auxViolations.length === 0
    const testAudit = Object.keys(testFilesToAudit).length
      ? auditTestTree(testFilesToAudit)
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

    // 2. Run own-fix tests & type checks in a BRAND-NEW pristine sandbox with `--config` + runtime guard (closes R-19!)
    ownFixDir = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), `ep-ownfix-${taskId}-`)))
    const ownCfg = writePristineWorkspaceConfigs(ownFixDir, task, arm, {
      includeRuntimeGuard: true,
    })
    toolchains.installForTrial(arm, ownFixDir)
    for (const [rel, content] of Object.entries(allWorkspaceFiles)) {
      if (!rel.startsWith('src/')) continue
      const out = path.join(ownFixDir, rel)
      mkdirSync(path.dirname(out), { recursive: true })
      writeFileSync(out, content)
    }

    const tscBin = path.join(ownFixDir, 'node_modules/.bin/tsc')
    // R-08: Own-fix run uses the same 5000 ms timeout agents develop under!
    const agentTestRun = testText
      ? await runVitestClassified(ownFixDir, task.testRel, {
          configPath: ownCfg,
          testTimeoutMs: 5000,
          allowedTimerProdRels: task.allowedTimerProdRels,
          requireGuardReport: true,
        })
      : {
          ok: false,
          outcome: 'loud_break',
          numPassed: 0,
          numFailed: 0,
          guardViolations: { globalPatches: [], realSleeps: [], guardMissing: false },
          summary: 'missing test file',
        }

    // Equal production-only type check across both arms (covers .ts, .tsx, .mts, .cts — N-23!)
    const prodTsconfig = path.join(ownFixDir, '.tsconfig.prod.json')
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
          allowJs: true,
          checkJs: true,
          types: ['node'],
        },
        include: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.mts', 'src/**/*.cts'],
        exclude: [task.testRel],
      }),
    )
    const prodTypecheckRes = await runCmd(tscBin, ['-p', prodTsconfig, '--noEmit'], ownFixDir, {
      timeoutMs: 60_000,
    })
    rmSync(prodTsconfig, { force: true })

    const fullTypecheckRes =
      arm === 'treatment'
        ? await runCmd(tscBin, ['--noEmit', '--runExternalCode'], ownFixDir, { timeoutMs: 60_000 })
        : await runCmd(tscBin, ['--noEmit'], ownFixDir, { timeoutMs: 60_000 })

    const typecheckPass = prodTypecheckRes.ok && (arm === 'control' ? fullTypecheckRes.ok : true)
    const contractTypecheckPass = arm === 'treatment' ? fullTypecheckRes.ok : true

    // 3. Evaluate agent's test suite: RED + single-bug mutants + refFixPass (E-06) + E9
    const testEval = testText
      ? await evaluateAgentTests({ taskId, arm, agentSrcFiles: allWorkspaceFiles, toolchains })
      : {
          redReproducesBug: false,
          redOutcome: 'loud_break',
          redSummary: 'missing test file',
          refFixPass: false,
          refFixOutcome: 'loud_break',
          runtimeGlobalPatches: [],
          runtimeRealSleeps: [],
          singleBugMutants: { total: 0, detectedCount: 0, allDetected: false, results: [] },
          refactorRobustness: {
            total: 0,
            trueRedCount: 0,
            loudBreakCount: 0,
            falseGreenCount: 0,
            results: [],
          },
          validFixRobustness: {
            total: 0,
            trueGreenCount: 0,
            falseRedAssertionCount: 0,
            timeoutCount: 0,
            selectorOrCompileBreakCount: 0,
            results: [],
          },
        }

    // Combine AST + runtime guard violations (closes E-01, E-05, A-01, N-22, N-23!)
    const allGlobalPatches = [
      ...new Set([
        ...testAudit.globalPatches,
        ...(agentTestRun.guardViolations?.globalPatches ?? []),
        ...(testEval.runtimeGlobalPatches ?? []),
      ]),
    ]
    const allRealSleeps = [
      ...new Set([
        ...testAudit.realSleeps,
        ...(agentTestRun.guardViolations?.realSleeps ?? []),
        ...(testEval.runtimeRealSleeps ?? []),
      ]),
    ]
    const noGlobalMonkeyPatch = allGlobalPatches.length === 0
    const noRealSleeps = allRealSleeps.length === 0

    // Two-sided adequacy (closes E-06 & L-11!)
    const adequateReproduction =
      testEval.redReproducesBug &&
      testEval.singleBugMutants.allDetected &&
      testEval.refFixPass &&
      agentTestRun.ok

    // 4. Hidden yield-engine oracle grader + pristine visible tests over entire non-test `src/`
    const prodSrcMap = {}
    for (const [rel, content] of Object.entries(allWorkspaceFiles)) {
      if (rel.startsWith('src/') && rel !== task.testRel) prodSrcMap[rel] = content
    }
    const grader = await runHiddenOracleGrader({
      taskId,
      srcFilesOrDir: prodSrcMap,
      toolchains,
      runVisibleToo: true,
    })

    // N-05: Detect infrastructure failures (non-zero CLI exit without timeout, missing usage on live run, or write denials blocking all edits)
    const anySrcChanged = Object.entries(allWorkspaceFiles).some(
      ([rel, content]) => rel.startsWith('src/') && initialSnapshot[rel] !== content,
    )
    const isLiveRun = model !== 'self-test'
    const infraFailure =
      isLiveRun &&
      ((cli.exitCode !== 0 && !cli.timedOut) ||
        Boolean(cli.spawnError) ||
        Boolean(usage.usageMissing) ||
        (eventStats.writeDenials > 0 && !anySrcChanged))

    const solved =
      !infraFailure &&
      grader.oraclePass &&
      grader.visibleTestsPass &&
      agentTestRun.ok &&
      adequateReproduction &&
      typecheckPass &&
      contractTypecheckPass &&
      cleanProduction &&
      noGlobalMonkeyPatch &&
      noRealSleeps

    const technique = allGlobalPatches.length > 0 ? 'global-patch' : testAudit.technique

    const record = {
      runId,
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
      gitCommit: provenance.gitCommit,
      gitDirty: provenance.gitDirty,
      vitestVersion: provenance.vitestVersion,
      typescriptVersion: provenance.typescriptVersion,
      harnessSha256: provenance.harnessSha256,
      calibrationSha256: provenance.calibrationSha256,
      lockfileSha256: provenance.lockfileSha256,
      toolSha256: provenance.toolSha256,
      tasksSha256: provenance.tasksSha256,
      graderChecksum: toolchains.graderChecksum,
      infraFailure,
      ungradable: infraFailure || Boolean(agentTestRun.guardViolations?.guardMissing),
      aborted: false,
      notStarted: false,
      solved,
      oraclePass: grader.oraclePass,
      oracleUnhandledErrors: grader.unhandledErrors,
      oracleTests: grader.oracleTests,
      visibleTestsPass: grader.visibleTestsPass,
      agentTestsPass: agentTestRun.ok,
      redReproducesBug: testEval.redReproducesBug,
      redOutcome: testEval.redOutcome,
      refFixPass: testEval.refFixPass,
      refFixOutcome: testEval.refFixOutcome,
      adequateReproduction,
      singleBugMutants: testEval.singleBugMutants,
      typecheckPass,
      writeDenials: eventStats.writeDenials,
      contractTypecheckPass,
      cleanProduction,
      productionViolations: [...prodViolations, ...auxViolations],
      noGlobalMonkeyPatch,
      globalMonkeyPatchViolations: allGlobalPatches,
      noRealSleeps,
      realSleepViolations: allRealSleeps,
      tamperedConfigs,
      addedRootFiles,
      modifiedConfigs,
      technique,
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
      suspiciousPaths: eventStats.suspiciousPaths,
      totalToolCalls: eventStats.totalToolCalls,
      toolCalls: eventStats.toolCalls,
      workspaceFileList: Object.keys(allWorkspaceFiles).sort(),
      durationMs: cli.durationMs,
      exitCode: cli.exitCode,
      timedOut: cli.timedOut,
      spawnError: cli.spawnError,
      usage,
      graderOutput: grader.oraclePass ? undefined : grader.output,
      typecheckError: typecheckPass
        ? undefined
        : (
            prodTypecheckRes.stdout +
            prodTypecheckRes.stderr +
            fullTypecheckRes.stdout +
            fullTypecheckRes.stderr
          ).slice(0, 600),
      contractTypecheckError: contractTypecheckPass
        ? undefined
        : (fullTypecheckRes.stdout + fullTypecheckRes.stderr).slice(0, 600),
    }

    if (trialLogDir) {
      writeFileSync(path.join(trialLogDir, 'result.json'), JSON.stringify(record, null, 2))
    }
    return record
  } catch (err) {
    const errorRecord = {
      runId,
      trialId,
      taskId,
      stratum: task.stratum,
      arm,
      promptStyle,
      model,
      actualModel: null,
      reasoning,
      trialIndex,
      copilotVersion,
      gitCommit: provenance?.gitCommit,
      gitDirty: provenance?.gitDirty,
      harnessSha256: provenance?.harnessSha256,
      toolSha256: provenance?.toolSha256,
      tasksSha256: provenance?.tasksSha256,
      ungradable: true,
      aborted: false,
      solved: false,
      oraclePass: false,
      visibleTestsPass: false,
      agentTestsPass: false,
      redReproducesBug: false,
      refFixPass: false,
      adequateReproduction: false,
      typecheckPass: false,
      contractTypecheckPass: false,
      cleanProduction: false,
      noGlobalMonkeyPatch: false,
      noRealSleeps: false,
      technique: 'error',
      durationMs: cli?.durationMs ?? 0,
      usage: extractUsageMetrics(cli?.usageRaw ?? null, model),
      harnessError: err instanceof Error ? err.stack || err.message : String(err),
    }
    if (trialLogDir) {
      writeFileSync(path.join(trialLogDir, 'result.json'), JSON.stringify(errorRecord, null, 2))
    }
    return errorRecord
  } finally {
    if (ownFixDir) rmSync(ownFixDir, { recursive: true, force: true })
  }
}

async function runSelfTest() {
  console.log('Running v2.2 hardened benchmark self-test...\n')
  const provenance = computeProvenance()
  const toolchains = prepareToolchains(REPO_ROOT)
  let failures = 0

  try {
    // 1. Toolchain isolation (symlinks + `.bin` shims) & full grader checksum (I-03, R-02)
    console.log('1) Toolchain isolation (symlinks + .bin shims) & full grader checksum...')
    assertNoRepoLeak(toolchains.controlNm, REPO_ROOT)
    assertNoRepoLeak(toolchains.treatmentNm, REPO_ROOT)
    assertNoRepoLeak(toolchains.graderNm, REPO_ROOT)
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
    console.log(`   PASS: zero symlink/shim leaks (grader sha256=${toolchains.graderChecksum.slice(0, 12)}).\n`)

    // 2. Hardened AST auditor calibration (including A-01 evasions!)
    console.log('2) Hardened AST auditor calibration (including A-01 evasions)...')
    const astCases = [
      { name: 'direct vi.spyOn(Promise)', code: `import { vi } from 'vitest'; vi.spyOn(Promise, 'resolve')`, check: (r) => r.usesGlobalPatch },
      { name: 'A-01 alias host=globalThis', code: `const host = globalThis as any; host.MessageChannel = class {}`, check: (r) => r.usesGlobalPatch },
      { name: 'A-01 alias P=Promise', code: `import { vi } from 'vitest'; const P = Promise; vi.spyOn(P, 'resolve')`, check: (r) => r.usesGlobalPatch },
      { name: 'A-01 bracket vi["spyOn"]', code: `import { vi } from 'vitest'; vi['spyOn'](Promise, 'resolve')`, check: (r) => r.usesGlobalPatch },
      { name: 'A-01 destructured spyOn', code: `import { vi } from 'vitest'; const { spyOn } = vi; spyOn(Promise, 'resolve')`, check: (r) => r.usesGlobalPatch },
      { name: 'A-01 aliased import { vi as v }', code: `import { vi as v } from 'vitest'; v.spyOn(Promise, 'resolve')`, check: (r) => r.usesGlobalPatch },
      { name: 'A-01 Reflect.defineProperty', code: `Reflect.defineProperty(Promise, 'resolve', { value: () => {} })`, check: (r) => r.usesGlobalPatch },
      { name: 'A-01 compound &&= assignment', code: `Promise.resolve &&= (() => ({})) as any`, check: (r) => r.usesGlobalPatch },
      { name: 'A-01 EventTarget.prototype', code: `EventTarget.prototype.addEventListener = (() => {}) as any`, check: (r) => r.usesGlobalPatch },
      { name: 'A-01 eval / new Function', code: `new Function('return 1')()`, check: (r) => r.usesGlobalPatch },
      { name: 'A-01 globalThis.setTimeout', code: `await new Promise((r) => globalThis.setTimeout(r, 50))`, check: (r) => r.usesRealSleep },
      { name: 'A-01 Atomics.wait', code: `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)`, check: (r) => r.usesRealSleep },
      { name: 'A-01 vi.waitUntil', code: `import { vi } from 'vitest'; await vi.waitUntil(() => true)`, check: (r) => r.usesRealSleep },
      { name: 'A-01 timers/promises namespace', code: `import * as tp from 'node:timers/promises'; await tp.setTimeout(10)`, check: (r) => r.usesRealSleep },
      { name: 'A-01 dead-code useFakeTimers', code: `import { vi } from 'vitest'; if (false) vi.useFakeTimers(); setTimeout(() => {}, 10)`, check: (r) => r.usesRealSleep },
      { name: 'A-01 S10 non-literal conditional useFakeTimers', code: `import { vi } from 'vitest'; if (Math.random() > 2) vi.useFakeTimers(); setTimeout(() => {}, 10)`, check: (r) => r.usesRealSleep },
      { name: 'A-01 useFakeTimers then useRealTimers', code: `import { vi } from 'vitest'; vi.useFakeTimers(); vi.useRealTimers(); setTimeout(() => {}, 10)`, check: (r) => r.usesRealSleep },
      { name: 'N-25 legal beforeEach(useFakeTimers) + afterEach(useRealTimers)', code: `import { afterEach, beforeEach, test, vi } from 'vitest'; beforeEach(() => { vi.useFakeTimers() }); afterEach(() => { vi.useRealTimers() }); test('ok', () => { setTimeout(() => {}, 10) })`, check: (r) => !r.usesRealSleep && r.usesFakeTimers },
      { name: 'N-22 Object.getPrototypeOf(MessagePort.prototype) spy', code: `import { vi } from 'vitest'; const b = Object.getPrototypeOf(MessagePort.prototype); vi.spyOn(b, 'addEventListener')`, check: (r) => r.usesGlobalPatch },
      { name: 'N-22 Object.setPrototypeOf(MessagePort.prototype)', code: `Object.setPrototypeOf(MessagePort.prototype, {})`, check: (r) => r.usesGlobalPatch },
      { name: 'N-24 setTimeout.call', code: `await new Promise((r) => setTimeout.call(undefined, r, 40))`, check: (r) => r.usesRealSleep },
      { name: 'N-24 comma (0, setTimeout)', code: `await new Promise((r) => (0, setTimeout)(r, 40))`, check: (r) => r.usesRealSleep },
      { name: 'N-24 expect.poll', code: `import { expect } from 'vitest'; await expect.poll(() => true).toBe(true)`, check: (r) => r.usesRealSleep },
      { name: 'N-12 vi.spyOn(namespaceImport) -> module-mock', code: `import { vi } from 'vitest'; import * as storage from './storage'; vi.spyOn(storage, 'readFromDb')`, check: (r) => r.usesModuleMock && r.technique === 'module-mock' && !r.usesGlobalPatch },
      { name: 'A-01 import type EP not execution-points', code: `import type { ExecutionPoint } from 'execution-points-prototype'; export type X = ExecutionPoint<any, any>`, check: (r) => !r.usesExecutionPoints && r.technique === 'none' },
      { name: 'allows setTimeout with active useFakeTimers', code: `import { vi } from 'vitest'; vi.useFakeTimers(); setTimeout(() => {}, 10); vi.advanceTimersByTimeAsync(10)`, check: (r) => !r.usesRealSleep && r.usesFakeTimers },
      { name: 'ignores setTimeout in comment', code: `// no setTimeout\nimport { expect, test } from 'vitest'\ntest('ok', () => expect(1).toBe(1))`, check: (r) => !r.usesRealSleep && !r.usesGlobalPatch },
      { name: 'classifies real select()+withReplacement()', code: `import { select } from 'execution-points-prototype'\nconst p = select('src/a.ts', n => n)\np.withReplacement(() => 1, () => 2)`, check: (r) => r.usesExecutionPoints && r.technique === 'execution-points' },
    ]
    for (const c of astCases) {
      const res = auditTestAst(c.code)
      if (!c.check(res)) {
        console.error(`   FAIL: ${c.name} ->`, res)
        failures++
      }
    }
    // Production AST evasions (R-14, R-15, E-04)
    const prodEvasions = [
      { name: 'export namespace', code: `export namespace Leak { export const x = 1 }` },
      { name: 'export enum', code: `export enum Leak { A }` },
      { name: 'export const destructuring', code: `export const { a } = { a: 1 }` },
      { name: 'globalThis hook in prod', code: `(globalThis as any).__hook = 1` },
      { name: 'dead-branch await', code: `async function h() { if (false) await Promise.resolve() } h()`, helpers: ['h'] },
      { name: 'uncalled closure await', code: `async function h() { const f = async () => { await Promise.resolve() }; void f } h()`, helpers: ['h'] },
      { name: 'uncalled private helper (E-04)', code: `async function h() { await Promise.resolve() }`, helpers: ['h'] },
    ]
    for (const p of prodEvasions) {
      const r = auditProductionAst(p.code, {
        targetRel: 'src/x.ts',
        expectedExports: [],
        expectedParamCounts: {},
        privateHelpers: p.helpers ?? [],
        requiredAsyncHelpers: p.helpers ?? [],
      })
      if (r.clean) {
        console.error(`   FAIL: production evasion not caught: ${p.name}`, r)
        failures++
      }
    }
    console.log(`   PASS: ${astCases.length} test-audit + ${prodEvasions.length} prod-audit cases verified.\n`)

    // 3. Treatment virtual contract check
    console.log('3) Treatment virtual contract check (select() + tsc --noEmit --runExternalCode)...')
    {
      const { dir: ws } = createWorkspace({
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
        const vitestRes = await runVitestClassified(ws, 'src/profile-store.test.ts', {
          configPath: path.join(ws, 'vitest.config.mjs'),
        })
        if (!tscRes.ok || !vitestRes.ok) {
          console.error('   FAIL:', tscRes.stdout, tscRes.stderr, vitestRes)
          failures++
        } else {
          console.log('   PASS: Treatment select() passes tsc --noEmit --runExternalCode + vitest.\n')
        }
      } finally {
        rmSync(ws, { recursive: true, force: true })
      }
    }

    // 4. Timeout != true_red check
    console.log('4) Timeout classification check (timeout must NOT count as true_red)...')
    {
      const { dir: ws } = createWorkspace({
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
        const res = await runVitestClassified(ws, 'src/profile-store.test.ts', {
          configPath: path.join(ws, 'vitest.config.mjs'),
        })
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

    // 5. All 6 constructed adversarial cheats MUST be rejected (solved === false)!
    console.log('5) Adversarial must-reject cheat suite (E-01, E-04, E-05, E-06, R-19, R-01)...')
    const buggyStale = readFileSync(
      path.join(__dirname, 'tasks/stale-cache/src/profile-store.ts'),
      'utf8',
    )
    const cheats = buildMustRejectCheats(buggyStale)
    for (const ch of cheats) {
      const baseline = readTaskBaselineFiles(ch.taskId)
      const graded = await gradeTrialPhase({
        phase1: {
          trialId: ch.id,
          taskId: ch.taskId,
          arm: ch.arm,
          model: 'self-test',
          reasoning: 'medium',
          trialIndex: 0,
          promptStyle: 'symptom',
          trialLogDir: null,
          cli: { stdout: '', stderr: '', exitCode: 0, timedOut: false, spawnError: null, durationMs: 0, usageRaw: null },
          initialSnapshot: {},
          allWorkspaceFiles: { ...baseline, ...ch.files },
        },
        runId: 'self-test',
        provenance,
        copilotVersion: 'self-test',
        toolchains,
      })
      const rejected = graded.solved === false
      console.log(
        `   ${rejected ? 'PASS' : 'FAIL'} ${ch.id.padEnd(26)} solved=${graded.solved} (oracle=${graded.oraclePass}, own=${graded.agentTestsPass}, adq=${graded.adequateReproduction}, ref=${graded.refFixPass}, prod=${graded.cleanProduction}, noMP=${graded.noGlobalMonkeyPatch})`,
      )
      if (!rejected) failures++
    }
    console.log()

    // 6. Known-good legal witnesses MUST pass (R-09 adequacy calibration!)
    console.log('6) Adequacy calibration: known-good legal witnesses (must achieve solved=true)...')
    for (const w of GOOD_WITNESSES) {
      const baseline = readTaskBaselineFiles(w.taskId)
      const graded = await gradeTrialPhase({
        phase1: {
          trialId: w.id,
          taskId: w.taskId,
          arm: w.arm,
          model: 'self-test',
          reasoning: 'medium',
          trialIndex: 0,
          promptStyle: 'symptom',
          trialLogDir: null,
          cli: { stdout: '', stderr: '', exitCode: 0, timedOut: false, spawnError: null, durationMs: 0, usageRaw: null },
          initialSnapshot: {},
          allWorkspaceFiles: { ...baseline, ...w.files },
        },
        runId: 'self-test',
        provenance,
        copilotVersion: 'self-test',
        toolchains,
      })
      const ok = graded.solved === true && graded.adequateReproduction === true
      console.log(
        `   ${ok ? 'PASS' : 'FAIL'} ${w.id.padEnd(36)} solved=${graded.solved} adq=${graded.adequateReproduction} ref=${graded.refFixPass} vf=${graded.validFixRobustness.trueGreenCount}/${graded.validFixRobustness.total}`,
      )
      if (!ok) {
        failures++
        console.error('     details:', {
          oraclePass: graded.oraclePass,
          visibleTestsPass: graded.visibleTestsPass,
          agentTestsPass: graded.agentTestsPass,
          redOutcome: graded.redOutcome,
          mutants: graded.singleBugMutants,
          refFixOutcome: graded.refFixOutcome,
          typecheckError: graded.typecheckError,
          contractTypecheckError: graded.contractTypecheckError,
          productionViolations: graded.productionViolations,
          globalPatches: graded.globalMonkeyPatchViolations,
          realSleeps: graded.realSleepViolations,
        })
      }
    }
    console.log()

    // 7. Baseline workspace checks across all 10 tasks (control + treatment)
    console.log(`7) Baseline workspace checks across all ${Object.keys(TASKS).length} tasks (control + treatment)...`)
    for (const taskId of Object.keys(TASKS)) {
      const task = TASKS[taskId]
      for (const arm of ['control', 'treatment']) {
        const { dir: ws } = createWorkspace({ taskId, arm, promptStyle: 'symptom', toolchains })
        try {
          const vitestRes = await runVitestClassified(ws, task.testRel, {
            configPath: path.join(ws, 'vitest.config.mjs'),
          })
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

    // 8. Full calibration corpus across all 10 tasks
    console.log(`8) Grader calibration corpus (${CALIBRATION_VARIANTS.length} variants across 10 tasks)...`)
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
      console.log(
        `   ${matched ? 'PASS' : 'FAIL'} ${v.id.padEnd(5)} (${v.task.padEnd(21)}) expect=${String(v.expectPass).padEnd(5)} got=${String(actualPass).padEnd(5)} | ${v.label}`,
      )
      if (!matched) {
        failures++
        console.error('     oracle:', res.oraclePass, 'visible:', res.visibleTestsPass)
        console.error('     output:', res.output.slice(0, 500))
      }
    }
    console.log()

    // 9. N-18: Hidden oracle MUST reject EVERY SINGLE_BUG_MUTANT across all 10 tasks (including CC-M1!)
    console.log('9) Hidden oracle rejection check across ALL single-bug mutants (N-18)...')
    for (const [taskId, mutants] of Object.entries(SINGLE_BUG_MUTANTS)) {
      for (const m of mutants) {
        const res = await runHiddenOracleGrader({
          taskId,
          srcFilesOrDir: m.files,
          toolchains,
          runVisibleToo: true,
        })
        const rejected = !(res.oraclePass && res.visibleTestsPass)
        console.log(
          `   ${rejected ? 'PASS' : 'FAIL'} ${m.id.padEnd(28)} (${taskId.padEnd(21)}) oracleRejected=${rejected}`,
        )
        if (!rejected) {
          failures++
          console.error('     BUG: hidden oracle accepted single-bug mutant!', m.id)
        }
      }
    }
    console.log()

    // 10. Production AST audit on all 10 reference fixes
    console.log(`10) Production AST audit on all ${Object.keys(REFERENCE_FIXES).length} reference fixes...`)
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
    `Self-test PASSED (isolation, AST+runtime guards, ${cheats.length} cheats rejected, ${GOOD_WITNESSES.length} legal witnesses passed, 10 tasks, ${CALIBRATION_VARIANTS.length} calibration variants, and all single-bug mutants rejected by oracle).`,
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
      ungradable: 0,
      aborted: 0,
      monkeyPatched: 0,
      usedExecutionPoints: 0,
      refactorTotal: 0,
      refactorFalseGreens: 0,
      validAltTotal: 0,
      validAltPass: 0,
      validAltFalseRedAssert: 0,
      validAltTimeout: 0,
      validAltSelectorCompile: 0,
      totalTokens: 0,
      totalAiCredits: 0,
      totalUsd: 0,
      usdKnownTrials: 0,
      totalDurationMs: 0,
      techniques: {},
    })
    g.trials++
    if (r.solved) g.solved++
    if (r.oraclePass) g.oraclePass++
    if (r.redReproducesBug) g.redPass++
    if (r.adequateReproduction) g.adequateRed++
    if (r.ungradable || r.harnessError) g.ungradable++
    if (r.aborted) g.aborted++
    if (!r.noGlobalMonkeyPatch) g.monkeyPatched++
    if (r.usesExecutionPoints) g.usedExecutionPoints++
    if (r.adequateReproduction && r.refactorRobustness) {
      g.refactorTotal += r.refactorRobustness.total ?? 0
      g.refactorFalseGreens += r.refactorRobustness.falseGreenCount ?? 0
    }
    if (r.adequateReproduction && r.validFixRobustness) {
      g.validAltTotal += r.validFixRobustness.total ?? 0
      g.validAltPass += r.validFixRobustness.trueGreenCount ?? 0
      g.validAltFalseRedAssert += r.validFixRobustness.falseRedAssertionCount ?? 0
      g.validAltTimeout += r.validFixRobustness.timeoutCount ?? 0
      g.validAltSelectorCompile += r.validFixRobustness.selectorOrCompileBreakCount ?? 0
    }
    const u = r.usage ?? {}
    if (!u.usageMissing) {
      g.totalTokens += u.totalTokens ?? 0
      g.totalAiCredits += u.aiCredits ?? 0
      if (typeof u.estimatedUsd === 'number') {
        g.totalUsd += u.estimatedUsd
        g.usdKnownTrials++
      }
    }
    g.totalDurationMs += r.durationMs ?? 0
    g.techniques[r.technique ?? 'unknown'] = (g.techniques[r.technique ?? 'unknown'] ?? 0) + 1
  }

  for (const g of Object.values(groups)) {
    g.solvedCI = wilsonCI(g.solved, g.trials)
    g.oracleCI = wilsonCI(g.oraclePass, g.trials)
    g.adequateRedCI = wilsonCI(g.adequateRed, g.trials)
    g.falseGreenCI = wilsonCI(g.refactorFalseGreens, g.refactorTotal)
    g.validFixPassCI = wilsonCI(g.validAltPass, g.validAltTotal)
    g.validFixFalseRedCI = wilsonCI(
      g.validAltFalseRedAssert + g.validAltTimeout,
      g.validAltTotal,
    )
    g.avgDurationSec = g.trials ? g.totalDurationMs / g.trials / 1000 : 0
    g.tokensPerSolved = g.solved > 0 && g.usdKnownTrials > 0 ? Math.round(g.totalTokens / g.solved) : null
    g.usdPerSolved = g.solved > 0 && g.usdKnownTrials > 0 ? g.totalUsd / g.solved : null
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
    'VFPass',
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
    const vf = r.validFixRobustness
      ? `${r.validFixRobustness.trueGreenCount}/${r.validFixRobustness.total}`
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
      vf.padEnd(6),
      String(r.technique ?? '').slice(0, 16).padEnd(16),
      String(r.usage?.usageMissing ? 'missing' : r.usage?.totalTokens ?? 0).padStart(8),
      formatUsd(r.usage?.estimatedUsd).padStart(8),
      (r.durationMs / 1000).toFixed(0).padStart(4),
    ].join(' | ')
    console.log(row)
  }

  console.log('\n=== Per-Arm Aggregates (approximate 95% Wilson CIs — descriptive) ===')
  for (const [arm, g] of Object.entries(byArm)) {
    console.log(
      [
        `${arm.toUpperCase()}: solved=${g.solved}/${g.trials} ${formatCI(g.solvedCI)}`,
        `adqRED=${formatCI(g.adequateRedCI)}`,
        `VFPass=${g.validAltPass}/${g.validAltTotal} (assert=${g.validAltFalseRedAssert},to=${g.validAltTimeout},sel=${g.validAltSelectorCompile})`,
        `FG=${formatCI(g.falseGreenCI)}`,
        `credits=${g.totalAiCredits.toFixed(1)} (${g.solved > 0 ? (g.totalAiCredits / g.solved).toFixed(1) : 'n/a'}/solved) | listUsd=${formatUsd(g.totalUsd)}`,
        `tech=${JSON.stringify(g.techniques)}`,
      ].join(' | '),
    )
  }
  // N-08: Primary analysis is over equal-capability Strata B + C ONLY; Stratum A reported separately!
  const equalSeamRows = results.filter((r) => r.stratum !== 'closed-module' && !r.notStarted)
  const closedModRows = results.filter((r) => r.stratum === 'closed-module' && !r.notStarted)
  const cmh = stratifiedCMH(equalSeamRows, (r) => Boolean(r.solved))
  const rd = matchedRiskDifferenceCI(equalSeamRows, (r) => Boolean(r.solved))
  console.log(
    `\nPrimary Stratified CMH (Strata B+C equal-capability): strata=${cmh.strataCount}, z=${cmh.z}, p=${cmh.pValue}, exactMcNemarP=${cmh.exactMcNemarP ?? 'n/a'}, commonOR=${cmh.commonOddsRatio ?? 'n/a'}`,
  )
  if (rd.diff !== null) {
    console.log(
      `Newcombe paired RD (Strata B+C, blocks=${rd.blocks}): ${(rd.diff * 100).toFixed(1)}pp [${(rd.low * 100).toFixed(1)}pp, ${(rd.high * 100).toFixed(1)}pp]`,
    )
  }
  if (closedModRows.length > 0) {
    const cmhA = stratifiedCMH(closedModRows, (r) => Boolean(r.solved))
    console.log(
      `Stratum A (closed-module capability stratum, separate): strata=${cmhA.strataCount}, p=${cmhA.pValue}, exactMcNemarP=${cmhA.exactMcNemarP ?? 'n/a'}`,
    )
  }
  console.log(`Artifacts & JSONL saved to: ${outDir}`)
  console.log(`Run \`node bench/analyze.mjs ${path.join(outDir, 'results.jsonl')}\` for full stratified report.`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.selfTest) {
    await runSelfTest()
    return
  }

  const tasks = opts.tasks ?? Object.keys(TASKS)
  const models = opts.models ?? ['gemini-4-neon:medium', 'gpt-6.2-astra:medium', 'claude-opus-5.5:medium']

  for (const t of tasks) {
    if (!TASKS[t]) throw new Error(`Unknown task: ${t} (valid: ${Object.keys(TASKS).join(', ')})`)
  }

  // Group jobs into matched blocks (N-26: budget checked at block boundaries so arms stay paired!)
  const rand = mulberry32(opts.seed)
  const blocks = []
  for (let t = 1; t <= opts.trials; t++) {
    for (const taskId of tasks) {
      for (const spec of models) {
        const [model, reasoning = 'medium'] = spec.split(':')
        const blockArms = [...opts.arms]
        if (blockArms.length === 2 && rand() < 0.5) blockArms.reverse()
        blocks.push(blockArms.map((arm) => ({ taskId, arm, model, reasoning, trialIndex: t })))
      }
    }
  }
  const jobs = blocks.flat()

  // OPS-01: Dry-run plan by default; require explicit `--run` plus `--tasks` and `--models`
  if (!opts.run || !opts.tasks || !opts.models) {
    console.log('=== Dry-Run Execution Plan (no trials started; pass --run --tasks <...> --models <...> to execute) ===')
    console.log(`Tasks (${tasks.length}):      ${tasks.join(', ')}`)
    console.log(`Arms (${opts.arms.length}):       ${opts.arms.join(', ')}`)
    console.log(`Models (${models.length}):     ${models.join(', ')}`)
    console.log(`Trials/cell:    ${opts.trials} -> Total trials: ${jobs.length} (${blocks.length} matched blocks)`)
    console.log(`Prompt style:   ${opts.promptStyle} | phaseSplit=${opts.phaseSplit} | concurrency=${opts.concurrency}`)
    console.log(
      `Budget control: --max-total-credits=${opts.maxTotalCredits} (checked per block) | --cli-credit-cap=${opts.cliCreditCap || 'off (no live cost meter)'}`,
    )
    return
  }

  // N-01: Only sweep stale temp dirs when explicitly requested (--sweep-stale)
  if (opts.sweepStale) {
    const swept = sweepStaleTempDirs()
    if (swept > 0) console.log(`Startup sweep removed ${swept} stale ep-* temp dir(s).`)
  }

  const runId = randomUUID()
  const provenance = computeProvenance()
  const copilotVersion = getCopilotVersion()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // N-30: Write results OUTSIDE REPO_ROOT by default so sandboxed tests can never read prior solutions
  const outDir = opts.outDir ?? path.join(homedir(), '.ep-bench-results', `v2-${stamp}`)
  mkdirSync(outDir, { recursive: true })
  const jsonlPath = path.join(outDir, 'results.jsonl')

  if (existsSync(jsonlPath) && statSync(jsonlPath).size > 0) {
    throw new Error(`Refusing to append to existing non-empty ${jsonlPath}. Use a fresh --out directory.`)
  }

  // N-01: Run-scoped temp root so cleanup/signals never clobber concurrent runs
  const runTmpRoot = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), 'ep-run-')))
  activeTempDirs.add(runTmpRoot)

  console.log(
    `Starting v2.2 benchmark runId=${runId}: ${jobs.length} trials (${blocks.length} blocks, prompt=${opts.promptStyle}, phaseSplit=${opts.phaseSplit}, concurrency=${opts.concurrency}, maxTotalCredits=${opts.maxTotalCredits}, seed=${opts.seed})`,
  )
  console.log(
    `Provenance: git=${provenance.gitCommit}${provenance.gitDirty ? '-dirty' : ''} harness=${provenance.harnessSha256} cal=${provenance.calibrationSha256} tool=${provenance.toolSha256} cli="${copilotVersion}"`,
  )
  console.log(`Output directory: ${outDir}`)

  const toolchains = prepareToolchains(REPO_ROOT, runTmpRoot)
  const results = []
  const startedTrials = new Map()
  const writtenTrialIds = new Set()
  let cumulativeCredits = 0
  let consecutiveInfra = 0
  let shuttingDown = false

  // OPS-02 & N-09: Kill active agents, capture any usage.json before cleanup, write `aborted` rows with null noGlobalMonkeyPatch!
  const handleSignal = (sig) => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`\nReceived ${sig}: terminating ${activeChildren.size} active agent(s) and recording aborted ITT rows...`)
    const usageByPid = new Map()
    for (const ch of activeChildren) {
      killProcessGroup(ch.pid)
      if (ch.usageFile && existsSync(ch.usageFile)) {
        try {
          usageByPid.set(ch.pid, JSON.parse(readFileSync(ch.usageFile, 'utf8')))
        } catch {
          // ignore
        }
      }
    }
    for (const [tid, job] of startedTrials.entries()) {
      if (writtenTrialIds.has(tid)) continue
      writtenTrialIds.add(tid)
      appendFileSync(
        jsonlPath,
        JSON.stringify({
          runId,
          trialId: tid,
          taskId: job.taskId,
          stratum: TASKS[job.taskId].stratum,
          arm: job.arm,
          promptStyle: opts.promptStyle,
          model: job.model,
          actualModel: null,
          reasoning: job.reasoning,
          trialIndex: job.trialIndex,
          copilotVersion,
          ...provenance,
          infraFailure: false,
          ungradable: false,
          aborted: true,
          notStarted: false,
          abortSignal: sig,
          solved: false,
          oraclePass: false,
          adequateReproduction: false,
          noGlobalMonkeyPatch: null,
          technique: 'aborted',
          durationMs: 0,
          usage: extractUsageMetrics(null, job.model),
        }) + '\n',
      )
    }
    rmSync(runTmpRoot, { recursive: true, force: true })
    toolchains.cleanup()
    closeAuditApi()
    process.exit(130)
  }
  process.on('SIGINT', () => handleSignal('SIGINT'))
  process.on('SIGTERM', () => handleSignal('SIGTERM'))

  try {
    // N-00 + N-30: Mandatory live sandbox + write preflight before Trial 1
    if (!opts.skipPreflight) {
      const preflightModel = models[0].split(':')[0]
      console.log(`Running mandatory live sandbox + write preflight (${preflightModel}:low)...`)
      const pf = await runLivePreflight({ model: preflightModel, toolchains, parentDir: runTmpRoot })
      if (typeof pf.usage?.aiCredits === 'number') cumulativeCredits += pf.usage.aiCredits
      console.log(`Preflight PASSED (srcWritten=${pf.srcWritten}, rootBlocked=${pf.rootBlocked}, credits=${pf.usage?.aiCredits ?? 'n/a'}).`)
    }

    const writeNotStartedBlock = (block, reason) => {
      for (const job of block) {
        const tid = `${job.taskId}__${job.arm}__${job.model}__${job.reasoning}__t${job.trialIndex}`
        if (writtenTrialIds.has(tid)) continue
        writtenTrialIds.add(tid)
        const rec = {
          runId,
          trialId: tid,
          taskId: job.taskId,
          stratum: TASKS[job.taskId].stratum,
          arm: job.arm,
          promptStyle: opts.promptStyle,
          model: job.model,
          actualModel: null,
          reasoning: job.reasoning,
          trialIndex: job.trialIndex,
          copilotVersion,
          ...provenance,
          infraFailure: false,
          ungradable: false,
          aborted: false,
          notStarted: true,
          skipReason: reason,
          solved: false,
          noGlobalMonkeyPatch: null,
          technique: 'not_started',
          durationMs: 0,
          usage: extractUsageMetrics(null, job.model),
        }
        results.push(rec)
        appendFileSync(jsonlPath, JSON.stringify(rec) + '\n')
      }
    }

    // N-26: Schedule block-by-block so Control+Treatment pairs stay matched under budget caps!
    const phase1Outputs = []
    let stoppedReason = null

    for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
      const block = blocks[bIdx]
      if (shuttingDown) break
      if (stoppedReason) {
        writeNotStartedBlock(block, stoppedReason)
        continue
      }
      if (opts.maxTotalCredits > 0 && cumulativeCredits >= opts.maxTotalCredits) {
        stoppedReason = `max-total-credits=${opts.maxTotalCredits}`
        console.warn(`Budget cap reached (${cumulativeCredits.toFixed(1)}/${opts.maxTotalCredits}); marking remaining blocks not_started.`)
        writeNotStartedBlock(block, stoppedReason)
        continue
      }

      const runBlockJob = async (job) => {
        const tid = `${job.taskId}__${job.arm}__${job.model}__${job.reasoning}__t${job.trialIndex}`
        startedTrials.set(tid, job)
        console.log(
          `[B${bIdx + 1}/${blocks.length}] START ${job.taskId} (${TASKS[job.taskId].stratum}) | ${job.arm} | ${job.model}:${job.reasoning}`,
        )
        const p1 = await runAgentPhase({
          ...job,
          promptStyle: opts.promptStyle,
          timeoutSec: opts.timeoutSec,
          cliCreditCap: opts.cliCreditCap,
          outDir,
          toolchains,
          keepWorkspaces: opts.keepWorkspaces,
          parentDir: runTmpRoot,
        })
        const u = extractUsageMetrics(p1.cli.usageRaw, job.model)
        if (typeof u.aiCredits === 'number') cumulativeCredits += u.aiCredits
        console.log(
          `[B${bIdx + 1}/${blocks.length}] DONE  ${job.taskId} | ${job.arm} | exit=${p1.cli.exitCode} credits=${u.aiCredits ?? 'n/a'} (cum=${cumulativeCredits.toFixed(1)}/${opts.maxTotalCredits}) (${(p1.cli.durationMs / 1000).toFixed(1)}s)`,
        )
        return p1
      }

      const blockP1s =
        opts.concurrency >= block.length
          ? await Promise.all(block.map(runBlockJob))
          : await (async () => {
              const arr = []
              for (const job of block) arr.push(await runBlockJob(job))
              return arr
            })()

      if (opts.phaseSplit) {
        phase1Outputs.push(...blockP1s)
        // Quick N-05 check on CLI exit/usage before next block
        for (const p1 of blockP1s) {
          const u = extractUsageMetrics(p1.cli.usageRaw, p1.model)
          const isInfra = (p1.cli.exitCode !== 0 && !p1.cli.timedOut) || Boolean(u.usageMissing)
          consecutiveInfra = isInfra ? consecutiveInfra + 1 : 0
          if (consecutiveInfra >= opts.maxConsecutiveInfra) {
            stoppedReason = `consecutive-infra-failures=${consecutiveInfra}`
            console.error(`Aborting remaining blocks after ${consecutiveInfra} consecutive infra failures!`)
          }
        }
      } else {
        for (const p1 of blockP1s) {
          const r = await gradeTrialPhase({ phase1: p1, runId, provenance, copilotVersion, toolchains })
          results.push(r)
          writtenTrialIds.add(r.trialId)
          appendFileSync(jsonlPath, JSON.stringify(r) + '\n')
          consecutiveInfra = r.infraFailure ? consecutiveInfra + 1 : 0
          if (consecutiveInfra >= opts.maxConsecutiveInfra) {
            stoppedReason = `consecutive-infra-failures=${consecutiveInfra}`
          }
        }
      }
    }

    if (opts.phaseSplit && phase1Outputs.length > 0) {
      console.log(`\n--- Phase 2: Grading ${phase1Outputs.length} trials serially in fresh sandboxes ---`)
      for (let i = 0; i < phase1Outputs.length; i++) {
        const p1 = phase1Outputs[i]
        const r = await gradeTrialPhase({
          phase1: p1,
          runId,
          provenance,
          copilotVersion,
          toolchains,
        })
        results.push(r)
        writtenTrialIds.add(r.trialId)
        appendFileSync(jsonlPath, JSON.stringify(r) + '\n')
        console.log(
          `[P2 ${i + 1}/${phase1Outputs.length}] GRADED ${r.taskId} | ${r.arm} -> solved=${r.solved} oracle=${r.oraclePass} adqRed=${r.adequateReproduction} ref=${r.refFixPass} infra=${r.infraFailure} tech=${r.technique}`,
        )
      }
    }
  } finally {
    closeAuditApi()
    toolchains.cleanup()
    rmSync(runTmpRoot, { recursive: true, force: true })
  }

  const byArm = summarizeByArm(results.filter((r) => !r.notStarted))
  const equalSeamRows = results.filter((r) => r.stratum !== 'closed-module' && !r.notStarted)
  const cmh = stratifiedCMH(equalSeamRows, (r) => Boolean(r.solved))
  const rd = matchedRiskDifferenceCI(equalSeamRows, (r) => Boolean(r.solved))
  const summary = {
    version: 'v2.2',
    runId,
    generatedAt: new Date().toISOString(),
    copilotVersion,
    provenance,
    graderChecksum: toolchains.graderChecksum,
    envAllowlistKeys: ENV_ALLOWLIST_KEYS,
    config: {
      tasks,
      arms: opts.arms,
      models,
      promptStyle: opts.promptStyle,
      trials: opts.trials,
      concurrency: opts.concurrency,
      phaseSplit: opts.phaseSplit,
      timeoutSec: opts.timeoutSec,
      cliCreditCap: opts.cliCreditCap,
      maxTotalCredits: opts.maxTotalCredits,
      maxConsecutiveInfra: opts.maxConsecutiveInfra,
      seed: opts.seed,
    },
    pricingTablePerMillionUsd: MODEL_PRICING_PER_M,
    byArm,
    primaryStratifiedCMH: cmh,
    primaryNewcombePairedRD: rd,
    results,
  }
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
  printSummary(results, byArm, outDir)
}

const isEntryPoint =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isEntryPoint) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
