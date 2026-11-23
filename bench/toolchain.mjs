/**
 * Hermetic outside-repo toolchain provisioning using APFS Copy-on-Write (`cp -cR`)
 * on macOS or `--reflink=auto` on Linux.
 *
 * Guarantees (closes I-01, I-03, R-02):
 * - No symlink AND no `.bin` shim anywhere inside trial/grader `node_modules`
 *   references REPO_ROOT (rewrites pnpm's embedded `NODE_PATH` shims!).
 * - Trial workspaces never share a writable `node_modules` with each other or the grader.
 * - Trial workspaces never contain `@tanstack/oracles`, `fast-check`, or hidden graders.
 * - Treatment workspaces receive a real file copy of `execution-points-prototype`
 *   (`package.json` + `src/`), never a symlink back to the repository.
 * - Full grader checksum hashes BOTH grader `node_modules` binaries AND every file
 *   under `bench/graders/` plus `bench/runtime-guard.setup.mjs`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function hashFiles(paths) {
  const h = createHash('sha256')
  for (const p of [...paths].sort()) {
    if (existsSync(p)) {
      h.update(p)
      h.update(readFileSync(p))
    }
  }
  return h.digest('hex')
}

export function cloneDirCoW(src, dest) {
  if (process.platform === 'darwin') {
    execFileSync('cp', ['-cR', src, dest], { stdio: 'pipe' })
    return
  }
  if (process.platform === 'linux') {
    try {
      execFileSync('cp', ['-a', '--reflink=auto', src, dest], { stdio: 'pipe' })
      return
    } catch {
      // fall through
    }
  }
  cpSync(src, dest, { recursive: true, verbatimSymlinks: true })
}

/**
 * Rewrites pnpm's `.bin` shell shims inside `nmDir` so hardcoded `NODE_PATH`
 * paths pointing back into `repoRoot` are replaced with `nmDir` (closes I-03).
 */
function rewriteBinShims(nmDir, repoRoot) {
  const rawRoot = path.resolve(repoRoot)
  const realRoot = realpathSync(repoRoot)
  const realNm = realpathSync(nmDir)
  const needles = [
    ...new Set([
      path.join(rawRoot, 'node_modules'),
      path.join(realRoot, 'node_modules'),
      rawRoot,
      realRoot,
    ]),
  ]

  function walkBins(dir) {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name === '.bin') {
          let binEntries = []
          try {
            binEntries = readdirSync(full, { withFileTypes: true })
          } catch {
            continue
          }
          for (const b of binEntries) {
            if (!b.isFile() || b.isSymbolicLink()) continue
            const bf = path.join(full, b.name)
            let content
            try {
              content = readFileSync(bf, 'utf8')
            } catch {
              continue
            }
            if (content.includes('\0')) continue
            let updated = content
            for (const needle of needles) {
              if (updated.includes(needle)) {
                const replacement = needle.endsWith('node_modules') ? realNm : path.dirname(realNm)
                updated = updated.replaceAll(needle, replacement)
              }
            }
            if (updated !== content) {
              writeFileSync(bf, updated, { mode: lstatSync(bf).mode })
            }
          }
        } else {
          walkBins(full)
        }
      }
    }
  }

  walkBins(nmDir)
}

/**
 * Verifies NO symlink AND NO `.bin` shim anywhere in `dir` resolves or refers
 * to `forbiddenRoot` (closes I-03).
 */
export function assertNoRepoLeak(dir, forbiddenRoot) {
  const forbiddenRaw = path.resolve(forbiddenRoot)
  const forbiddenReal = realpathSync(forbiddenRoot)
  const forbiddenPrefixes = [
    forbiddenReal.endsWith(path.sep) ? forbiddenReal : forbiddenReal + path.sep,
    forbiddenRaw.endsWith(path.sep) ? forbiddenRaw : forbiddenRaw + path.sep,
  ]

  function walk(current, depth) {
    let entries
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const name of entries) {
      const full = path.join(current, name)
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        let resolved
        try {
          resolved = realpathSync(full)
        } catch {
          continue
        }
        if (
          resolved === forbiddenReal ||
          resolved === forbiddenRaw ||
          forbiddenPrefixes.some((p) => resolved.startsWith(p))
        ) {
          throw new Error(`Toolchain symlink leak: ${full} resolves into repo (${resolved})`)
        }
      } else if (st.isDirectory()) {
        if (name === '.bin') {
          for (const bName of readdirSync(full)) {
            const bf = path.join(full, bName)
            let bst
            try {
              bst = lstatSync(bf)
            } catch {
              continue
            }
            if (!bst.isFile() || bst.isSymbolicLink()) continue
            const text = readFileSync(bf, 'utf8')
            if (text.includes('\0')) continue
            if (text.includes(forbiddenReal) || text.includes(forbiddenRaw)) {
              throw new Error(`Toolchain shim leak: ${bf} contains repo path (${forbiddenReal})`)
            }
          }
        } else if (depth < 6) {
          walk(full, depth + 1)
        }
      }
    }
  }
  walk(dir, 0)
}

