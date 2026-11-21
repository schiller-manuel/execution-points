import path from 'node:path';
import { CompletionItemKind, TypeFormatFlags } from 'typescript-native/sync';
import { getTouchingPropertyName, SyntaxKind } from 'typescript-native/ast';
import { checkPlan } from './compiler.mjs';
import { buildPlan } from './discovery.mjs';

const hoverKinds = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.ThisKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
]);

function overlapsGenerated(projection, start, end) {
  return projection.inserted.some((edit) => start < edit.virtualEnd && end > edit.virtualStart);
}

function queryProgram(query, { program, projections, sources }, root) {
  const fileName = path.resolve(root, query.fileName);
  const projection = projections.get(fileName);
  const source = sources.get(fileName);
  if (!projection || source === undefined || !Number.isInteger(query.position)
      || query.position < 0 || query.position > source.length) return undefined;
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) return undefined;
  const project = program.getProject();
  let position = projection.originalToVirtual(query.position);
  // At authored EOF, completion must stay before appended phantom exports.
  // Hidden type arguments elsewhere precede the next authored character.
  if (query.position === source.length) {
    position = projection.inserted.find((edit) => edit.pos === source.length)?.virtualStart ?? position;
  }
  const token = getTouchingPropertyName(sourceFile, position);
  const tokenStart = token.getStart(sourceFile);
  const tokenEnd = token.end;

  if (query.kind === 'hover') {
    if (!hoverKinds.has(token.kind) || tokenEnd <= tokenStart
        || position < tokenStart || position > tokenEnd
        || overlapsGenerated(projection, tokenStart, tokenEnd)) return undefined;
    // At an identifier's trailing boundary the next token may have a different
    // type; ask about a position inside the hovered token.
    const inside = Math.min(position, tokenEnd - 1);
    const type = project.checker.getTypeAtPosition(fileName, inside);
    if (!type || type.isErrorType()) return undefined;
    const text = project.checker.typeToString(type, token, TypeFormatFlags.NoTruncation);
    const label = token.getText(sourceFile);
    return {
      text: `${label}: ${text}`,
      start: projection.map(tokenStart),
      end: projection.map(tokenEnd, true),
    };
  }

  if (query.kind === 'completion') {
    const completion = project.languageService.getCompletionsAtPosition(fileName, position);
    if (!completion) return undefined;
    // This beta has no replacementSpan on CompletionEntry. Identifier tokens
    // give us the appropriate replacement range for ordinary member/name
    // completions, including a zero-width insertion after an incomplete dot.
    const replaceToken = (token.kind === SyntaxKind.Identifier || token.kind === SyntaxKind.PrivateIdentifier)
      && tokenStart <= position && tokenEnd >= position
      && !overlapsGenerated(projection, tokenStart, tokenEnd);
    const start = replaceToken ? projection.map(tokenStart) : query.position;
    const end = replaceToken ? projection.map(tokenEnd, true) : query.position;
    return {
      isIncomplete: completion.isIncomplete,
      entries: completion.entries
        .filter((entry) => !entry.name.startsWith('__Point_'))
        .map((entry) => ({
          name: entry.name,
          kind: entry.kind ?? CompletionItemKind.Text,
          sortText: entry.sortText ?? entry.name,
          ...(entry.insertText === undefined ? {} : { insertText: entry.insertText }),
          start,
          end,
        })),
    };
  }
  return undefined;
}

/**
 * Rebuild the virtual project from current editor buffers and return plain JSON
 * data. Discovery/config errors intentionally reach the sidecar's error handler.
 * A query can succeed even when the test has syntax/type errors (e.g. locals.).
 */
export function analyzeEditor(config, { overrides = new Map(), query } = {}) {
  const plan = buildPlan({ ...config, overrides });
  let queryResult;
  const checked = checkPlan(plan, {
    overrides,
    inspect: query ? (state) => {
      queryResult = queryProgram(query, state, plan.root);
    } : undefined,
  });
  return {
    projected: checked.projected,
    diagnostics: checked.diagnostics,
    files: [...new Set([
      ...plan.tests.map((test) => test.file),
      ...plan.targets.map((target) => target.file),
    ])],
    ...(queryResult === undefined ? {} : { queryResult }),
  };
}
