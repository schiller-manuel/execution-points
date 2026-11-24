import { existsSync, globSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { API } from 'typescript/sync'
import { NodeFlags, SyntaxKind } from 'typescript/ast'

const isAssignmentOp = (k) => k >= SyntaxKind.FirstAssignment && k <= SyntaxKind.LastAssignment
const indexableKinds = new Set([
  SyntaxKind.CallExpression,
  SyntaxKind.BinaryExpression,
  SyntaxKind.ConditionalExpression,
])
let defaultApi
const getDefaultApi = () => (defaultApi ??= new API())

export function loadManifest(root = process.cwd(), file = 'points.ep') {
  const manifestPath = resolve(root, file)
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return { root: resolve(root), manifestPath, ...raw }
}

export function resolveTargetFiles(root, configuredTargets = []) {
  const resolved = new Set()
  for (const entry of configuredTargets) {
    if (/[*?[\]{}]/.test(entry)) {
      for (const match of globSync(entry, { cwd: root })) resolved.add(resolve(root, match))
    } else {
      resolved.add(resolve(root, entry))
    }
  }
  return [...resolved].sort()
}

const wrapperKinds = new Set([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.TypeAssertionExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.SatisfiesExpression,
])

/**
 * A test can select a call, a binary operation that does not assign, or a ternary, unless
 * moving it into a function of its own, which is how it is intercepted, would change what the
 * code does.
 */
const isSelectableExpression = (node) =>
  indexableKinds.has(node.kind) &&
  !isAssignment(node) &&
  !standsForAPlace(node) &&
  !continuesOptionalChain(node) &&
  !isTiedToItsFunction(node)

const isAssignment = (node) => node.kind === SyntaxKind.BinaryExpression && isAssignmentOp(node.operatorToken.kind)

/** Whether the code around the expression needs more than its value: a place to write to, or something to call. */
function standsForAPlace(node) {
  let cur = node
  while (wrapperKinds.has(cur.parent.kind)) cur = cur.parent
  const p = cur.parent
  const isPlace =
    (isAssignment(p) && p.left === cur) ||
    p.kind === SyntaxKind.DeleteExpression ||
    p.kind === SyntaxKind.PostfixUnaryExpression ||
    (p.kind === SyntaxKind.PrefixUnaryExpression &&
      [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(p.operator))
  const isCalled =
    ((p.kind === SyntaxKind.CallExpression || p.kind === SyntaxKind.NewExpression) && p.expression === cur) ||
    p.kind === SyntaxKind.TaggedTemplateExpression
  // The result of a call carries no receiver, so a call can be replaced where it is called.
  return isPlace || (isCalled && node.kind !== SyntaxKind.CallExpression)
}

/**
 * Whether an optional chain goes on behind the expression without a `?.` of its own: such a
 * chain ends where the expression yields nothing, which a function of its own would undo.
 */
function continuesOptionalChain(node) {
  const next = node.parent
  return Boolean(next.flags & NodeFlags.OptionalChain) && next.expression === node && !next.questionDotToken
}

/**
 * Whether the code awaits, yields, calls `super(...)`, evaluates code with a direct `eval`, or
 * imports, outside the functions it contains. Of a nested function, only what its name and
 * decorators compute runs here.
 */
function isTiedToItsFunction(part) {
  if (part.kind === SyntaxKind.AwaitExpression || part.kind === SyntaxKind.YieldExpression) return true
  if (part.kind === SyntaxKind.CallExpression) {
    const callee = part.expression
    if (
      callee.kind === SyntaxKind.SuperKeyword ||
      callee.kind === SyntaxKind.ImportKeyword ||
      (callee.kind === SyntaxKind.Identifier && callee.text === 'eval')
    ) {
      return true
    }
  }
  const runsLater = runsItsOwnCode.has(part.kind)
  return Boolean(
    part.forEachChild(
      (child) =>
        !(runsLater && (child === part.body || child === part.initializer || child.kind === SyntaxKind.Parameter)) &&
        isTiedToItsFunction(child),
    ),
  )
}

function enclosingFunctionName(node) {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      return node.name?.text ?? '(anonymous)'
    case SyntaxKind.Constructor:
      return 'constructor'
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction: {
      if (node.name) return node.name.text
      const { parent } = node
      if (parent.kind === SyntaxKind.VariableDeclaration && parent.name.kind === SyntaxKind.Identifier) {
        return parent.name.text
      }
      if (parent.kind === SyntaxKind.PropertyAssignment) {
        return parent.name.text ?? '(anonymous)'
      }
      return '(anonymous)'
    }
    default:
      return undefined
  }
}

const functionKinds = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
])
/** What does not run where it is written: a function's body and parameters, a field's initializer, a static block. */
const runsItsOwnCode = new Set([
  ...functionKinds,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.ClassStaticBlockDeclaration,
])

/**
 * Code that runs later than, or more often than, the code around it gets a home of its own:
 * `'body'` for the block of an ordinary function, whose every statement runs within one call,
 * and `'deferred'` for everything else that a call, a construction, or a resumption evaluates
 * (parameter defaults, expression bodies, generator and constructor bodies, field initializers).
 */
