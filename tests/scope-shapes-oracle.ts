/**
 * Scope shapes for the capture law of the discovery oracle. A shape is a short list of
 * instructions that builds one function out of nested scopes: declarations, blocks, loops,
 * `switch` statements, hoisted functions, classes, and the calls that decide in which order
 * the code runs. Wherever an instruction would not be legal JavaScript (a second declaration
 * of a name in one scope, a `case` outside a `switch`), it is dropped.
 *
 * Every point is a call `at(n, value)`. The same program is written twice: as the target that
 * discovery indexes, and as the truth program, in which each point also receives a way to read
 * every name of the program. Running the truth program asks JavaScript itself which names can
 * be read at each point.
 *
 * This file registers no tests.
 */
import fc from 'fast-check'

export const SCOPE_OPS = [
  'let',
  'point',
  'call',
  'member',
  'function',
  'arrow',
  'block',
  'loop',
  'switch',
  'case',
  'class',
  'try',
  'destructure',
  'close',
] as const
export type ScopeOpKind = (typeof SCOPE_OPS)[number]

/** `n` picks a name, `k` picks a variant of the instruction. */
export interface ScopeOp {
  op: ScopeOpKind
  n: number
  k: number
}

export interface ScopeShape {
  ops: ReadonlyArray<ScopeOp>
  /** Whether the module itself declares one of the names the function uses. */
  moduleDeclaresName: boolean
}

// Declarations, points, and calls are what the law is about, so they come most often.
const OP_WEIGHTS: Record<ScopeOpKind, number> = {
  let: 5,
  point: 5,
  call: 5,
  function: 4,
  close: 4,
  switch: 2,
  case: 3,
  class: 2,
  block: 1,
  loop: 1,
  arrow: 1,
  try: 1,
  destructure: 1,
  member: 1,
}

export const scopeShapeArbitrary: fc.Arbitrary<ScopeShape> = fc.record({
  ops: fc.array(
    fc.record({
      op: fc.oneof(...SCOPE_OPS.map((op) => ({ weight: OP_WEIGHTS[op], arbitrary: fc.constant(op) }))),
      n: fc.nat({ max: 2 }),
      k: fc.nat({ max: 4 }),
    }),
    { maxLength: 22, size: 'max' },
  ),
  moduleDeclaresName: fc.boolean(),
})

const NAMES = ['a', 'b', 'c'] as const
const MODULE_VALUE = 'module'
const MAX_DEPTH = 4
const MAX_SWITCHES = 2
const MAX_CLAUSES = 3

interface Frame {
  close: string
  /** Names this scope already declares; a second declaration would not compile. */
  declared: Set<string>
  /** Functions declared here: each is called once more where the scope ends. */
  functions: Array<string>
  /** For a `switch`: its number, and where its clause headers stand in the output. */
  switch?: { index: number; headers: Array<number> }
  /** For a member of a class declaration: the class's identity, and its first use once it exists. */
  classId?: number
  firstUse?: string
  /** Whether this is the body of a function declaration. */
  hoisted?: boolean
}

export interface ScopePoint {
  /** The classes whose bodies enclose the point: a class's own name is not offered inside it. */
  classes: ReadonlyArray<number>
  /** Whether the point lies in a clause of a `switch`, and whether it lies in a function declaration. */
  inSwitch: boolean
  inFunction: boolean
}

export interface ScopePlan {
  /** The module discovery indexes. */
  target: string
  /** The same module, with a way to read every local name handed to every point. */
  truth: string
  points: ReadonlyArray<ScopePoint>
  /** Every local name of the program. */
  locals: ReadonlyArray<string>
  /** The number of clauses of each `switch`: the program is run once for every combination. */
  clauseCounts: ReadonlyArray<number>
  /** What the program contains, for the reach of the law. */
  has: ReadonlySet<string>
}

type Piece = string | { point: number; value: string }

