/**
 * Hermetic outside-repo toolchain provisioning using APFS Copy-on-Write (`cp -cR`)
 * on macOS or `--reflink=auto` on Linux.
 *
 * Guarantees (closes I-01, I-03, R-02):
 * - No symlink AND no `.bin` shim anywhere inside trial/grader `node_modules`
 *   references REPO_ROOT (rewrites pnpm's embedded `NODE_PATH` shims!).
 * - Trial workspaces never share a writable `node_modules` with each other or the grader.
 * - Trial workspaces never contain `@tanstack/oracles`, `fast-check`, or hidden graders.
 * - Treatment workspaces receive a real file copy of `execution-points-prototype` as
 *   the package ships it (`package.json`, `points.schema.json`, `dist/`), never a
 *   symlink back to the repository, and its commands in `node_modules/.bin`, as an
 *   install would link them (so `npx execution-points …` resolves without a network).
 * - The library is built into the toolchain's own temp root. Nothing here writes into
 *   the checkout: its `dist/` belongs to whoever builds there (`buildLibrary`).
 * - Full grader checksum hashes BOTH grader `node_modules` binaries AND every file
 *   under `bench/graders/` plus `bench/runtime-guard.setup.mjs`,
 *   `bench/deterministic-io.setup.mjs`, `bench/classify.mjs` and
 *   `bench/failure-reporter.mjs`.
 * - Refuses a symlinked root `node_modules`: stripping the copies would delete
 *   packages from the checkout the link points to.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
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

/** Written into every temp root this harness creates; names the process that owns it. */
export const OWNER_FILE = '.ep-owner.json'

const SWEEP_PREFIXES = [
  'ep-grader-',
  'ep-bench-toolchains-',
  'ep-bench-',
  'ep-ws-',
  'ep-ownfix-',
  'ep-test-eval-',
  'ep-copilot-home-',
  'ep-trial-tmp-',
  'ep-run-',
  'ep-regrade-',
  'ep-selftest-',
]

function writeOwnerFile(dir) {
  writeFileSync(
    path.join(dir, OWNER_FILE),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), argv: process.argv.slice(1, 4) }) + '\n',
  )
}

/**
 * Creates a temp root owned by this process: a fresh directory under
 * `parentDir` with an owner record in it. Everything a run, a re-grade or a
 * self-test creates goes under one such root, so a later sweep can tell whose
 * it is.
 */
export function createOwnedTempRoot(prefix, parentDir = realpathSync(tmpdir())) {
  // N-00: realpath so macOS /var -> /private/var matches CLI paths
  const dir = realpathSync(mkdtempSync(path.join(parentDir, prefix)))
  writeOwnerFile(dir)
  return dir
}

/** True when a process with this pid exists (also when it belongs to another user). */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * Removes orphaned `ep-*` temp roots left behind by killed runs (closes I-01),
 * and ONLY those whose owning process is gone.
 *
 * Up to v2.3 this removed every `ep-*` directory in the temp directory,
 * including the sandboxes of bench processes that were still running (another
 * run, a self-test, a re-grade, possibly from another checkout). Now a
 * directory is removed only when it carries an owner record and that process
 * no longer exists. A directory whose owner is alive is left alone. A directory
 * without an owner record (made by an older harness version or by another
 * tool) is also left alone, because nothing shows that its process is gone; it
 * is counted so the caller can say so.
 *
 * A pid that was reused by an unrelated process reads as alive, which errs on
 * the side of keeping the directory.
 */
export function sweepStaleTempDirs({ root = realpathSync(tmpdir()) } = {}) {
  const result = { removed: [], inUse: [], unowned: [] }
  let names = []
  try {
    names = readdirSync(root)
  } catch {
    return result // best-effort
  }
  for (const name of names) {
    if (!SWEEP_PREFIXES.some((p) => name.startsWith(p))) continue
    const dir = path.join(root, name)
    let owner = null
    try {
      if (!lstatSync(dir).isDirectory()) continue
      owner = JSON.parse(readFileSync(path.join(dir, OWNER_FILE), 'utf8'))
    } catch {
      owner = null
    }
    if (owner === null || !Number.isInteger(owner.pid)) {
      result.unowned.push(name)
    } else if (owner.pid === process.pid || processIsAlive(owner.pid)) {
      result.inUse.push(name)
    } else {
      try {
        rmSync(dir, { recursive: true, force: true })
        result.removed.push(name)
      } catch {
        // best-effort
      }
    }
  }
  return result
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
  pushRepoFile(path.join(repoRoot, 'bench/failure-reporter.mjs'))

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

/**
 * Builds the library from the sources of `repoRoot` into `outDir`, which must lie outside
 * the checkout, and returns `outDir`. The checkout's own `dist/` is neither read nor
 * written: `tsdown` empties its output directory first, and other processes (a type check,
 * the gap check) read the checkout's `dist/` while a bench process starts.
 */
export function buildLibrary(repoRoot, outDir) {
  const inside = path.relative(realpathSync(repoRoot), path.resolve(outDir))
  if (!inside.startsWith('..') && !path.isAbsolute(inside)) {
    throw new Error(`The library must be built outside the checkout, not into ${outDir}`)
  }
  execFileSync(
    process.execPath,
    [path.join(repoRoot, 'node_modules/tsdown/dist/run.mjs'), '--logLevel', 'error', '--out-dir', outDir],
    { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'] },
  )
  return outDir
}

/**
 * Installs the package into `nmDir` as its `package.json` ships it: the manifest, what
 * `files` lists (taken from the build in `builtDir` for `dist`), and a link in `.bin` for
 * every command in `bin`, relative, as a package manager creates it.
 */
function installBuiltPackage(repoRoot, builtDir, nmDir) {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const dest = path.join(nmDir, manifest.name)
  mkdirSync(dest, { recursive: true })
  cpSync(path.join(repoRoot, 'package.json'), path.join(dest, 'package.json'))
  for (const entry of manifest.files ?? []) {
    const from = entry === 'dist' ? builtDir : path.join(repoRoot, entry)
    cpSync(from, path.join(dest, entry), { recursive: true })
  }
  const bins = typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {})
  const binDir = path.join(nmDir, '.bin')
  mkdirSync(binDir, { recursive: true })
  for (const [command, rel] of Object.entries(bins)) {
    const target = path.join(dest, rel)
    if (!existsSync(target)) throw new Error(`The package names the command "${command}" at ${rel}, which the build did not produce`)
    chmodSync(target, statSync(target).mode | 0o111)
    const link = path.join(binDir, command)
    rmSync(link, { force: true })
    symlinkSync(path.relative(binDir, target), link)
  }
  return { dest, commands: Object.keys(bins) }
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

  // N-00: Always realpath so macOS /var -> /private/var matches CLI paths.
  // The toolchain root carries an owner record even when it is nested in a run root, so a
  // standalone caller's toolchain can be swept once that caller is gone.
  const baseDir = createOwnedTempRoot('ep-bench-toolchains-', parentDir)
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

  // 3. Trial treatment toolchain = control + REAL copy of execution-points-prototype.
  // The package ships `dist`: built here from the sources, so a workspace never gets a library
  // older than they are, and built into this toolchain's root, so the checkout is not written.
  cloneDirCoW(controlNm, treatmentNm)
  const builtDir = buildLibrary(repoRoot, path.join(baseDir, 'library-dist'))
  const library = installBuiltPackage(repoRoot, builtDir, treatmentNm)
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
    // Where the treatment arm's library is, and the commands it puts into `.bin`.
    libraryDir: library.dest,
    libraryCommands: library.commands,
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
