import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import ts from 'typescript-ts6'
import { queryAst } from './query.mjs'

const packageName = 'execution-points-prototype'
const expressionKinds = new Set([
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.ElementAccessExpression,
  ts.SyntaxKind.ParenthesizedExpression,
])

function parse(file, source) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function bindingChecker(file, tree) {
  // Only lexical binding identity is needed. Reuse this parsed tree without
  // loading libraries or resolving the imported package and its dependencies.
  const options = { noResolve: true, noLib: true }
  const host = ts.createCompilerHost(options)
  host.getSourceFile = (requested) => (requested === file ? tree : undefined)
  host.fileExists = (requested) => requested === file
  host.readFile = (requested) => (requested === file ? tree.text : undefined)
  return ts.createProgram([file], options, host).getTypeChecker()
}

function fail(file, tree, node, message) {
  const pos = tree.getLineAndCharacterOfPosition(node.getStart(tree))
  throw new Error(`${file}:${pos.line + 1}:${pos.character + 1}: ${message}`)
}

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined
}

function readSpec(node, tree, file) {
  if (!ts.isObjectLiteralExpression(node)) fail(file, tree, node, 'point() requires a literal object in this prototype.')
  const values = new Map()
  for (const p of node.properties) {
    if (!ts.isPropertyAssignment(p)) fail(file, tree, p, 'Point properties must be literal property assignments.')
    const name = propertyName(p.name)
    if (!['file', 'query', 'capture'].includes(name) || values.has(name)) {
      fail(file, tree, p, `Unsupported or duplicated point property: ${name ?? p.name.getText(tree)}`)
    }
    values.set(name, p.initializer)
  }
  const spec = {}
  for (const name of ['file', 'query']) {
    const value = values.get(name)
    if (!value || !ts.isStringLiteralLike(value)) fail(file, tree, node, `point.${name} must be a string literal.`)
    spec[name] = value.text
  }
  const captures = values.get('capture')
  if (captures && !ts.isArrayLiteralExpression(captures)) fail(file, tree, captures, 'capture must be an array of literal binding names.')
  spec.capture = (captures?.elements ?? []).map((value) => {
    if (!ts.isStringLiteralLike(value)) fail(file, tree, value, 'Captured binding names must be string literals.')
    const probe = parse('binding.ts', `void ${value.text};`)
    const expr = probe.statements[0]?.expression?.expression
    if (!expr || !ts.isIdentifier(expr) || expr.text !== value.text || probe.parseDiagnostics.length) {
      fail(file, tree, value, `Capture requires an identifier name, received ${JSON.stringify(value.text)}.`)
    }
    return value.text
  })
  if (new Set(spec.capture).size !== spec.capture.length) fail(file, tree, captures, 'Capture names must be unique.')
  return spec
}

function isAssignment(operator) {
  return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment
}

function validateExpression(node, tree, file) {
  if (!expressionKinds.has(node.kind)) fail(file, tree, node, `Unsupported target kind ${ts.SyntaxKind[node.kind]}; select a value expression.`)
  if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) fail(file, tree, node, 'Assignment expressions are not supported by this first prototype.')
  let current = node
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent) ||
    ts.isNonNullExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent)
  ) {
    current = current.parent
  }
  const parent = current.parent
  if (
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === current) ||
    (ts.isTaggedTemplateExpression(parent) && parent.tag === current) ||
    (ts.isBinaryExpression(parent) && parent.left === current && isAssignment(parent.operatorToken.kind)) ||
    ts.isDeleteExpression(parent) ||
    ts.isPostfixUnaryExpression(parent) ||
    (ts.isPrefixUnaryExpression(parent) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator))
  ) {
    fail(file, tree, node, 'This position requires a reference, not just a value. Select the whole call or a value-producing expression.')
  }
  function visit(part) {
    if (
      [ts.SyntaxKind.AwaitExpression, ts.SyntaxKind.YieldExpression, ts.SyntaxKind.SuperKeyword].includes(part.kind) ||
      part.questionDotToken ||
      (part.flags & ts.NodeFlags.OptionalChain)
    ) {
      fail(file, tree, part, 'await/yield/super/optional-chain expressions need dedicated transforms and are not supported yet. Select the inner ordinary expression where possible.')
    }
    if (
      ts.isCallExpression(part) &&
      (part.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(part.expression) && part.expression.text === 'eval'))
    ) {
      fail(file, tree, part, 'Dynamic import and direct eval are not supported targets in this prototype.')
    }
    ts.forEachChild(part, visit)
  }
  visit(node)
}

export function resolveTestFiles(root, configuredFiles = []) {
  const resolved = new Set()
  for (const entry of configuredFiles) {
    if (/[*?[\]{}]/.test(entry)) {
      for (const match of globSync(entry, { cwd: root })) {
        resolved.add(resolve(root, match))
      }
    } else {
      resolved.add(resolve(root, entry))
    }
  }
  return [...resolved].sort()
}

