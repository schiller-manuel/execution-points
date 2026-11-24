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
 *   under `bench/graders/` plus `bench/runtime-guard.setup.mjs`,
 *   `bench/deterministic-io.setup.mjs` and `bench/classify.mjs`.
 * - Refuses a symlinked root `node_modules`: stripping the copies would delete
 *   packages from the checkout the link points to.
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

function hashEntries(entries, normalizeRoot = null) {
  // V-07: Hash RELATIVE keys + path-normalized file contents so graderChecksum
  // detects tampering AND stays deterministic across runs!
  const h = createHash('sha256')
  for (const { key, file } of [...entries].sort((a, b) => a.key.localeCompare(b.key))) {
    if (existsSync(file)) {
      h.update(key)
      h.update('\0')
      const raw = readFileSync(file)
      if (normalizeRoot && key.includes('.bin/')) {
        h.update(raw.toString('utf8').replaceAll(normalizeRoot, '<GRADER_ROOT>'))
      } else {
        h.update(raw)
      }
      h.update('\0')
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
  const root = realpathSync(tmpdir())
  const prefixes = [
    'ep-grader-',
    'ep-bench-toolchains-',
    'ep-bench-',
    'ep-ws-',
    'ep-ownfix-',
    'ep-test-eval-',
    'ep-copilot-home-',
    'ep-trial-tmp-',
    'ep-run-',
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

function collectWholeGraderHashEntries(graderNm, repoRoot) {
  const entries = []
  const pushRepoFile = (file) => {
    if (existsSync(file)) {
      entries.push({ key: `repo:${path.relative(repoRoot, file).replaceAll('\\', '/')}`, file })
    }
  }
  const pushNmFile = (file) => {
    if (existsSync(file)) {
      entries.push({ key: `nm:${path.relative(graderNm, file).replaceAll('\\', '/')}`, file })
    }
  }
  const gradersDir = path.join(repoRoot, 'bench/graders')
  if (existsSync(gradersDir)) {
    for (const f of readdirSync(gradersDir)) pushRepoFile(path.join(gradersDir, f))
  }
  pushRepoFile(path.join(repoRoot, 'bench/runtime-guard.setup.mjs'))
  pushRepoFile(path.join(repoRoot, 'bench/deterministic-io.setup.mjs'))
  pushRepoFile(path.join(repoRoot, 'bench/classify.mjs'))

  const binDir = path.join(graderNm, '.bin')
  if (existsSync(binDir)) {
    for (const f of readdirSync(binDir)) pushNmFile(path.join(binDir, f))
  }
  for (const pkg of ['vitest', 'vite', 'fast-check', 'typescript', 'magic-string']) {
    pushNmFile(path.join(graderNm, pkg, 'package.json'))
  }
  const pnpmDir = path.join(graderNm, '.pnpm')
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      const subBin = path.join(pnpmDir, entry, 'node_modules/.bin')
      if (existsSync(subBin)) {
        for (const f of readdirSync(subBin)) pushNmFile(path.join(subBin, f))
      }
    }
  }
  return entries
}

export function prepareToolchains(repoRoot, parentDir = realpathSync(tmpdir())) {
  const srcNm = path.join(repoRoot, 'node_modules')
  if (!existsSync(srcNm)) {
    throw new Error(`Missing root node_modules at ${srcNm}. Run pnpm install first.`)
  }
  // `cp -R` copies a symlinked `node_modules` as a link, and the stripping below would then
  // delete packages from whatever checkout the link points to. Refuse instead.
  if (lstatSync(srcNm).isSymbolicLink()) {
    throw new Error(
      `${srcNm} is a symbolic link (to ${realpathSync(srcNm)}). Toolchain preparation deletes packages from its copies and would delete them through the link. Run \`pnpm install --frozen-lockfile\` in this checkout instead.`,
    )
  }

  // N-00: Always realpath so macOS /var -> /private/var matches CLI paths
  const baseDir = realpathSync(mkdtempSync(path.join(parentDir, 'ep-bench-toolchains-')))
  const controlRoot = path.join(baseDir, 'trial-control')
  const treatmentRoot = path.join(baseDir, 'trial-treatment')
  const graderRoot = path.join(baseDir, 'grader')
  mkdirSync(controlRoot, { recursive: true })
  mkdirSync(treatmentRoot, { recursive: true })
  mkdirSync(graderRoot, { recursive: true })

  const controlNm = path.join(controlRoot, 'node_modules')
  const treatmentNm = path.join(treatmentRoot, 'node_modules')
  const graderNm = path.join(graderRoot, 'node_modules')

  // 1. Grader toolchain — strip repo-referencing pnpm metadata too (N-30!)
  cloneDirCoW(srcNm, graderNm)
  for (const rel of [
    '.vite',
    '.vite-temp',
    '.vitest-cache',
    '.pnpm-workspace-state-v1.json',
    '.modules.yaml',
  ]) {
    rmSync(path.join(graderNm, rel), { recursive: true, force: true })
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

  // Full grader toolchain + source checksum using relative paths (R-02, N-30, V-07)
  const graderEntriesToCheck = collectWholeGraderHashEntries(graderNm, repoRoot)
  const initialGraderChecksum = hashEntries(graderEntriesToCheck, baseDir)

  return {
    baseDir,
    controlNm,
    treatmentNm,
    graderNm,
    graderChecksum: initialGraderChecksum,
    verifyGraderChecksum() {
      const current = hashEntries(graderEntriesToCheck, baseDir)
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