function stripNonTrialEntries(nmDir) {
  const remove = [
    '@tanstack',
    'fast-check',
    '.vite',
    '.vite-temp',
    '.vitest-cache',
    '.pnpm-workspace-state-v1.json',
    '.modules.yaml',
  ]
  for (const rel of remove) {
    rmSync(path.join(nmDir, rel), { recursive: true, force: true })
  }
  const pnpmDir = path.join(nmDir, '.pnpm')
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (
        entry.startsWith('@tanstack+') ||
        entry.startsWith('fast-check@') ||
        entry.startsWith('pure-rand@')
      ) {
        rmSync(path.join(pnpmDir, entry), { recursive: true, force: true })
      }
    }
  }
}

/**
 * Startup sweep of any orphaned `ep-grader-*` / `ep-bench-toolchains-*` / `ep-ws-*`
 * temp dirs left behind by killed prior runs (closes I-01).
 */
export function sweepStaleTempDirs() {
  const root = tmpdir()
  const prefixes = [
    'ep-grader-',
    'ep-bench-toolchains-',
    'ep-bench-',
    'ep-ws-',
    'ep-test-eval-',
    'ep-copilot-home-',
    'ep-trial-tmp-',
  ]
  let removed = 0
  try {
    for (const name of readdirSync(root)) {
      if (prefixes.some((p) => name.startsWith(p))) {
        rmSync(path.join(root, name), { recursive: true, force: true })
        removed++
      }
    }
  } catch {
    // best-effort
  }
  return removed
}

export function prepareToolchains(repoRoot) {
  const srcNm = path.join(repoRoot, 'node_modules')
  if (!existsSync(srcNm)) {
    throw new Error(`Missing root node_modules at ${srcNm}. Run pnpm install first.`)
  }

  const baseDir = mkdtempSync(path.join(tmpdir(), 'ep-bench-toolchains-'))
  const controlRoot = path.join(baseDir, 'trial-control')
  const treatmentRoot = path.join(baseDir, 'trial-treatment')
  const graderRoot = path.join(baseDir, 'grader')
  mkdirSync(controlRoot, { recursive: true })
  mkdirSync(treatmentRoot, { recursive: true })
  mkdirSync(graderRoot, { recursive: true })

  const controlNm = path.join(controlRoot, 'node_modules')
  const treatmentNm = path.join(treatmentRoot, 'node_modules')
  const graderNm = path.join(graderRoot, 'node_modules')

  // 1. Grader toolchain
  cloneDirCoW(srcNm, graderNm)
  for (const cacheDir of ['.vite', '.vite-temp', '.vitest-cache']) {
    rmSync(path.join(graderNm, cacheDir), { recursive: true, force: true })
  }
  rewriteBinShims(graderNm, repoRoot)

  // 2. Trial control toolchain
  cloneDirCoW(srcNm, controlNm)
  stripNonTrialEntries(controlNm)
  rewriteBinShims(controlNm, repoRoot)

  // 3. Trial treatment toolchain = control + REAL copy of execution-points-prototype
  cloneDirCoW(controlNm, treatmentNm)
  const epDest = path.join(treatmentNm, 'execution-points-prototype')
  mkdirSync(epDest, { recursive: true })
  cpSync(path.join(repoRoot, 'package.json'), path.join(epDest, 'package.json'))
  cpSync(path.join(repoRoot, 'src'), path.join(epDest, 'src'), { recursive: true })
  rewriteBinShims(treatmentNm, repoRoot)

  // Verify zero symlinks AND zero `.bin` text shims leak REPO_ROOT (I-03)
  assertNoRepoLeak(controlNm, repoRoot)
  assertNoRepoLeak(treatmentNm, repoRoot)
  assertNoRepoLeak(graderNm, repoRoot)

  // Full grader checksum: binaries + ALL grader source files + runtime guard (R-02)
  const gradersDir = path.join(repoRoot, 'bench/graders')
  const graderSourceFiles = existsSync(gradersDir)
    ? readdirSync(gradersDir).map((f) => path.join(gradersDir, f))
    : []
  const graderFilesToCheck = [
    path.join(graderNm, '.bin/vitest'),
    path.join(graderNm, 'vitest/package.json'),
    path.join(graderNm, 'fast-check/package.json'),
    path.join(graderNm, 'typescript/package.json'),
    path.join(repoRoot, 'bench/runtime-guard.setup.mjs'),
    ...graderSourceFiles,
  ]
  const initialGraderChecksum = hashFiles(graderFilesToCheck)

  return {
    baseDir,
    controlNm,
    treatmentNm,
    graderNm,
    graderChecksum: initialGraderChecksum,
    verifyGraderChecksum() {
      const current = hashFiles(graderFilesToCheck)
      if (current !== initialGraderChecksum) {
        throw new Error(
          `Grader toolchain/source checksum mismatch: expected ${initialGraderChecksum}, got ${current}`,
        )
      }
      return current
    },
    installForTrial(arm, workspaceDir) {
      const src = arm === 'treatment' ? treatmentNm : controlNm
      const dest = path.join(workspaceDir, 'node_modules')
      cloneDirCoW(src, dest)
    },
    installForGrader(graderDir) {
      cloneDirCoW(graderNm, path.join(graderDir, 'node_modules'))
    },
    cleanup() {
      rmSync(baseDir, { recursive: true, force: true })
    },
  }
}