/** Discover literal point declarations. All reads can be overlaid for compiler verification. */
export function buildPlan(options) {
  const root = resolve(options.root ?? process.cwd())
  const overrides = options.overrides ?? new Map()
  const tolerant = Boolean(options.tolerant)
  const read = (file) => (overrides.has(file) ? overrides.get(file) : readFileSync(file, 'utf8'))
  const targetByPosition = new Map()
  const tests = []
  const errors = []
  const testFilePaths = resolveTestFiles(root, options.testFiles ?? [])

  for (const file of testFilePaths) {
    if (!overrides.has(file) && !existsSync(file)) {
      if (tolerant) {
        errors.push({ file: relative(root, file), query: undefined, message: `Configured test file not found: ${relative(root, file)}` })
        continue
      }
      throw new Error(`Configured test file not found: ${file}`)
    }
    const source = read(file)
    const tree = parse(file, source)
    const checker = bindingChecker(file, tree)
    const importedBindings = new Set()
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== packageName) continue
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          if ((specifier.propertyName ?? specifier.name).text === 'point') {
            const binding = checker.getSymbolAtLocation(specifier.name)
            if (binding) importedBindings.add(binding)
          }
        }
      }
    }
    const points = []
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        importedBindings.has(checker.getSymbolAtLocation(node.expression))
      ) {
        let spec
        try {
          if (node.arguments.length !== 1 || node.typeArguments?.length) {
            fail(file, tree, node, 'Use point({ file, query, capture }) with one literal argument and no manual type arguments.')
          }
          spec = readSpec(node.arguments[0], tree, file)
          if (isAbsolute(spec.file)) fail(file, tree, node, 'Target paths are project-relative in this prototype.')
          const targetFile = resolve(root, spec.file)
          const relativeTarget = relative(root, targetFile)
          if (relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
            fail(file, tree, node, 'Targets must be inside the project root.')
          }
          if (targetFile === file) fail(file, tree, node, 'Target a separate application module in this first prototype.')
          if (!overrides.has(targetFile) && !existsSync(targetFile)) {
            fail(file, tree, node, `Target file does not exist: ${spec.file}`)
          }
          const targetSource = read(targetFile)
          const targetTree = parse(targetFile, targetSource)
          let matches
          try {
            matches = queryAst(targetTree, spec.query)
          } catch (error) {
            fail(file, tree, node, `Invalid AST selector: ${error.message}`)
          }
          if (matches.length !== 1) {
            fail(file, tree, node, `AST selector must match exactly one expression; matched ${matches.length} in ${spec.file}.`)
          }
          const selected = matches[0]
          validateExpression(selected, targetTree, targetFile)
          const start = selected.getStart(targetTree)
          const end = selected.end
          const position = `${targetFile}:${start}:${end}`
          let target = targetByPosition.get(position)
          if (!target) {
            const id = createHash('sha256')
              .update(relativeTarget + '\0' + targetSource + '\0' + start + ':' + end)
              .digest('hex')
              .slice(0, 12)
            target = {
              id,
              file: targetFile,
              relativeFile: spec.file,
              source: targetSource,
              start,
              end,
              captures: [...spec.capture],
              queries: new Set([spec.query]),
              kind: ts.SyntaxKind[selected.kind],
            }
            targetByPosition.set(position, target)
          } else {
            for (const cap of spec.capture) {
              if (!target.captures.includes(cap)) target.captures.push(cap)
            }
            target.queries.add(spec.query)
          }
          points.push({
            targetId: target.id,
            spec,
            callStart: node.getStart(tree),
            callEnd: node.end,
            typeInsert: node.expression.end,
            runtimeInsert: node.arguments[0].end,
          })
        } catch (error) {
          if (!tolerant) throw error
          errors.push({
            file: spec?.file,
            query: spec?.query,
            testFile: file,
            message: error.message.replace(/^.*?:\d+:\d+:\s*/, ''),
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
    tests.push({ file, source, points })
  }

  const targets = [...targetByPosition.values()].map((target) => ({
    ...target,
    queries: [...target.queries],
  }))

  const overlappingIds = new Set()
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      const a = targets[i]
      const b = targets[j]
      if (a.file === b.file && a.start < b.end && b.start < a.end) {
        const message = `Overlapping target expressions in ${a.relativeFile} are not supported yet.`
        if (!tolerant) throw new Error(message)
        overlappingIds.add(a.id)
        overlappingIds.add(b.id)
        for (const t of [a, b]) {
          for (const q of t.queries) {
            errors.push({ file: t.relativeFile, query: q, message })
          }
        }
      }
    }
  }

  const validTargets = overlappingIds.size
    ? targets.filter((target) => !overlappingIds.has(target.id))
    : targets

  if (!tolerant && !validTargets.length) {
    throw new Error('No point() declarations found. Import point from execution-points-prototype and use literal selectors.')
  }

  return {
    root,
    tsconfig: resolve(root, options.tsconfig ?? 'tsconfig.json'),
    tests,
    targets: validTargets,
    errors,
  }
}
