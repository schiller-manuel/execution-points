import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  API,
  ModuleKind,
  ModuleResolutionKind,
  NodeBuilderFlags,
  SymbolFlags,
  TypeFlags,
} from 'typescript-native/sync';
import { createFileSystemLayer } from 'typescript-native/fs';
import { ScriptTarget, SyntaxKind } from 'typescript-native/ast';

const aliasName = (id) => `__Point_${id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
const markerName = (id) => `__execution_point_${id}`;
const localScopes = new Set([
  SyntaxKind.Block,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

function walk(node, visit) {
  visit(node);
  node.forEachChild((child) => { walk(child, visit); });
}

function pointDiagnostic(target, code, text) {
  return { fileName: target.file, start: target.start, end: target.end, code, text };
}

// All projections consist of insertions. Keeping their source anchors also lets
// diagnostics in generated text point back to the point that requested it.
function project(source, edits = []) {
  const ordered = [...edits].sort((a, b) => a.pos - b.pos || (a.order ?? 0) - (b.order ?? 0));
  let text = '';
  let cursor = 0;
  const inserted = [];
  for (const edit of ordered) {
    text += source.slice(cursor, edit.pos);
    inserted.push({ ...edit, virtualStart: text.length, virtualEnd: text.length + edit.text.length });
    text += edit.text;
    cursor = edit.pos;
  }
  text += source.slice(cursor);
  return {
    text,
    inserted,
    originalToVirtual(position) {
      return position + inserted.reduce((sum, edit) => sum + (edit.pos <= position ? edit.text.length : 0), 0);
    },
    map(position, end = false) {
      let shift = 0;
      for (const edit of inserted) {
        if (position < edit.virtualStart) break;
        if (position < edit.virtualEnd) return end ? edit.anchor.end : edit.anchor.start;
        shift += edit.text.length;
      }
      return Math.max(0, Math.min(source.length, position - shift));
    },
  };
}

function normalize(diagnostic, projections = new Map()) {
  const projection = projections.get(diagnostic.fileName);
  const pos = Math.max(0, diagnostic.pos ?? diagnostic.start ?? 0);
  const end = Math.max(pos, diagnostic.end ?? pos);
  const start = projection ? projection.map(pos) : pos;
  const mappedEnd = projection ? projection.map(end, true) : end;
  const chain = (diagnostic.messageChain ?? []).map((child) => child.text).filter(Boolean);
  return {
    fileName: diagnostic.fileName,
    start,
    end: Math.max(start, mappedEnd),
    code: diagnostic.code,
    text: [diagnostic.text ?? 'TypeScript reported an error.', ...chain].join('\n'),
  };
}

function diagnosticsOf(program, projections) {
  return [
    ...program.getProgramDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getBindDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].filter((diagnostic) => diagnostic.category === 1).map((diagnostic) => normalize(diagnostic, projections));
}

function uniqueDiagnostics(diagnostics) {
  const seen = new Set();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function symbolIdentity(checker, symbol) {
  if (symbol.flags & SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol.declarations.map((declaration) => `${declaration.path}:${declaration.index}`).sort().join('|');
}

function hasLocalDeclaration(symbol) {
  return symbol.declarations.some((handle) => {
    let declaration = handle.resolve();
    // The declaration's own function body does not make a module function local.
    for (let parent = declaration?.parent; parent && parent.kind !== SyntaxKind.SourceFile; parent = parent.parent) {
      if (localScopes.has(parent.kind)) return true;
    }
    return false;
  });
}

// This is deliberately conservative. A printed "Local" can silently bind to an
// unrelated module-level Local, so successful final typechecking alone is not
// sufficient to transport function-local types safely.
function checkPortable(type, checker, location, seen = new Set(), names = new Map()) {
  if (seen.has(type.id)) return names;
  seen.add(type.id);
  if (type.isErrorType()) throw new Error('TypeScript could not determine this type.');
  if (type.flags & TypeFlags.Any) throw new Error('This type is any; the prototype requires a concrete checked type.');
  if (type.isTypeParameter()) throw new Error(`The type parameter ${checker.typeToString(type)} is local to a generic scope.`);

  const alias = type.getAliasSymbol();
  const symbol = type.getSymbol();
  const namedFlags = SymbolFlags.TypeAlias | SymbolFlags.Interface | SymbolFlags.Class | SymbolFlags.Enum | SymbolFlags.TypeParameter;
  for (const named of [alias, symbol].filter(Boolean)) {
    if ((named.flags & namedFlags) || (type.flags & TypeFlags.UniqueESSymbol)) {
      if (hasLocalDeclaration(named)) throw new Error(`The type ${named.name} is declared inside a function or block and cannot yet be exposed to a test without changing its identity.`);
      const identities = names.get(named.name) ?? new Set();
      identities.add(symbolIdentity(checker, named));
      names.set(named.name, identities);
    }
  }

  const visit = (child) => { if (child) checkPortable(child, checker, location, seen, names); };
  for (const argument of type.getAliasTypeArguments()) visit(argument);
  if (type.isTypeReference()) {
    for (const argument of checker.getTypeArguments(type)) visit(argument);
  }
  for (const member of type.getTypes() ?? []) visit(member);

  // A module-level named type remains in its original module. Its private
  // members need not be copied. Only anonymous structural types need expansion.
  if (alias || (symbol && (symbol.flags & namedFlags)) || type.isTypeReference()) return names;
  if (type.isObjectType()) {
    for (const property of type.getProperties()) visit(checker.getTypeOfSymbolAtLocation(property, location));
    for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
      if (signature.getTypeParameters().length) throw new Error('Generic function-valued captures are not supported by this prototype.');
      for (const parameter of signature.getParameters()) visit(checker.getTypeOfSymbolAtLocation(parameter, location));
      visit(signature.getReturnType());
    }
    for (const info of type.getIndexInfos()) visit(info.type);
  }
  return names;
}

function printType(api, checker, type, sourceFile, location) {
  const names = checkPortable(type, checker, location);
  const node = checker.typeToTypeNode(type, sourceFile, NodeBuilderFlags.NoTruncation);
  if (!node) throw new Error('TypeScript could not represent this type in a virtual contract.');
  walk(node, (part) => {
    if (part.kind !== SyntaxKind.TypeReference || part.typeName.kind !== SyntaxKind.Identifier) return;
    const name = part.typeName.text;
    const expected = names.get(name);
    if (!expected) return;
    const visible = checker.resolveName(name, SymbolFlags.Type, sourceFile);
    if (!visible || expected.size !== 1 || !expected.has(symbolIdentity(checker, visible))) {
      throw new Error(`The type name ${name} is not accessible with the same meaning at module scope.`);
    }
  });
  return api.printer.printNode(node);
}

function typeImport(fromFile, targetFile) {
  let relative = path.relative(path.dirname(fromFile), targetFile).replaceAll(path.sep, '/');
  relative = relative.replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs').replace(/\.tsx?$/, '.js');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Typecheck a discovered plan using ordinary TypeScript source overlays.
 * No generated declaration or source files are written to disk.
 */
export function checkPlan(plan, { overrides = new Map() } = {}) {
  const originals = new Map();
  for (const target of plan.targets) originals.set(target.file, target.source);
  for (const test of plan.tests) originals.set(test.file, test.source);
  for (const [file, source] of overrides) originals.set(file, source);
  const result = { diagnostics: [], projections: new Map(originals), contracts: [], ok: false };
  const api = new API({ cwd: plan.root });
  let analysisSnapshot;
  let finalSnapshot;
  try {
    const config = plan.tsconfig && existsSync(plan.tsconfig) ? api.parseConfigFile(plan.tsconfig) : undefined;
    result.diagnostics.push(...(config?.errors ?? []).map((diagnostic) => normalize(diagnostic)));
    const compilerOptions = {
      strict: true,
      target: ScriptTarget.ES2022,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      ...config?.options,
      noEmit: true,
      declaration: false,
      emitDeclarationOnly: false,
      incremental: false,
      composite: false,
    };
    const rootFiles = [...new Set([...(config?.fileNames ?? []), ...originals.keys()])];
    const testFiles = new Set(plan.tests.map((test) => test.file));
    const targetsByFile = new Map();
    for (const target of plan.targets) {
      const targets = targetsByFile.get(target.file) ?? [];
      targets.push(target);
      targetsByFile.set(target.file, targets);
    }

    const probeMaps = new Map();
    const probeFiles = new Map(originals);
    for (const [file, targets] of targetsByFile) {
      const edits = [];
      for (const target of targets) {
        const captures = target.captures.map((name) => `${JSON.stringify(name)}: ${name}`).join(', ');
        const prefix = `(void { ${JSON.stringify(markerName(target.id))}: 0${captures ? `, ${captures}` : ''} }, (`;
        edits.push({ pos: target.start, text: prefix, anchor: target, targetId: target.id, part: 'prefix', order: 1 });
        edits.push({ pos: target.end, text: '))', anchor: target, targetId: target.id, part: 'suffix', order: 0 });
      }
      const projection = project(originals.get(file), edits);
      probeMaps.set(file, projection);
      probeFiles.set(file, projection.text);
    }

    analysisSnapshot = api.createSnapshot({
      fileSystem: createFileSystemLayer([...probeFiles]),
      createPrograms: [{ rootFiles: rootFiles.filter((file) => !testFiles.has(file)), compilerOptions }],
    });
    const analysis = analysisSnapshot.operation.createdPrograms[0];
    const checker = analysis.getProject().checker;
    result.diagnostics.push(...diagnosticsOf(analysis, probeMaps));
    if (result.diagnostics.length) return { ...result, diagnostics: uniqueDiagnostics(result.diagnostics) };

    const contractsById = new Map();
    for (const target of plan.targets) {
      const sourceFile = analysis.getSourceFile(target.file);
      if (!sourceFile?.externalModuleIndicator) {
        result.diagnostics.push(pointDiagnostic(target, 90001, 'Targets must be in a TypeScript module with an import or export. A virtual export would change a global script\'s scope.'));
        continue;
      }
      const projection = probeMaps.get(target.file);
      const prefix = projection.inserted.find((edit) => edit.targetId === target.id && edit.part === 'prefix');
      const suffix = projection.inserted.find((edit) => edit.targetId === target.id && edit.part === 'suffix');
      const expressionStart = prefix.virtualEnd;
      const expressionEnd = suffix.virtualStart;
      let expression;
      let captureObject;
      walk(sourceFile, (node) => {
        if (node.getStart(sourceFile) === expressionStart && node.end === expressionEnd) expression = node;
        if (node.kind === SyntaxKind.ObjectLiteralExpression && node.properties[0]?.name?.text === markerName(target.id)) captureObject = node;
      });
      if (!expression || !captureObject) {
        result.diagnostics.push(pointDiagnostic(target, 90002, 'The target could not be matched in the virtual program. Rebuild the plan after changing source text.'));
        continue;
      }
      try {
        const contract = {
          id: target.id,
          result: printType(api, checker, checker.getTypeAtLocation(expression), sourceFile, expression),
          locals: Object.fromEntries(captureObject.properties.slice(1).map((property) => [
            property.name.text,
            printType(api, checker, checker.getTypeAtLocation(property.initializer), sourceFile, property.initializer),
          ])),
        };
        result.contracts.push(contract);
        contractsById.set(target.id, contract);
      } catch (error) {
        result.diagnostics.push(pointDiagnostic(target, 90003, `Cannot expose this point's types: ${error.message}`));
      }
    }
    if (result.diagnostics.length) return { ...result, diagnostics: uniqueDiagnostics(result.diagnostics) };

    const editsByFile = new Map();
    const addEdit = (file, edit) => {
      const edits = editsByFile.get(file) ?? [];
      edits.push(edit);
      editsByFile.set(file, edits);
    };
    for (const target of plan.targets) {
      const contract = contractsById.get(target.id);
      const locals = Object.entries(contract.locals).map(([name, type]) => `readonly ${JSON.stringify(name)}: ${type};`).join(' ');
      const text = `\nexport type ${aliasName(target.id)} = { result: ${contract.result}; locals: { ${locals} } };\n`;
      addEdit(target.file, { pos: originals.get(target.file).length, text, anchor: target });
    }
    const targetsById = new Map(plan.targets.map((target) => [target.id, target]));
    for (const test of plan.tests) {
      for (const point of test.points) {
        const target = targetsById.get(point.targetId);
        const text = `<import(${JSON.stringify(typeImport(test.file, target.file))}).${aliasName(target.id)}>`;
        addEdit(test.file, { pos: point.typeInsert, text, anchor: { start: point.callStart, end: point.callEnd } });
      }
    }
    const finalMaps = new Map();
    for (const [file, original] of originals) {
      const projection = project(original, editsByFile.get(file));
      finalMaps.set(file, projection);
      result.projections.set(file, projection.text);
    }
    finalSnapshot = api.createSnapshot({
      fileSystem: createFileSystemLayer([...result.projections]),
      createPrograms: [{ rootFiles, compilerOptions }],
    });
    result.diagnostics.push(...diagnosticsOf(finalSnapshot.operation.createdPrograms[0], finalMaps));
    result.diagnostics = uniqueDiagnostics(result.diagnostics);
    result.ok = result.diagnostics.length === 0;
    return result;
  } finally {
    finalSnapshot?.dispose();
    analysisSnapshot?.dispose();
    api.close();
  }
}