/** Turns the instructions into the two programs. */
export function planScopeShape(shape: ScopeShape): ScopePlan {
  // A point is a piece of its own, because the two programs write it differently.
  const pieces: Array<Piece> = []
  const points: Array<ScopePoint> = []
  const locals = new Set<string>(NAMES)
  const clauseCounts: Array<number> = []
  const has = new Set<string>()
  const stack: Array<Frame> = [{ close: '}', declared: new Set(), functions: [] }]
  let nextId = 1

  const top = () => stack.at(-1)!
  const emit = (text: string) => pieces.push(text)
  const point = (value = '0') => {
    points.push({
      classes: stack.flatMap((frame) => (frame.classId === undefined ? [] : [frame.classId])),
      inSwitch: stack.some((frame) => frame.switch),
      inFunction: stack.some((frame) => frame.hoisted),
    })
    pieces.push({ point: points.length - 1, value })
  }
  const declare = (name: string) => {
    if (top().declared.has(name)) return false
    top().declared.add(name)
    locals.add(name)
    return true
  }
  const open = (frame: Partial<Frame> & { close: string }) =>
    stack.push({ declared: new Set(), functions: [], ...frame })
  const close = () => {
    const frame = stack.pop()!
    for (const name of frame.functions) emit(`call(() => ${name});`)
    if (frame.switch) pieces[frame.switch.headers.at(-1)!] = 'default:'
    emit(frame.close)
    if (frame.firstUse !== undefined) {
      // A point that touches the closing brace of the class, then the class's first use.
      point()
      emit(`;${frame.firstUse}`)
    }
  }

  for (const { op, n, k } of shape.ops) {
    const name = NAMES[n % NAMES.length]!
    const other = NAMES[(n + 1) % NAMES.length]!
    const third = NAMES[(n + 2) % NAMES.length]!
    const opens = ['function', 'arrow', 'block', 'loop', 'switch', 'class', 'try'].includes(op)
    if (opens && stack.length > MAX_DEPTH) continue

    switch (op) {
      case 'let':
        if (!declare(name)) break
        // The point of the second form runs while the name it initializes is still uninitialized.
        if (k % 2) {
          emit(`const ${name} = `)
          point(String(nextId++))
          emit(';')
        } else emit(`let ${name} = ${nextId++};`)
        break
      case 'point':
        point()
        emit(';')
        break
      case 'call':
        // Calls what the name is at this place, if it is a function: read directly, or through an object.
        emit(k % 2 ? `call(() => ({ ${name} }).${name});` : `call(() => ${name});`)
        break
      case 'member':
        // A property that only shares a function's name is not a use of the function.
        emit(k % 2 ? `({ ${name}: 0 }).${name};` : `{ const { ${name}: unused${nextId++} } = { ${name}: 0 }; }`)
        break
      case 'function': {
        if (!declare(name)) break
        top().functions.push(name)
        has.add('function')
        emit(`function ${name}(`)
        const params = new Set<string>()
        if (k % 3 >= 1) {
          params.add(other)
          emit(`${other} = `)
          point(String(nextId++))
        }
        if (k % 3 === 2) {
          params.add(third)
          emit(`, ${third} = `)
          point(String(nextId++))
          has.add('parameter-defaults')
        }
        emit(') {')
        open({ close: '}', declared: params, hoisted: true })
        break
      }
      case 'arrow':
        if (k % 2) {
          emit(`((${name} = `)
          point(String(nextId++))
          emit(') => {')
          open({ close: '})();', declared: new Set([name]) })
        } else {
          emit('(() => {')
          open({ close: '})();' })
        }
        break
      case 'block':
        emit('{')
        open({ close: '}' })
        break
      case 'loop': {
        const flag = `once${nextId++}`
        has.add('loop')
        if (k % 5 === 0 || k % 5 === 2) {
          // The loop's own name is uninitialized while the loop's subject is evaluated.
          emit(`for (const ${name} ${k % 5 ? 'in' : 'of'} `)
          point(k % 5 ? `{ key: ${nextId++} }` : `[${nextId++}]`)
          emit(') {')
        } else if (k % 5 === 1) {
          locals.add(flag)
          emit(`for (let ${name} = `)
          point(String(nextId++))
          emit(`, ${flag} = true; `)
          point(flag)
          emit(`; ${flag} = false) {`)
        } else {
          // A loop that names nothing new: over a name that exists already, or with an empty head.
          declare(flag)
          emit(k % 5 === 3 ? `let ${flag} = 0; for (${flag} of ` : `let ${flag} = true; for (; `)
          point(k % 5 === 3 ? `[${nextId++}]` : flag)
          emit(k % 5 === 3 ? ') {' : `; ${flag} = false) {`)
        }
        open({ close: '}' })
        break
      }
      case 'switch':
        if (clauseCounts.length >= MAX_SWITCHES) {
          emit('{')
          open({ close: '}' })
          break
        }
        has.add('switch')
        emit(`switch (sel(${clauseCounts.length})) {`)
        open({ close: '}', switch: { index: clauseCounts.length, headers: [pieces.length] } })
        clauseCounts.push(1)
        emit('case 0:')
        break
      case 'case': {
        const frame = top().switch
        if (!frame || frame.headers.length >= MAX_CLAUSES) break
        // Without the `break`, the clause before runs on into this one.
        if (k % 2 === 0) emit('break;')
        frame.headers.push(pieces.length)
        emit(`case ${frame.headers.length - 1}:`)
        clauseCounts[frame.index] = frame.headers.length
        has.add('second-clause')
        break
      }
      case 'class': {
        const id = nextId++
        const expression = k % 5 === 4
        if (!expression && !declare(name)) break
        has.add('class')
        emit(expression ? `(class ${name}` : `class ${name}`)
        if (k % 5 >= 3) {
          // The class's name is uninitialized while its `extends` clause is evaluated.
          emit(' extends ')
          point('Object')
        }
        emit(` { static $ = ${id}; `)
        if (expression) {
          emit('static {')
          open({ close: '} });', classId: id })
        } else if (k % 5 === 1) {
          emit('static {')
          open({ close: '} }', classId: id, firstUse: '' })
        } else if (k % 5 === 2) {
          emit('f = (() => {')
          open({ close: '})() }', classId: id, firstUse: `new ${name}();` })
        } else {
          emit('m() {')
          open({ close: '} }', classId: id, firstUse: `new ${name}().m();` })
        }
        break
      }
      case 'try':
        emit(`try { throw ${nextId++} } catch (${name}) {`)
        open({ close: '}', declared: new Set([name]) })
        has.add('catch')
        break
      case 'destructure':
        if (top().declared.has(name) || top().declared.has(other)) break
        declare(name)
        declare(other)
        emit(`const { x: ${name}, y: [, ${other}] } = `)
        point(`{ x: ${nextId++}, y: [0, ${nextId++}] }`)
        emit(';')
        has.add('destructure')
        break
      case 'close':
        if (stack.length > 1) close()
        break
    }
  }
  while (stack.length) close()

  const moduleNames = shape.moduleDeclaresName ? ['outside', NAMES[2]] : ['outside']
  const header = moduleNames.map((name) => `const ${name} = '${MODULE_VALUE}';\n`).join('')
  const readers = `{ ${[...locals].map((name) => `${name}: () => ${name}`).join(', ')} }`
  const write = (truth: boolean) =>
    `${header}export function run() {${pieces
      .map((piece) =>
        typeof piece === 'string' ? piece : `at(${piece.point}, ${piece.value}${truth ? `, ${readers}` : ''})`,
      )
      .join('')}\n`
  return { target: write(false), truth: write(true), points, locals: [...locals], clauseCounts, has }
}

