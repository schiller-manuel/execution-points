import { existsSync, globSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { API } from 'typescript/sync'
import { type Node, NodeFlags, type SourceFile, SyntaxKind } from 'typescript/ast'

/**
 * A syntax node as this module reads it. The walk asks nodes of many kinds for the same few
 * fields, and a node of a kind that lacks one answers `undefined`.
 */
interface Syntax extends Node {
  readonly parent: Syntax
  forEachChild<T>(visitor: (node: Syntax) => T): T | undefined
  readonly name?: Syntax
  readonly propertyName?: Syntax
  readonly text?: string
  readonly expression?: Syntax
  readonly argumentExpression?: Syntax
  readonly left?: Syntax
  readonly operator?: SyntaxKind
  readonly operatorToken?: Syntax
  readonly questionDotToken?: Syntax
  readonly asteriskToken?: Syntax
  readonly body?: Syntax
  readonly initializer?: Syntax
  readonly parameters?: readonly Syntax[]
  readonly variableDeclaration?: Syntax
  readonly declarations?: readonly Syntax[]
  readonly declarationList?: Syntax
  readonly statements?: readonly Syntax[]
  readonly clauses?: readonly Syntax[]
  readonly elements?: readonly Syntax[]
  readonly externalModuleIndicator?: unknown
}

/** What points.ep holds, and where it was read from. */
export interface Manifest {
  readonly root: string
  readonly manifestPath: string
  readonly targets: readonly string[]
  readonly tsconfig?: string
  readonly $schema?: string
}

/** One selectable expression of a target module. */
export interface IndexedNode {
  readonly id: string
  readonly file: string
  readonly relativeFile: string
  readonly kind: 'CallExpression' | 'BinaryExpression' | 'ConditionalExpression'
  readonly inFunction: string | null
  readonly callee?: string
  readonly operator?: string
  readonly nth: number
  /** The line the expression starts on, counted from 1. */
  readonly line: number
  /** The expression's source on one line: see `excerpt`. */
  readonly text: string
  /** For a call made on an object, that object's source on one line: `cache` in `cache.get(key)`. */
  readonly object?: string
  readonly start: number
  readonly end: number
  /** Which of the file's homes evaluates the expression: see `homeKind`. */
  readonly home: number
  readonly startsStatement: boolean
  /** The locals that are initialized whenever the expression runs. */
  readonly captures: readonly string[]
}

/** A function, class, or variable declarator that has a selectable expression inside it. */
export interface IndexedContainer {
  readonly type: 'Function' | 'Class' | 'VariableDeclarator'
  /** The name it is declared under; a function or class assigned to a constant has the constant's name, an anonymous one has none. */
  readonly name: string
  /** The line it starts on, counted from 1. */
  readonly line: number
  /** The selectable expressions inside it, however deep, as indexes into the file's nodes. */
  readonly nodes: readonly number[]
  /** The containers inside it, however deep, as indexes into the file's containers. */
  readonly containers: readonly number[]
}

export interface IndexedFile {
  readonly file: string
  readonly relativeFile: string
  readonly source: string
  readonly nodes: readonly IndexedNode[]
  readonly containers: readonly IndexedContainer[]
  /** The blocks of ordinary functions: each decides once per call which form of its statements runs. */
  readonly bodies: ReadonlyArray<{ readonly home: number; readonly start: number; readonly end: number }>
  /** Where the file's leading directives end, or 0. */
  readonly directivesEnd: number
}

export interface TargetPlan {
  readonly root: string
  readonly tsconfig: string
  readonly files: IndexedFile[]
}

export interface TargetPlanOptions {
  readonly root?: string
  readonly targets?: readonly string[]
  readonly tsconfig?: string
  /** Text to index in place of what is on disk, by file. */
  readonly overrides?: ReadonlyMap<string, string>
  readonly api?: API
}

/** A place from which a function declaration is used, and the scope through which it is reached. */
interface Use {
  readonly pos: number
  readonly through: Scope | undefined
}

/** A local name. It is initialized from `readyAt` on, and inside a `switch` only within its own clause. */
interface VariableBinding {
  readonly readyAt: number
  readonly inClause?: Syntax
  home?: Scope
  readonly uses?: undefined
  readonly callers?: undefined
}

/** A function declaration: it exists as soon as its block is entered, and can run from its first use on. */
interface FunctionBinding {
  readonly readyAt: number
  readonly inClause?: undefined
  home?: Scope
  readonly uses: Use[]
  readonly callers: FunctionBinding[]
  reach?: Use[]
}

type Binding = VariableBinding | FunctionBinding

interface Scope {
  readonly node: Syntax
  readonly parent: Scope | undefined
  readonly names: Map<string, Binding>
  /** The function declaration this scope is the inside of. */
  readonly declares: FunctionBinding | undefined
}

const isAssignmentOp = (k: SyntaxKind): boolean => k >= SyntaxKind.FirstAssignment && k <= SyntaxKind.LastAssignment
const indexableKinds = new Set([SyntaxKind.CallExpression, SyntaxKind.BinaryExpression, SyntaxKind.ConditionalExpression])
let defaultApi: API | undefined
const getDefaultApi = (): API => (defaultApi ??= new API())

const isString = (value: unknown): boolean => typeof value === 'string'
/** What a manifest may hold, as points.schema.json describes it. */
const manifestKeys = new Map<string, (value: unknown) => boolean>([
  ['$schema', isString],
  ['tsconfig', isString],
  ['targets', (value) => Array.isArray(value) && value.every(isString)],
])

/** The manifest of a project: its targets and its tsconfig. Anything else in its place is refused by name. */
export function loadManifest(root: string = process.cwd(), file = 'points.ep'): Manifest {
  const manifestPath = resolve(root, file)
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`[execution-points] Cannot read the manifest ${manifestPath}: ${(error as Error).message}`)
  }
  // Only a JSON object has a key named "targets": a list, a text, or a number has none.
  const held = Object(manifest) as Record<string, unknown>
  const keys = Object.keys(held)
  if (!keys.includes('targets') || !keys.every((key) => manifestKeys.get(key)?.(held[key]))) {
    throw new Error(
      `[execution-points] ${manifestPath} is not a manifest: it must hold a JSON object with a "targets" array of paths, ` +
        'and may name a "tsconfig" and a "$schema" (see points.schema.json).',
    )
  }
  return { root: resolve(root), manifestPath, ...(held as Pick<Manifest, 'targets' | 'tsconfig' | '$schema'>) }
}

