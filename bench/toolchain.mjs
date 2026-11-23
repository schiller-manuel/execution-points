/**
 * Hermetic outside-repo toolchain provisioning using APFS Copy-on-Write (`cp -cR`)
 * on macOS or `--reflink=auto` on Linux.
 *
 * Guarantees:
 * - No symlink inside any trial workspace resolves inside REPO_ROOT.
 * - Trial workspaces never share a writable `node_modules` with each other or the grader.
 * - Trial workspaces never contain `@tanstack/oracles`, `fast-check`, or hidden graders.
 * - Treatment workspaces receive a real file copy of `execution-points-prototype`
 *   (`package.json` + `src/`), never a symlink back to the repository.
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
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function hashFiles(paths) {
  const h = createHash('sha256')
  for (const p of paths) {
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
 * Recursively checks top-level and .bin entries (up to depth 3) to verify
 * no symlink resolves inside `forbiddenRoot`.
 */
export function assertNoRepoLeak(dir, forbiddenRoot) {
  const forbiddenReal = realpathSync(forbiddenRoot)
  const forbiddenPrefix = forbiddenReal.endsWith(path.sep)
    ? forbiddenReal
    : forbiddenReal + path.sep

  function walk(current, depth) {
    if (depth > 3) return
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
        if (resolved === forbiddenReal || resolved.startsWith(forbiddenPrefix)) {
          throw new Error(`Toolchain isolation leak: ${full} resolves into repo (${resolved})`)
        }
      } else if (st.isDirectory() && name !== '.pnpm') {
        walk(full, depth + 1)
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
  // Remove any @tanstack or fast-check packages inside .pnpm store as well
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

  // 1. Grader toolchain (retains fast-check, vitest, magic-string, typescript)
  cloneDirCoW(srcNm, graderNm)
  for (const cacheDir of ['.vite', '.vite-temp', '.vitest-cache']) {
    rmSync(path.join(graderNm, cacheDir), { recursive: true, force: true })
  }

  // 2. Trial control toolchain (stripped of oracle/fast-check/cache dirs)
  cloneDirCoW(srcNm, controlNm)
  stripNonTrialEntries(controlNm)

  // 3. Trial treatment toolchain = control + REAL copy of execution-points-prototype
  cloneDirCoW(controlNm, treatmentNm)
  const epDest = path.join(treatmentNm, 'execution-points-prototype')
  mkdirSync(epDest, { recursive: true })
  cpSync(path.join(repoRoot, 'package.json'), path.join(epDest, 'package.json'))
  cpSync(path.join(repoRoot, 'src'), path.join(epDest, 'src'), { recursive: true })

  // Verify zero symlinks escape back to REPO_ROOT
  assertNoRepoLeak(controlNm, repoRoot)
  assertNoRepoLeak(treatmentNm, repoRoot)
  assertNoRepoLeak(graderNm, repoRoot)

  const graderFilesToCheck = [
    path.join(graderNm, '.bin/vitest'),
    path.join(graderNm, 'vitest/package.json'),
    path.join(graderNm, 'fast-check/package.json'),
    path.join(graderNm, 'typescript/package.json'),
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
          `Grader toolchain checksum mismatch: expected ${initialGraderChecksum}, got ${current}`,
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