/** Every combination of clauses that the program's `switch` statements can enter. */
export function selections(clauseCounts: ReadonlyArray<number>): Array<Array<number>> {
  return clauseCounts.reduce<Array<Array<number>>>(
    (all, count) => all.flatMap((chosen) => Array.from({ length: count }, (_, clause) => [...chosen, clause])),
    [[]],
  )
}

const WORK_LIMIT = 20_000

/**
 * Runs one of the two programs once for every combination of clauses. `at` is called at every
 * point. `call(get)` calls what `get()` yields if that is a function of the program that is not
 * running already, so that every use of a function's name is a call, as early as it can be.
 */
export function runScopeProgram(
  source: string,
  clauseCounts: ReadonlyArray<number>,
  at: (point: number, value: unknown, readers?: Record<string, () => unknown>) => unknown,
  extra: Record<string, unknown> = {},
) {
  let work = 0
  const running = new Set<unknown>()
  const call = (get: () => unknown) => {
    let callee: unknown
    try {
      callee = get()
    } catch {
      return
    }
    if (typeof callee !== 'function' || Object.hasOwn(callee, '$') || running.has(callee)) return
    if ((work += 1) > WORK_LIMIT) throw new Error('scope program: too many calls')
    running.add(callee)
    try {
      ;(callee as () => void)()
    } finally {
      running.delete(callee)
    }
  }
  let selection: ReadonlyArray<number> = []
  const names = ['at', 'call', 'sel', ...Object.keys(extra)]
  const run = new Function(...names, `'use strict';\n${source.replace('export function', 'function')}\nreturn run`)(
    at,
    call,
    (index: number) => selection[index],
    ...Object.values(extra),
  ) as () => void
  for (selection of selections(clauseCounts)) run()
}

export interface PointAnswer {
  /** The local names that could be read every time the program reached the point, sorted. */
  readable: Array<string>
  /** The names that were uninitialized at the point at least once. */
  uninitializedOnce: Array<string>
  /** The names that were uninitialized at the point at least once, and readable at least once. */
  dependsOnOrder: Array<string>
}

/**
 * JavaScript's own answer for each point. A name that reads the module's own binding is not a
 * local, and the name of a class is not offered inside that class.
 */
export function askJavaScript(plan: ScopePlan): Array<PointAnswer | 'never reached'> {
  const tally = plan.points.map(() => ({ reached: 0, read: new Map<string, number>(), dead: new Set<string>() }))
  runScopeProgram(plan.truth, plan.clauseCounts, (index, value, readers) => {
    const point = tally[index]!
    point.reached += 1
    for (const name of plan.locals) {
      let seen: unknown
      try {
        seen = readers![name]!()
      } catch (error) {
        if (/before initialization/.test((error as Error).message)) point.dead.add(name)
        continue
      }
      const ownClass = typeof seen === 'function' && plan.points[index]!.classes.includes((seen as { $?: number }).$!)
      if (seen !== MODULE_VALUE && !ownClass) point.read.set(name, (point.read.get(name) ?? 0) + 1)
    }
    return value
  })
  return tally.map(({ reached, read, dead }) =>
    reached
      ? {
          readable: plan.locals.filter((name) => read.get(name) === reached).sort(),
          uninitializedOnce: [...dead].sort(),
          dependsOnOrder: [...dead].filter((name) => read.has(name)).sort(),
        }
      : 'never reached',
  )
}
