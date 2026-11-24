// Shared helpers for probes. Every probe runs against the UNCHANGED repo code.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Throwaway projects live outside the repository, under the OS temp directory.
export const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'ep-probe-')))

export const { executionPoints } = await import(`${REPO}/src/plugin.mjs`)
export const runtime = await import(`${REPO}/src/runtime.mjs`)
export const discovery = await import(`${REPO}/src/discovery.mjs`)
export const contracts = await import(`${REPO}/src/contracts.mjs`)

/** Create a throwaway project directory from { 'rel/path.ts': source }. */
export function project(files) {
  const root = realpathSync(mkdtempSync(join(WORK, 'p-')))
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), src)
  }
  return root
}

/** Index one in-memory source with the real discovery code. */
export function indexSource(source, rel = 'src/app.ts') {
  const root = project({ [rel]: source })
  const plan = discovery.buildTargetPlan({ root, targets: [rel] })
  return { root, plan, nodes: plan.files[0]?.nodes ?? [] }
}

/**
 * Instrument targets with the real Vite plugin transform and write runnable
 * copies next to them (`x.ts` -> `x.inst.ts`) with the runtime import pinned
 * to the repo's runtime module. Returns { root, load(rel), code(rel) }.
 */
export function instrument(files, targets = Object.keys(files)) {
  const root = project(files)
  const plugin = executionPoints({ root, targets })
  const ctx = { addWatchFile() {} }
  plugin.buildStart.call(ctx)
  const out = new Map()
  for (const rel of targets) {
    const file = join(root, rel)
    const res = plugin.transform.call(ctx, readFileSync(file, 'utf8'), file)
    const code = (res?.code ?? readFileSync(file, 'utf8')).replace(
      '"execution-points-prototype/runtime"',
      JSON.stringify(pathToFileURL(`${REPO}/src/runtime.mjs`).href),
    )
    const instFile = file.replace(/\.ts$/, '.inst.ts')
    writeFileSync(instFile, code)
    out.set(rel, { code: res?.code ?? null, instFile })
  }
  return {
    root,
    code: (rel) => out.get(rel).code,
    load: (rel) => import(pathToFileURL(out.get(rel).instFile).href),
  }
}

export const show = (label, value) =>
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