function homeKind(node) {
  if (functionKinds.has(node.kind) || node.kind === SyntaxKind.PropertyDeclaration) return 'deferred'
  const fn = node.parent
  if (node.kind !== SyntaxKind.Block || fn.body !== node || !functionKinds.has(fn.kind)) return undefined
  // A directive must stay the first statement of its function, so such a body is left whole.
  const first = node.statements[0]
  const hasDirective =
    first?.kind === SyntaxKind.ExpressionStatement && first.expression.kind === SyntaxKind.StringLiteral
  return fn.kind === SyntaxKind.Constructor || fn.asteriskToken || hasDirective ? undefined : 'body'
}

/** Whether the expression begins an expression statement: only there can it follow a line that lacks its `;`. */
function startsStatement(node, start, tree) {
  let cur = node
  while (cur.parent.kind !== SyntaxKind.ExpressionStatement && cur.parent.getStart(tree) === start) cur = cur.parent
  return cur.parent.kind === SyntaxKind.ExpressionStatement
}

function callCalleeName(node) {
  const expr = node.expression
  if (expr.kind === SyntaxKind.Identifier) return expr.text
  if (expr.kind === SyntaxKind.PropertyAccessExpression) return expr.name.text
  if (expr.kind === SyntaxKind.ElementAccessExpression && expr.argumentExpression.kind === SyntaxKind.StringLiteral) {
    return expr.argumentExpression.text
  }
  return '(anonymous)'
}

/** The names a binding name or pattern declares; an array pattern can leave an element out. */
function declaredNames(nameNode, names = []) {
  if (!nameNode) return names
  if (nameNode.kind === SyntaxKind.Identifier) names.push(nameNode.text)
  else for (const element of nameNode.elements) declaredNames(element.name, names)
  return names
}

/**
 * The names `node` declares for the code inside it, as `[name, binding]` pairs. A binding is
 * initialized from `readyAt` on. A function declaration exists as soon as its block is entered,
 * so its binding also collects where the function is used: it can run from its first use on.
 * Those bindings are kept in `functions`, by declaration. A `switch` is one scope, in which a
 * declaration is initialized only within its own clause.
 */
function declarationsOf(node, functions) {
  const found = []
  const declare = (nameNode, readyAt, inClause) => {
    for (const name of declaredNames(nameNode)) found.push([name, { readyAt, inClause }])
  }
  for (const parameter of node.parameters ?? []) declare(parameter.name, parameter.end)
  if (node.variableDeclaration) declare(node.variableDeclaration.name, node.variableDeclaration.end)
  // Inside a class expression its name is the class, whatever the name means outside.
  if (node.kind === SyntaxKind.ClassExpression) declare(node.name, Infinity)
  if (node.initializer?.kind === SyntaxKind.VariableDeclarationList) {
    // The head of a loop. A loop over a collection initializes its names once the collection is evaluated.
    for (const declaration of node.initializer.declarations) {
      declare(declaration.name, node.expression ? node.expression.end : declaration.end)
    }
  }
  const lists = node.kind === SyntaxKind.CaseBlock ? node.clauses : node.statements && !isClause(node) ? [node] : []
  for (const list of lists) {
    const inClause = list === node ? undefined : list
    for (const statement of list.statements) {
      if (statement.kind === SyntaxKind.FunctionDeclaration) {
        const binding = { readyAt: -1, uses: [], callers: [] }
        functions.set(statement, binding)
        found.push([statement.name.text, binding])
      } else if (statement.kind === SyntaxKind.ClassDeclaration) {
        declare(statement.name, statement.end, inClause)
      } else if (statement.kind === SyntaxKind.VariableStatement) {
        for (const declaration of statement.declarationList.declarations) {
          declare(declaration.name, declaration.end, inClause)
        }
      }
    }
  }
  return found
}

const isClause = (node) => node.kind === SyntaxKind.CaseClause || node.kind === SyntaxKind.DefaultClause

/** Whether code at `pos`, which reaches the binding's scope through the scope `through`, finds the binding initialized. */
const isInitialized = (binding, pos, through) =>
  binding.readyAt <= pos && (!binding.inClause || binding.inClause === through.node)

/** Every place from which the function declaration can be called: its own uses, and those of the functions that use it. */
function reachOf(fn, seen = new Set()) {
  if (seen.has(fn)) return []
  seen.add(fn)
  return fn.uses.concat(...fn.callers.map((caller) => reachOf(caller, seen)))
}