export function resolveTargetFiles(root: string, configuredTargets: readonly string[] = []): string[] {
  const resolved = new Set<string>()
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
const isSelectableExpression = (node: Syntax): boolean =>
  indexableKinds.has(node.kind) &&
  !isAssignment(node) &&
  !standsForAPlace(node) &&
  !continuesOptionalChain(node) &&
  !isTiedToItsFunction(node)

const isAssignment = (node: Syntax): boolean =>
  node.kind === SyntaxKind.BinaryExpression && isAssignmentOp(node.operatorToken!.kind)

/** Whether the code around the expression needs more than its value: a place to write to, or something to call. */
function standsForAPlace(node: Syntax): boolean {
  let cur = node
  while (wrapperKinds.has(cur.parent.kind)) cur = cur.parent
  const p = cur.parent
  const isPlace =
    (isAssignment(p) && p.left === cur) ||
    p.kind === SyntaxKind.DeleteExpression ||
    p.kind === SyntaxKind.PostfixUnaryExpression ||
    (p.kind === SyntaxKind.PrefixUnaryExpression &&
      [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(p.operator!))
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
function continuesOptionalChain(node: Syntax): boolean {
  const next = node.parent
  return Boolean(next.flags & NodeFlags.OptionalChain) && next.expression === node && !next.questionDotToken
}

/**
 * Whether the code awaits, yields, calls `super(...)`, evaluates code with a direct `eval`, or
 * imports, outside the functions it contains. Of a nested function, only what its name and
 * decorators compute runs here.
 */
function isTiedToItsFunction(part: Syntax): boolean {
  if (part.kind === SyntaxKind.AwaitExpression || part.kind === SyntaxKind.YieldExpression) return true
  if (part.kind === SyntaxKind.CallExpression) {
    const callee = part.expression!
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

const excerptLength = 72

/** Source text as a listing shows it: every run of whitespace as one space, cut to one line's width. */
export function excerpt(source: string): string {
  const text = source.replace(/\s+/g, ' ')
  return text.length > excerptLength ? `${text.slice(0, excerptLength - 1)}…` : text
}

/** What kind of container a node is for the expressions inside it, and under which name. */
function containerOf(node: Syntax, functionName: string | undefined): Pick<IndexedContainer, 'type' | 'name'> | undefined {
  if (functionName !== undefined) return { type: 'Function', name: functionName === '(anonymous)' ? '' : functionName }
  if (node.kind === SyntaxKind.ClassDeclaration || node.kind === SyntaxKind.ClassExpression) {
    const { parent } = node
    // A class without a name of its own takes the name of the constant it is assigned to.
    const assigned = parent.kind === SyntaxKind.VariableDeclaration && parent.name!.kind === SyntaxKind.Identifier ? parent.name!.text : undefined
    return { type: 'Class', name: node.name?.text ?? assigned ?? '' }
  }
  if (node.kind === SyntaxKind.VariableDeclaration && node.name!.kind === SyntaxKind.Identifier) {
    return { type: 'VariableDeclarator', name: node.name!.text! }
  }
  return undefined
}

function enclosingFunctionName(node: Syntax): string | undefined {
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
      if (parent.kind === SyntaxKind.VariableDeclaration && parent.name!.kind === SyntaxKind.Identifier) {
        return parent.name!.text
      }
      if (parent.kind === SyntaxKind.PropertyAssignment) {
        return parent.name!.text ?? '(anonymous)'
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
const runsItsOwnCode = new Set([...functionKinds, SyntaxKind.PropertyDeclaration, SyntaxKind.ClassStaticBlockDeclaration])

/**
 * Code that runs later than, or more often than, the code around it gets a home of its own:
 * `'body'` for the block of an ordinary function, whose every statement runs within one call,
 * and `'deferred'` for everything else that a call, a construction, or a resumption evaluates
 * (parameter defaults, expression bodies, generator and constructor bodies, field initializers).
 */
function homeKind(node: Syntax): 'body' | 'deferred' | undefined {
  if (functionKinds.has(node.kind) || node.kind === SyntaxKind.PropertyDeclaration) return 'deferred'
  const fn = node.parent
  if (node.kind !== SyntaxKind.Block || fn.body !== node || !functionKinds.has(fn.kind)) return undefined
  // A directive must stay the first statement of its function, so such a body is left whole.
  return fn.kind === SyntaxKind.Constructor || fn.asteriskToken || isDirective(node.statements![0]) ? undefined : 'body'
}

/** A string that stands as a statement of its own: a directive such as `'use strict'`, where it comes first. */
const isDirective = (statement: Syntax | undefined): boolean =>
  statement?.kind === SyntaxKind.ExpressionStatement && statement.expression!.kind === SyntaxKind.StringLiteral

/** Whether the expression begins an expression statement: only there can it follow a line that lacks its `;`. */
function startsStatement(node: Syntax, start: number, tree: SourceFile): boolean {
  let cur = node
  while (cur.parent.kind !== SyntaxKind.ExpressionStatement && cur.parent.getStart(tree) === start) cur = cur.parent
  return cur.parent.kind === SyntaxKind.ExpressionStatement
}

function callCalleeName(node: Syntax): string {
  const expr = node.expression!
  if (expr.kind === SyntaxKind.Identifier) return expr.text!
  if (expr.kind === SyntaxKind.PropertyAccessExpression) return expr.name!.text!
  if (expr.kind === SyntaxKind.ElementAccessExpression && expr.argumentExpression!.kind === SyntaxKind.StringLiteral) {
    return expr.argumentExpression!.text!
  }
  return '(anonymous)'
}

/** For a call made on an object, that object as the listing shows it. */
function calledOn(node: Syntax, source: string, bomOffset: number, tree: SourceFile): { object?: string } {
  const callee = node.expression!
  if (callee.kind !== SyntaxKind.PropertyAccessExpression && callee.kind !== SyntaxKind.ElementAccessExpression) return {}
  const object = callee.expression!
  return { object: excerpt(source.slice(object.getStart(tree) + bomOffset, object.end + bomOffset)) }
}

/** The names a binding name or pattern declares; an array pattern can leave an element out. */
function declaredNames(nameNode: Syntax | undefined, names: string[] = []): string[] {
  if (!nameNode) return names
  if (nameNode.kind === SyntaxKind.Identifier) names.push(nameNode.text!)
  else for (const element of nameNode.elements!) declaredNames(element.name, names)
  return names
}

/**
 * The names `node` declares for the code inside it, as `[name, binding]` pairs. A binding is
 * initialized from `readyAt` on. A function declaration exists as soon as its block is entered,
 * so its binding also collects where the function is used: it can run from its first use on.
 * Those bindings are kept in `functions`, by declaration. A `switch` is one scope, in which a
 * declaration is initialized only within its own clause.
 */
function declarationsOf(node: Syntax, functions: Map<Syntax, FunctionBinding>): Array<[string, Binding]> {
  const found: Array<[string, Binding]> = []
  const declare = (nameNode: Syntax | undefined, readyAt: number, inClause?: Syntax): void => {
    for (const name of declaredNames(nameNode)) found.push([name, { readyAt, inClause }])
  }
  for (const parameter of node.parameters ?? []) declare(parameter.name, parameter.end)
  if (node.variableDeclaration) declare(node.variableDeclaration.name, node.variableDeclaration.end)
  // Inside a class expression its name is the class, whatever the name means outside.
  if (node.kind === SyntaxKind.ClassExpression) declare(node.name, Infinity)
  if (node.initializer?.kind === SyntaxKind.VariableDeclarationList) {
    // The head of a loop. A loop over a collection initializes its names once the collection is evaluated.
    for (const declaration of node.initializer.declarations!) {
      declare(declaration.name, node.expression ? node.expression.end : declaration.end)
    }
  }
  const lists = node.kind === SyntaxKind.CaseBlock ? node.clauses! : node.statements && !isClause(node) ? [node] : []
  for (const list of lists) {
    const inClause = list === node ? undefined : list
    for (const statement of list.statements!) {
      if (statement.kind === SyntaxKind.FunctionDeclaration) {
        const binding: FunctionBinding = { readyAt: -1, uses: [], callers: [] }
        functions.set(statement, binding)
        found.push([statement.name!.text!, binding])
      } else if (statement.kind === SyntaxKind.ClassDeclaration) {
        declare(statement.name, statement.end, inClause)
      } else if (statement.kind === SyntaxKind.VariableStatement) {
        for (const declaration of statement.declarationList!.declarations!) {
          declare(declaration.name, declaration.end, inClause)
        }
      }
    }
  }
  return found
}

const isClause = (node: Syntax): boolean => node.kind === SyntaxKind.CaseClause || node.kind === SyntaxKind.DefaultClause

/** Whether code at `pos`, which reaches the binding's scope through the scope `through`, finds the binding initialized. */
const isInitialized = (binding: Binding, pos: number, through: Scope | undefined): boolean =>
  binding.readyAt <= pos && (!binding.inClause || binding.inClause === through!.node)

/** Every place from which the function declaration can be called: its own uses, and those of the functions that use it. */
function reachOf(fn: FunctionBinding, seen = new Set<FunctionBinding>()): Use[] {
  if (seen.has(fn)) return []
  seen.add(fn)
  return fn.uses.concat(...fn.callers.map((caller) => reachOf(caller, seen)))
}

/** Index all selectable expressions in a single target module using TypeScript 7.1's AST. */
export function indexTargetFile(file: string, source: string, root: string, api: API = getDefaultApi()): IndexedFile {
  const bomOffset = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const lease = api.createSourceFile(file, bomOffset ? source.slice(1) : source)
  try {
    const sourceFile = lease.sourceFile
    const tree = sourceFile as unknown as Syntax
    const relativeFile = relative(root, file).replaceAll('\\', '/')
    const fnStack: string[] = []
    const nthCounters = new Map<string, number>()
    const found: Array<{ node: Omit<IndexedNode, 'captures'>; at: number; scope: Scope }> = []
    const bodies: Array<{ home: number; start: number; end: number }> = []
    const containers: Array<{ type: IndexedContainer['type']; name: string; line: number; nodes: number[]; containers: number[] }> = []
    // The containers the walk is inside of, outermost first.
    const inside: typeof containers = []
    // Where each line after the first begins, in the text TypeScript reads.
    const lineStarts = [...(bomOffset ? source.slice(1) : source).matchAll(/\r\n|\r|\n/g)].map((ending) => ending.index + ending[0].length)
    const lineOf = (pos: number): number => lineStarts.findLastIndex((begin) => begin <= pos) + 2
    const homes = [0]
    let homeCount = 0
    const functions = new Map<Syntax, FunctionBinding>()

    /** The scope of the code inside `node`: the names it declares, and the function declaration it is. */
    const scopeOf = (node: Syntax, parent: Scope | undefined): Scope => {
      const scope: Scope = { node, parent, names: new Map(declarationsOf(node, functions)), declares: functions.get(node) }
      for (const binding of scope.names.values()) binding.home = scope
      return scope
    }

    /** Records a use of a function declaration: a function can run from its first use on. */
    const noteUse = (identifier: Syntax, from: Scope): void => {
      let through: Scope | undefined
      let caller: FunctionBinding | undefined
      for (let scope: Scope | undefined = from; scope; through = scope, scope = scope.parent) {
        const binding = scope.names.get(identifier.text!)
        if (binding) {
          if (!binding.uses) return
          // A use inside another function of the same scope happens whenever that function runs.
          if (caller?.home === scope) binding.callers.push(caller)
          else binding.uses.push({ pos: identifier.getStart(sourceFile), through })
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
    const capturesAt = (pos: number, from: Scope): string[] => {
      const decided = new Set<string>()
      const names: string[] = []
      let through: Scope | undefined
      let via: FunctionBinding | undefined
      for (let scope: Scope | undefined = from; scope; through = scope, scope = scope.parent) {
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

    const visit = (node: Syntax, outer?: Scope): void => {
      const fnName = enclosingFunctionName(node)
      if (fnName !== undefined) fnStack.push(fnName)
      const scope = scopeOf(node, outer)
      const home = homeKind(node)
      if (home) homes.push(++homeCount)
      if (home === 'body') {
        bodies.push({ home: homeCount, start: node.getStart(sourceFile) + bomOffset, end: node.end + bomOffset })
      }
      const container = containerOf(node, fnName)
      if (container) {
        for (const outer of inside) outer.containers.push(containers.length)
        const entered = { ...container, line: lineOf(node.getStart(sourceFile)), nodes: [], containers: [] }
        containers.push(entered)
        inside.push(entered)
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
        const treeStart = node.getStart(sourceFile)
        const start = treeStart + bomOffset
        const end = node.end + bomOffset
        const inFunction = fnStack.findLast((name) => name !== '(anonymous)') ?? (fnStack.length ? '(anonymous)' : null)
        const kind =
          node.kind === SyntaxKind.CallExpression
            ? 'CallExpression'
            : node.kind === SyntaxKind.BinaryExpression
              ? 'BinaryExpression'
              : 'ConditionalExpression'
        const extra: { callee?: string; operator?: string; object?: string } =
          kind === 'CallExpression'
            ? { callee: callCalleeName(node), ...calledOn(node, source, bomOffset, sourceFile) }
            : kind === 'BinaryExpression'
              ? {
                  operator: source.slice(
                    node.operatorToken!.getStart(sourceFile) + bomOffset,
                    node.operatorToken!.end + bomOffset,
                  ),
                }
              : {}
        const namePart = extra.callee ?? extra.operator ?? '?'
        const scopePrefix = `${relativeFile}#${inFunction ?? '<top>'}:${kind}:${namePart}`
        const nth = nthCounters.get(scopePrefix) ?? 0
        nthCounters.set(scopePrefix, nth + 1)
        const id = `${scopePrefix}:${nth}`

        for (const outer of inside) outer.nodes.push(found.length)
        found.push({
          node: {
            id,
            file,
            relativeFile,
            kind,
            inFunction,
            ...extra,
            nth,
            line: lineOf(treeStart),
            text: excerpt(source.slice(start, end)),
            start,
            end,
            home: homes.at(-1)!,
            startsStatement: startsStatement(node, treeStart, sourceFile),
          },
          at: treeStart,
          scope,
        })
      }

      node.forEachChild((child) => visit(child, scope))

      if (container) inside.pop()
      if (home) homes.pop()
      if (fnName !== undefined) fnStack.pop()
    }

    // A file with no import or export is a global script: nothing in it can be selected. What
    // the module itself declares is never a capture, so the walk starts below the file.
    if (tree.externalModuleIndicator) tree.forEachChild((child) => visit(child))
    // Captures wait until every use of every function is known.
    const nodes = found.map(({ node, at, scope }) => ({ ...node, captures: capturesAt(at, scope) }))
    // Where the file's leading directives end: they must stay its first statements.
    const statements = tree.statements!
    const leading = statements.findIndex((statement) => !isDirective(statement))
    const directivesEnd = leading ? statements.at(leading - 1)!.end + bomOffset : 0
    // A container with nothing to select inside it is of no use to a selector.
    const kept = containers.filter((container) => container.nodes.length)
    const listed = kept.map((container) => ({
      ...container,
      containers: container.containers.map((index) => kept.indexOf(containers[index]!)).filter((index) => index !== -1),
    }))
    return { file, relativeFile, source, nodes, containers: listed, bodies, directivesEnd }
  } finally {
    lease.dispose()
  }
}

/** Index all target modules configured in points.ep. */
export function buildTargetPlan(options: TargetPlanOptions): TargetPlan {
  const root = resolve(options.root ?? process.cwd())
  const overrides = options.overrides ?? new Map<string, string>()
  const read = (file: string): string => (overrides.has(file) ? overrides.get(file)! : readFileSync(file, 'utf8'))

  const files: IndexedFile[] = []
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
