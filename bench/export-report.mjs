#!/usr/bin/env node
/**
 * Generates a self-contained HTML manual-review report from one or more
 * benchmark run directories (`~/.ep-bench-results/v2-*`).
 *
 * Shows matched Control vs. Treatment trials side by side with:
 * - Grade badges (solved, oracle, adequate RED, refFix, E9 FG/VFPass, credits, tokens, time)
 * - Production code diff against the pristine task baseline
 * - Full agent-written regression test code
 * - Oracle test, single-bug mutant, and E9 refactor/valid-fix verdicts
 * - Filter controls (stratum, model, discordant-only, failed-only)
 *
 * Usage:
 *   node bench/export-report.mjs [--out <path.html>] <runDir1> [runDir2...]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TASKS } from './run.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
let outPath = null
const runDirs = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') outPath = path.resolve(argv[++i])
  else runDirs.push(path.resolve(argv[i]))
}

if (runDirs.length === 0) {
  console.error('Usage: node bench/export-report.mjs [--out report.html] <runDir1> [runDir2...]')
  process.exit(1)
}
outPath ??= path.join(runDirs[0], 'report.html')

function readSrcTree(dir, sub = '') {
  const out = {}
  const full = path.join(dir, sub)
  if (!existsSync(full)) return out
  for (const e of readdirSync(full, { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name
    if (e.isDirectory()) Object.assign(out, readSrcTree(dir, rel))
    else if (e.isFile()) out[`src/${rel}`] = readFileSync(path.join(dir, rel), 'utf8')
  }
  return out
}

function lineDiff(baseText, nextText) {
  const a = (baseText ?? '').split('\n')
  const b = (nextText ?? '').split('\n')
  // Simple LCS line diff (fast for 50–250 line files)
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lines = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'eq', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ kind: 'del', text: a[i++] })
    } else {
      lines.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < m) lines.push({ kind: 'del', text: a[i++] })
  while (j < n) lines.push({ kind: 'add', text: b[j++] })
  return lines
}

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const baselineCache = new Map()
function getBaselineSrc(taskId) {
  if (!baselineCache.has(taskId)) {
    baselineCache.set(taskId, readSrcTree(path.join(__dirname, 'tasks', taskId, 'src')))
  }
  return baselineCache.get(taskId)
}

const blocksMap = new Map()
const allRows = []

for (const runDir of runDirs) {
  const jsonlPath = path.join(runDir, 'results.jsonl')
  if (!existsSync(jsonlPath)) {
    console.warn(`Skipping ${runDir}: missing results.jsonl`)
    continue
  }
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim())
  for (const line of lines) {
    const r = JSON.parse(line)
    if (r.notStarted) continue
    const trialDir = path.join(runDir, 'trials', r.trialId)
    const srcFiles = readSrcTree(path.join(trialDir, 'src'))
    const task = TASKS[r.taskId]
    const baselineSrc = task ? getBaselineSrc(r.taskId) : {}
    const targetRel = task?.targetRel ?? Object.keys(srcFiles).find((f) => !f.endsWith('.test.ts'))
    const testRel = task?.testRel ?? Object.keys(srcFiles).find((f) => f.endsWith('.test.ts'))

    const entry = {
      ...r,
      runDir,
      trialDir,
      targetRel,
      testRel,
      prodCode: srcFiles[targetRel] ?? '',
      prodDiff: lineDiff(baselineSrc[targetRel] ?? '', srcFiles[targetRel] ?? ''),
      testCode: srcFiles[testRel] ?? '',
      extraFiles: Object.entries(srcFiles)
        .filter(([k]) => k !== targetRel && k !== testRel && !(k in baselineSrc))
        .map(([name, content]) => ({ name, content })),
    }
    allRows.push(entry)
    const key = `${r.taskId}|${r.model}|${r.reasoning}|t${r.trialIndex ?? 1}`
    const blk = blocksMap.get(key) ?? {
      key,
      taskId: r.taskId,
      stratum: r.stratum,
      model: r.model,
      reasoning: r.reasoning,
      trialIndex: r.trialIndex ?? 1,
      control: null,
      treatment: null,
    }
    blk[r.arm] = entry
    blocksMap.set(key, blk)
  }
}

const blocks = [...blocksMap.values()].sort((a, b) =>
  `${a.stratum}|${a.taskId}|${a.model}|${a.reasoning}`.localeCompare(
    `${b.stratum}|${b.taskId}|${b.model}|${b.reasoning}`,
  ),
)

function renderDiffHtml(diffLines) {
  return diffLines
    .map((l) => {
      const prefix = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '
      const cls = l.kind === 'add' ? 'd-add' : l.kind === 'del' ? 'd-del' : 'd-eq'
      return `<div class="${cls}">${prefix} ${esc(l.text)}</div>`
    })
    .join('')
}

function renderTrialCard(t, armLabel) {
  if (!t) {
    return `<div class="card empty"><h4>${armLabel}</h4><p>No trial recorded in this block.</p></div>`
  }
  const badge = (ok, label) => `<span class="badge ${ok ? 'ok' : 'fail'}">${esc(label)}</span>`
  const fg = t.refactorRobustness
    ? `${t.refactorRobustness.falseGreenCount}/${t.refactorRobustness.total}`
    : 'n/a'
  const vf = t.validFixRobustness
    ? `${t.validFixRobustness.trueGreenCount}/${t.validFixRobustness.total}`
    : 'n/a'
  const credits = typeof t.usage?.aiCredits === 'number' ? `${t.usage.aiCredits.toFixed(1)} cr` : 'n/a'
  const tokens = t.usage?.totalTokens ? `${t.usage.totalTokens.toLocaleString()} tok` : 'n/a'
  const secs = `${(t.durationMs / 1000).toFixed(1)}s`
  const failedOracle = (t.oracleTests ?? []).filter((x) => x.status !== 'passed')
  const mutantSummary = (t.singleBugMutants?.results ?? [])
    .map((m) => `${m.id}: ${m.outcome}`)
    .join(' · ')

  return `<div class="card ${t.solved ? 'solved' : 'unsolved'}">
    <div class="card-head">
      <strong>${esc(armLabel.toUpperCase())}</strong>
      <span class="tech">${esc(t.technique)}</span>
      <span class="meta">${credits} · ${tokens} · ${secs}</span>
    </div>
    <div class="badges">
      ${badge(t.solved, t.solved ? 'SOLVED' : 'FAIL')}
      ${badge(t.oraclePass, `Oracle: ${t.oraclePass ? 'PASS' : 'FAIL'}`)}
      ${badge(t.adequateReproduction, `AdqRED: ${t.adequateReproduction ? 'YES' : 'NO'}`)}
      ${badge(t.refFixPass, `RefFix: ${t.refFixOutcome ?? t.refFixPass}`)}
      ${badge(t.noGlobalMonkeyPatch !== false, `NoMP: ${t.noGlobalMonkeyPatch}`)}
      <span class="badge neutral">FG: ${esc(fg)}</span>
      <span class="badge neutral">VF: ${esc(vf)}</span>
    </div>
    ${mutantSummary ? `<div class="sub">Mutants: ${esc(mutantSummary)}</div>` : ''}
    ${
      failedOracle.length
        ? `<div class="err-box"><strong>Failed oracle tests:</strong><pre>${esc(
            failedOracle.map((f) => `${f.title}\n${f.failure ?? ''}`).join('\n---\n'),
          )}</pre></div>`
        : ''
    }
    ${
      t.productionViolations?.length
        ? `<div class="err-box"><strong>Production violations:</strong> ${esc(t.productionViolations.join('; '))}</div>`
        : ''
    }
    <details>
      <summary>Production diff (${esc(t.targetRel)})</summary>
      <pre class="code diff">${renderDiffHtml(t.prodDiff)}</pre>
    </details>
    <details>
      <summary>Agent regression test (${esc(t.testRel)}, ${t.testCode.split('\n').length} lines)</summary>
      <pre class="code">${esc(t.testCode)}</pre>
    </details>
    ${t.extraFiles
      .map(
        (ef) =>
          `<details><summary>Added file: ${esc(ef.name)}</summary><pre class="code">${esc(ef.content)}</pre></details>`,
      )
      .join('')}
    <div class="path-note">${esc(t.trialDir)}</div>
  </div>`
}

const modelsList = [...new Set(blocks.map((b) => `${b.model}:${b.reasoning}`))].sort()
const strataList = [...new Set(blocks.map((b) => b.stratum))].sort()

const blocksHtml = blocks
  .map((b) => {
    const cSolved = Boolean(b.control?.solved)
    const tSolved = Boolean(b.treatment?.solved)
    const discordant = cSolved !== tSolved
    const anyFail = !cSolved || !tSolved
    return `<section class="block" data-stratum="${esc(b.stratum)}" data-model="${esc(
      `${b.model}:${b.reasoning}`,
    )}" data-discordant="${discordant}" data-failed="${anyFail}">
      <header class="block-head">
        <h3>${esc(b.taskId)} <span class="pill">${esc(b.stratum)}</span> <span class="pill">${esc(
      `${b.model}:${b.reasoning}`,
    )}</span> <span class="pill">t${b.trialIndex}</span> ${
      discordant ? '<span class="pill disc">DISCORDANT</span>' : ''
    }</h3>
      </header>
      <div class="grid">
        ${renderTrialCard(b.control, 'control')}
        ${renderTrialCard(b.treatment, 'treatment')}
      </div>
    </section>`
  })
  .join('\n')

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>execution-points Benchmark Manual Review (${allRows.length} trials)</title>
<style>
  :root { color-scheme: light dark; --bg: #0d1117; --card: #161b22; --border: #30363d; --fg: #e6edf3; --muted: #8b949e; --ok: #238636; --fail: #da3633; --add: rgba(46,160,67,.18); --del: rgba(248,81,73,.18); }
  @media (prefers-color-scheme: light) {
    :root { --bg: #f6f8fa; --card: #ffffff; --border: #d0d7de; --fg: #1f2328; --muted: #59636e; --add: #dafbe1; --del: #ffebe9; }
  }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 20px; background: var(--bg); color: var(--fg); line-height: 1.45; }
  h1 { margin: 0 0 8px; font-size: 20px; }
  .controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 12px 0 20px; padding: 12px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; }
  select, label { font-size: 13px; }
  .block { margin-bottom: 20px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); overflow: hidden; }
  .block-head { padding: 10px 14px; border-bottom: 1px solid var(--border); background: rgba(127,127,127,.06); }
  .block-head h3 { margin: 0; font-size: 15px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .pill { font-size: 11px; font-weight: 500; padding: 2px 7px; border-radius: 12px; border: 1px solid var(--border); color: var(--muted); }
  .pill.disc { background: #9e6a03; color: #fff; border-color: transparent; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px; }
  @media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } }
  .card { border: 1px solid var(--border); border-radius: 8px; padding: 12px; min-width: 0; }
  .card.solved { border-top: 3px solid var(--ok); }
  .card.unsolved { border-top: 3px solid var(--fail); }
  .card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  .tech { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; padding: 2px 6px; border-radius: 4px; background: rgba(127,127,127,.15); }
  .meta { font-size: 12px; color: var(--muted); }
  .badges { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
  .badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
  .badge.ok { background: rgba(35,134,54,.2); color: #3fb950; }
  .badge.fail { background: rgba(218,54,51,.2); color: #f85149; }
  .badge.neutral { background: rgba(127,127,127,.15); color: var(--fg); }
  .sub { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
  .err-box { background: rgba(218,54,51,.12); border: 1px solid rgba(218,54,51,.4); border-radius: 6px; padding: 8px; margin: 8px 0; font-size: 12px; }
  .err-box pre { margin: 4px 0 0; white-space: pre-wrap; font-size: 11px; }
  details { margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; }
  summary { cursor: pointer; font-size: 12px; font-weight: 600; }
  pre.code { margin: 8px 0 0; padding: 8px; overflow-x: auto; font-size: 11.5px; line-height: 1.4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(127,127,127,.07); border-radius: 4px; max-height: 480px; }
  .d-add { background: var(--add); }
  .d-del { background: var(--del); }
  .path-note { margin-top: 8px; font-size: 10.5px; color: var(--muted); word-break: break-all; font-family: ui-monospace, monospace; }
</style>
</head>
<body>
  <h1>execution-points Benchmark Manual Review (${allRows.length} trials / ${blocks.length} matched blocks)</h1>
  <div class="controls">
    <label>Stratum:
      <select id="fStratum">
        <option value="all">All strata</option>
        ${strataList.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
      </select>
    </label>
    <label>Model:
      <select id="fModel">
        <option value="all">All models</option>
        ${modelsList.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}
      </select>
    </label>
    <label><input type="checkbox" id="fDisc" /> Discordant pairs only</label>
    <label><input type="checkbox" id="fFail" /> Blocks with any failure</label>
    <span id="fCount" class="meta"></span>
  </div>
  <main id="blocks">${blocksHtml}</main>
  <script>
    const els = [...document.querySelectorAll('.block')];
    const fS = document.getElementById('fStratum');
    const fM = document.getElementById('fModel');
    const fD = document.getElementById('fDisc');
    const fF = document.getElementById('fFail');
    const fC = document.getElementById('fCount');
    function apply() {
      let shown = 0;
      for (const el of els) {
        const ok = (fS.value === 'all' || el.dataset.stratum === fS.value)
          && (fM.value === 'all' || el.dataset.model === fM.value)
          && (!fD.checked || el.dataset.discordant === 'true')
          && (!fF.checked || el.dataset.failed === 'true');
        el.style.display = ok ? '' : 'none';
        if (ok) shown++;
      }
      fC.textContent = shown + ' / ' + els.length + ' blocks shown';
    }
    [fS, fM, fD, fF].forEach(x => x.addEventListener('change', apply));
    apply();
  </script>
</body>
</html>`

writeFileSync(outPath, html)
console.log(`Generated manual review report (${allRows.length} trials / ${blocks.length} blocks): ${outPath}`)
