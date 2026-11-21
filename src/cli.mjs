#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPlan } from './compiler.mjs';
import { buildPlan } from './discovery.mjs';

const usage = 'Usage: node src/cli.mjs check\nLoads points.config.mjs from the current directory and checks the virtual TypeScript program.';

function sourcePosition(source, position) {
  const start = Math.max(0, Math.min(source.length, position));
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const newline = source.indexOf('\n', start);
  const lineEnd = newline === -1 ? source.length : newline;
  return {
    line: source.slice(0, start).split('\n').length,
    column: start - lineStart + 1,
    text: source.slice(lineStart, lineEnd).replace(/\r$/, ''),
    offset: start - lineStart,
  };
}

function printDiagnostic(diagnostic, root, sources) {
  const file = diagnostic.fileName;
  const label = file ? path.relative(root, file) || path.basename(file) : 'project';
  const code = typeof diagnostic.code === 'number'
    ? `${diagnostic.code >= 90000 ? 'EP' : 'TS'}${diagnostic.code}`
    : diagnostic.code;
  let source = sources.get(file);
  if (source === undefined && file) {
    try { source = readFileSync(file, 'utf8'); } catch { /* A project diagnostic can name a missing file. */ }
  }
  if (source === undefined) {
    console.error(`${label} - ${code}: ${diagnostic.text}`);
    return;
  }
  const position = sourcePosition(source, diagnostic.start);
  console.error(`${label}:${position.line}:${position.column} - ${code}: ${diagnostic.text}`);
  const gutter = String(position.line);
  const prefix = position.text.slice(0, position.offset).replaceAll('\t', '  ');
  const remaining = position.text.slice(position.offset).replaceAll('\t', '  ');
  const width = Math.max(1, Math.min(diagnostic.end - diagnostic.start, remaining.length, 100));
  console.error(`  ${gutter} | ${position.text.replaceAll('\t', '  ')}`);
  console.error(`  ${' '.repeat(gutter.length)} | ${' '.repeat(prefix.length)}${'~'.repeat(width)}`);
}

async function main() {
  const [command = 'check', ...rest] = process.argv.slice(2);
  if (command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  if (command !== 'check' || rest.length) {
    console.error(usage);
    process.exitCode = 1;
    return;
  }

  const configFile = path.resolve('points.config.mjs');
  if (!existsSync(configFile)) throw new Error(`Cannot find points.config.mjs in ${process.cwd()}. Run this command from the project directory.`);
  const { default: config } = await import(pathToFileURL(configFile).href);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('points.config.mjs must default-export an object containing testFiles and optionally root and tsconfig.');
  }
  const plan = buildPlan(config);
  const checked = checkPlan(plan);
  const sources = new Map([
    ...plan.targets.map((target) => [target.file, target.source]),
    ...plan.tests.map((test) => [test.file, test.source]),
  ]);
  if (!checked.ok) {
    for (const diagnostic of checked.diagnostics) printDiagnostic(diagnostic, plan.root, sources);
    console.error(`\nFound ${checked.diagnostics.length} error${checked.diagnostics.length === 1 ? '' : 's'}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Checked ${checked.contracts.length} execution point${checked.contracts.length === 1 ? '' : 's'} across ${plan.tests.length} test file${plan.tests.length === 1 ? '' : 's'}.`);
  for (const contract of checked.contracts) {
    const target = plan.targets.find((entry) => entry.id === contract.id);
    const position = sourcePosition(target.source, target.start);
    const result = contract.result.replace(/\s+/g, ' ');
    console.log(`  ${path.relative(plan.root, target.file)}:${position.line}:${position.column} -> ${result}`);
  }
}

main().catch((error) => {
  console.error(`[execution-points] ${error.message ?? error}`);
  process.exitCode = 1;
});