/** Index all selectable expressions in a single target module using TypeScript 7.1's AST. */
export function indexTargetFile(file, source, root, api = getDefaultApi()) {
  const bomOffset = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const lease = api.createSourceFile(file, bomOffset ? source.slice(1) : source)
  try {
    const tree = lease.sourceFile
    const relativeFile = relative(root, file).replaceAll('\\', '/')
    const fnStack = []
    const nthCounters = new Map()
    const found = []
    const bodies = []
    const homes = [0]
    let homeCount = 0
    const functions = new Map()

    /** The scope of the code inside `node`: the names it declares, and the function declaration it is. */
    const scopeOf = (node, parent) => {
      const scope = { node, parent, names: new Map(declarationsOf(node, functions)), declares: functions.get(node) }
      for (const binding of scope.names.values()) binding.home = scope
      return scope
    }

    /** Records a use of a function declaration: a function can run from its first use on. */
    const noteUse = (identifier, from) => {
      let through
      let caller
      for (let scope = from; scope; through = scope, scope = scope.parent) {
        const binding = scope.names.get(identifier.text)
        if (binding) {
          if (!binding.uses) return
          // A use inside another function of the same scope happens whenever that function runs.
          if (caller?.home === scope) binding.callers.push(caller)
          else binding.uses.push({ pos: identifier.getStart(tree), through })
          return
        }
        caller = scope.declares ?? caller
      }
    }

    /**
     * The local names that are initialized whenever the code at `pos` runs. The innermost
     * declaration of a name decides. Inside a function declaration, the names of the scope
     * that holds it are initialized only if they are at every place the function can be
     * called from.
     */
    const capturesAt = (pos, from) => {
      const decided = new Set()
      const names = []
      let through
      let via
      for (let scope = from; scope; through = scope, scope = scope.parent) {
        for (const [name, binding] of scope.names) {
          if (decided.has(name)) continue
          decided.add(name)
          const ready = via
            ? (via.reach ??= reachOf(via)).every((use) => isInitialized(binding, use.pos, use.through))
            : isInitialized(binding, pos, through)
          if (ready) names.push(name)
        }
        if (via?.home === scope) via = undefined
        via = scope.declares ?? via
      }
      return names.sort()
    }

    const visit = (node, outer) => {
      const fnName = enclosingFunctionName(node)
      if (fnName !== undefined) fnStack.push(fnName)
      const scope = scopeOf(node, outer)
      const home = homeKind(node)
      if (home) homes.push(++homeCount)
      if (home === 'body') {
        bodies.push({ home: homeCount, start: node.getStart(tree) + bomOffset, end: node.end + bomOffset })
      }

      // A name that is read, as opposed to a name that is declared or that names a property.
      if (
        node.kind === SyntaxKind.Identifier &&
        (node.parent.name !== node || node.parent.kind === SyntaxKind.ShorthandPropertyAssignment) &&
        node.parent.propertyName !== node
      ) {
        noteUse(node, scope)
      }

      if (isSelectableExpression(node)) {
        const treeStart = node.getStart(tree)
        const start = treeStart + bomOffset
        const end = node.end + bomOffset
        const inFunction =
          fnStack.findLast((name) => name !== '(anonymous)') ?? (fnStack.length ? '(anonymous)' : null)
        const kind =
          node.kind === SyntaxKind.CallExpression
            ? 'CallExpression'
            : node.kind === SyntaxKind.BinaryExpression
              ? 'BinaryExpression'
              : 'ConditionalExpression'
        const extra =
          kind === 'CallExpression'
            ? { callee: callCalleeName(node) }
            : kind === 'BinaryExpression'
              ? {
                  operator: source.slice(
                    node.operatorToken.getStart(tree) + bomOffset,
                    node.operatorToken.end + bomOffset,
                  ),
                }
              : {}
        const namePart = extra.callee ?? extra.operator ?? '?'
        const scopePrefix = `${relativeFile}#${inFunction ?? '<top>'}:${kind}:${namePart}`
        const nth = nthCounters.get(scopePrefix) ?? 0
        nthCounters.set(scopePrefix, nth + 1)
        const id = `${scopePrefix}:${nth}`

        found.push({
          node: {
            id,
            file,
            relativeFile,
            kind,
            inFunction,
            ...extra,
            nth,
            start,
            end,
            home: homes.at(-1),
            startsStatement: startsStatement(node, treeStart, tree),
          },
          at: treeStart,
          scope,
        })
      }

      node.forEachChild((child) => visit(child, scope))

      if (home) homes.pop()
      if (fnName !== undefined) fnStack.pop()
    }

    // A file with no import or export is a global script: nothing in it can be selected. What
    // the module itself declares is never a capture, so the walk starts below the file.
    if (tree.externalModuleIndicator) tree.forEachChild((child) => visit(child))
    // Captures wait until every use of every function is known.
    const nodes = found.map(({ node, at, scope }) => ({ ...node, captures: capturesAt(at, scope) }))
    return { file, relativeFile, source, nodes, bodies }
  } finally {
    lease.dispose()
  }
}

/** Index all target modules configured in points.ep. */
export function buildTargetPlan(options) {
  const root = resolve(options.root ?? process.cwd())
  const overrides = options.overrides ?? new Map()
  const read = (file) => (overrides.has(file) ? overrides.get(file) : readFileSync(file, 'utf8'))

  const files = []
  for (const file of resolveTargetFiles(root, options.targets ?? [])) {
    if (!overrides.has(file) && !existsSync(file)) continue
    files.push(indexTargetFile(file, read(file), root, options.api))
  }
  return {
    root,
    tsconfig: resolve(root, options.tsconfig ?? 'tsconfig.json'),
    files,
  }
}
