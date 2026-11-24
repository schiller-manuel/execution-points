import { AsyncLocalStorage } from 'node:async_hooks'

// Vite can load this module through more than one module graph. All copies in
// the same Node worker must share the same async-local store and file index.
const registry = (globalThis[Symbol.for('execution-points-prototype.runtime.v2')] ??= {
  storage: new AsyncLocalStorage(),
  files: new Map(),
  states: new Map(),
  flagCount: 0,
  // Replacements that apply in every async context: a stack per expression id.
  everywhere: new Map(),
  // How often a replacement ran for each expression since the last verification.
  calls: new Map(),
  // What is still to be checked when the test ends, and what already went wrong.
  owed: new Set(),
  problems: [],
})

/**
 * Returns the file's flags, one per home (a function body, or a position that is evaluated
 * later, as the plugin numbers them in `homes`). Instrumented code reads its home's flag
 * before it runs: until a test installs a replacement for an expression of that home, the
 * flag is off and the original statements run. Every registration of the file is told about
 * every replacement, earlier or later, so no copy of the code can miss one.
 */
export function registerFile(file, nodes, homes = []) {
  registry.files.set(file, nodes)
  const state = registry.states.get(file) ?? { replaced: new Set(), layouts: new Map() }
  registry.states.set(file, state)

  const homeOf = new Map(nodes.map((node, index) => [node.id, homes[index] ?? 0]))
  const key = JSON.stringify([...homeOf])
  if (!state.layouts.has(key)) {
    // Each flag is an object with a shape of its own. V8 then treats an unset flag as a constant,
    // so reading it costs nothing, until that very flag is set.
    const flags = Array.from({ length: Math.max(...homeOf.values(), 0) + 1 }, () => {
      const name = `flag ${(registry.flagCount += 1)}`
      return { [name]: name, on: false }
    })
    for (const id of state.replaced) flags[homeOf.get(id)].on = true
    state.layouts.set(key, { flags, homeOf })
  }
  return state.layouts.get(key).flags
}

/** From here on, calls into the home of `id` take the wrapped expressions. */
function markReplaced(file, id) {
  const state = registry.states.get(file)
  state.replaced.add(id)
  for (const { flags, homeOf } of state.layouts.values()) flags[homeOf.get(id)].on = true
}

function getFileNodes(file) {
  const nodes = registry.files.get(file)
  if (!nodes) {
    throw new Error(
      `[execution-points] Target file "${file}" was not instrumented or has not been imported yet. ` +
        'Ensure it is listed in points.ep under "targets" and imported before running the action.',
    )
  }
  return nodes
}

const count = (n) => (n === 1 ? 'once' : `${n} times`)

function createInstallation(id, handler, captureNames, { times, on } = {}) {
  if (times !== undefined && times !== 'any' && !(Number.isInteger(times) && times >= 0)) {
    throw new TypeError("[execution-points] `times` must be a whole number, 0 or more, or 'any'.")
  }
  const turns = on === undefined ? undefined : [on].flat()
  if (turns && !turns.every((turn) => Number.isInteger(turn) && turn >= 1)) {
    throw new TypeError('[execution-points] `on` must be a whole number, 1 or more, or a list of them.')
  }
  return { id, handler, captureNames, times, turns, evaluations: 0, runs: 0 }
}

/** What a finished replacement got wrong: by default it must have run at least once. */
function shortfall({ id, times, runs }) {
  if (times === 'any' || (times === undefined ? runs > 0 : runs === times)) return undefined
  return new Error(
    `[execution-points] The replacement for "${id}" ran ${count(runs)}; expected ${times === undefined ? 'at least once' : count(times)}. ` +
      (runs === 0 ? 'Nothing evaluated this expression where the replacement applies. ' : '') +
      "Pass { times: 'any' } if that is intended.",
  )
}

/**
 * Checks everything the current test still owes and forgets it: replacements whose action is
 * asynchronous, replacements that apply everywhere and were not restored, and pauses. Throws
 * what went wrong. The Vitest setup module calls this after each test.
 */
export function verifyReplacements() {
  const problems = registry.problems.splice(0)
  for (const owed of registry.owed) {
    owed.settle?.()
    const problem = owed.verdict ? owed.verdict() : shortfall(owed)
    if (problem) problems.push(problem)
  }
  registry.owed.clear()
  registry.calls.clear()
  if (problems.length === 1) throw problems[0]
  if (problems.length) {
    throw new AggregateError(problems, problems.map((problem) => problem.message).join('\n'))
  }
}

// What `interleavings` needs from a point that its users do not.
const internals = new WeakMap()

function createPointHandle(file, resolveSelection, captureNames) {
  const begin = (handler, options) => {
    const selected = resolveSelection()
    const installation = createInstallation(selected.id, handler, captureNames ?? selected.captureNames, options)
    markReplaced(file, selected.id)
    return installation
  }

  // Applies inside `action` and the asynchronous work it starts.
  const scoped = (installation, action) => {
    const replacements = new Map(registry.storage.getStore() ?? [])
    replacements.set(installation.id, installation)
    return registry.storage.run(replacements, action)
  }

  // Applies in every async context until it is restored: the newest one for an expression wins.
  const replace = (handler, options) => {
    if (typeof handler !== 'function') {
      throw new TypeError('[execution-points] replace requires a replacement function.')
    }
    const installation = begin(handler, options)
    const stack = registry.everywhere.get(installation.id) ?? []
    registry.everywhere.set(installation.id, stack)
    stack.push(installation)
    installation.settle = () => stack.splice(stack.indexOf(installation), 1)
    registry.owed.add(installation)

    const restore = () => {
      if (!registry.owed.delete(installation)) return
      installation.settle()
      const problem = shortfall(installation)
      if (problem) throw problem
    }
    return Object.freeze({
      get calls() {
        return installation.runs
      },
      restore,
      [Symbol.dispose]: restore,
    })
  }

  const handle = Object.freeze({
    capture(...keys) {
      return createPointHandle(file, resolveSelection, keys)
    },

    /** How often a replacement for this expression ran since the last verification. */
    get calls() {
      return registry.calls.get(resolveSelection().id) ?? 0
    },

    withReplacement(handler, action, options) {
      if (typeof handler !== 'function' || typeof action !== 'function') {
        throw new TypeError(
          '[execution-points] withReplacement requires a replacement function and an action function.',
        )
      }

      const installation = begin(handler, options)
      const result = scoped(installation, action)
      // The work of an asynchronous action is still running: it is checked when the test ends.
      if (typeof result?.then === 'function') {
        registry.owed.add(installation)
        return result
      }
      const problem = shortfall(installation)
      if (problem) throw problem
      return result
    },

    replace,
    returns: (value, options) => replace(() => value, options),
    throws: (error, options) =>
      replace(() => {
        throw error
      }, options),
    resolves: (value, options) => replace(() => Promise.resolve(value), options),
    rejects: (error, options) => replace(() => Promise.reject(error), options),

    /**
     * Holds every evaluation inside `run(action)` until `release()`, then lets it continue
     * with the original expression. `reached` settles with the first evaluation that arrives,
     * or rejects as soon as the action finishes without one.
     */
    pause() {
      let released = false
      let waiting = 0
      let letGo
      const freed = new Promise((resolve) => {
        letGo = resolve
      })
      let arrive
      let miss
      const outcome = new Promise((resolve, reject) => {
        arrive = resolve
        miss = reject
      })
      outcome.catch(() => {})

      const installation = begin((context) => {
        arrive({ locals: context.locals })
        if (released) return context.original()
        waiting += 1
        return freed.then(() => context.original())
      })

      // A test that awaits `reached` learns of a miss there; otherwise it learns when it ends.
      let missed
      let observed = false
      let heldAtEnd
      const reached = Object.freeze({
        then(onFulfilled, onRejected) {
          observed = true
          return outcome.then(onFulfilled, onRejected)
        },
      })
      const release = () => {
        released = true
        letGo()
      }
      registry.owed.add({
        settle() {
          heldAtEnd = waiting > 0 && !released
          release()
        },
        verdict: () =>
          heldAtEnd
            ? new Error(
                `[execution-points] "${installation.id}" was still paused when the test ended. Call release() on the pause.`,
              )
            : observed
              ? undefined
              : missed,
      })

      return Object.freeze({
        run(action) {
          if (typeof action !== 'function') {
            throw new TypeError('[execution-points] run requires an action function.')
          }
          const finished = (cause) => {
            if (installation.runs > 0) return
            missed = new Error(
              `[execution-points] The action finished without reaching "${installation.id}", so nothing was paused.`,
              { cause },
            )
            miss(missed)
          }
          let result
          try {
            result = scoped(installation, action)
          } catch (error) {
            finished(error)
            throw error
          }
          if (typeof result?.then === 'function') result.then(() => finished(), finished)
          else finished()
          return result
        },
        reached,
        release,
        get calls() {
          return installation.runs
        },
      })
    },
  })
  internals.set(handle, { begin, id: () => resolveSelection().id })
  return handle
}

// Taken before a test can install fake timers.
const nextTurn = setImmediate

/** Waits until two turns of the event loop in a row change nothing that `snapshot` reports. */
async function quiet(snapshot) {
  let last = snapshot()
  for (let still = 0; still < 2; ) {
    await new Promise((resolve) => nextTurn(resolve))
    const now = snapshot()
    still = now === last ? still + 1 : 0
    last = now
  }
}

/** What an order's `run` rejects with when its action fails. `schedule` gives that order again; `cause` is what the action threw. */
export class InterleavingFailure extends Error {
  constructor(message, cause, schedule) {
    super(message, { cause })
    this.name = 'InterleavingFailure'
    this.schedule = schedule
  }
}

/**
 * The orders in which operations can pass the selected expressions, one at a time. Each order
 * runs an action once: every evaluation of a selected expression inside it is held, and whenever
 * all operations have finished or are held, one is released. Each order follows from what the
 * one before it found, so an order has to run to its end before the next is taken. `schedule`
 * gives one order again; `choose` picks every order itself, for as long as the caller asks.
 */
export function interleavings(points, { schedule, choose } = {}) {
  if (!Array.isArray(points) || !points.every((point) => internals.has(point))) {
    throw new TypeError('[execution-points] interleavings requires a list of points selected with select().')
  }
  const reached = new Set()

  // One order. `pick(step, count)` says which of the `count` held evaluations goes next.
  const begin = (pick) => {
    const choices = []
    const counts = []
    const released = []
    let state = 'ready'
    const order = {
      get schedule() {
        return [...choices]
      },
      get released() {
        return [...released]
      },
      async run(action) {
        if (typeof action !== 'function') throw new TypeError('[execution-points] order.run requires a function.')
        if (state !== 'ready') {
          throw new Error('[execution-points] An order runs once. Take the next order from interleavings() to run the action again.')
        }
        state = 'running'
        const held = []
        const replacements = new Map(registry.storage.getStore() ?? [])
        for (const point of points) {
          const installation = internals.get(point).begin((context) => {
            reached.add(installation.id)
            return new Promise((go) => {
              held.push({ id: installation.id, go })
            }).then(() => context.original())
          })
          replacements.set(installation.id, installation)
        }

        let outcome
        Promise.resolve()
          .then(() => registry.storage.run(replacements, action))
          .then(
            (value) => {
              outcome = { value }
            },
            (error) => {
              outcome = { error }
            },
          )
        for (;;) {
          await quiet(() => `${held.length} ${released.length}`)
          if (outcome) break
          if (held.length === 0) {
            outcome = {
              error: new Error(
                '[execution-points] The run neither finished nor reached a selected expression. It may be waiting on a timer or on I/O, which the search cannot order.',
              ),
            }
            break
          }
          const choice = pick(choices.length, held.length)
          if (!(Number.isInteger(choice) && choice >= 0 && choice < held.length)) {
            throw new TypeError(
              `[execution-points] There is no valid choice for step ${choices.length + 1}: ${held.length} evaluations were held, and the choice was ${choice}.`,
            )
          }
          counts.push(held.length)
          choices.push(choice)
          const [next] = held.splice(choice, 1)
          released.push(next.id)
          next.go()
        }
        state = 'done'
        if ('error' in outcome) {
          throw new InterleavingFailure(
            (released.length
              ? `[execution-points] The scenario failed in this order:\n` +
                released.map((id, position) => `  ${position + 1}. ${id}`).join('\n') +
                `\nReplay it with interleavings(points, { schedule: ${JSON.stringify(choices)} }).`
              : '[execution-points] The scenario failed before any selected expression was released.') +
              `\nIt failed with: ${outcome.error?.message ?? outcome.error}`,
            outcome.error,
            [...choices],
          )
        }
        if (schedule && choices.length !== schedule.length) {
          throw new TypeError(`[execution-points] The schedule has ${schedule.length} choices, but the run made ${choices.length}.`)
        }
        return outcome.value
      },
    }
    return { order, choices, counts, ran: () => state === 'done' }
  }

  // Hands out one order and insists that it ran before the walk goes on.
  function* one(pick) {
    const taken = begin(pick)
    yield taken.order
    if (!taken.ran()) {
      throw new Error(
        '[execution-points] The order before this one has not run to its end. Await order.run(action) before taking the next order.',
      )
    }
    return taken
  }

  return (function* walk() {
    if (schedule) {
      yield* one((step) => schedule[step])
    } else if (choose) {
      for (let run = 0; ; run += 1) yield* one((step, count) => choose(step, count, run))
    } else {
      // Depth first: repeat the choices up to the last one that has an untried alternative.
      for (let prefix = []; prefix; ) {
        const { choices, counts } = yield* one((step) => prefix[step] ?? 0)
        const turn = choices.findLastIndex((choice, step) => choice + 1 < counts[step])
        prefix = turn === -1 ? undefined : [...choices.slice(0, turn), choices[turn] + 1]
      }
    }
    const unreached = points.map((point) => internals.get(point).id()).filter((id) => !reached.has(id))
    if (unreached.length) {
      throw new Error(
        `[execution-points] No run reached ${unreached.map((id) => `"${id}"`).join(', ')}. Every selected expression must be evaluated by the scenario.`,
      )
    }
  })()
}

function makeVisitorNode(descriptor) {
  return Object.freeze({
    ...descriptor,
    capture(...keys) {
      return Object.freeze({ __epSelected: true, id: descriptor.id, captureNames: keys })
    },
  })
}

/**
 * Imperative narrowing visitor.
 */
export function select(file, visitor) {
  if (typeof visitor !== 'function') {
    throw new TypeError('[execution-points] select(file, visitor) requires a visitor function.')
  }

  let cached
  const resolveNow = () => {
    if (cached) return cached
    const nodes = getFileNodes(file)
    const matches = []
    // A node is selected by returning that node, or what its own capture() returned.
    let strays = 0
    for (const descriptor of nodes) {
      const node = makeVisitorNode(descriptor)
      const result = visitor(node)
      if (!result) continue
      if (result === node) {
        matches.push({ id: descriptor.id, captureNames: [] })
      } else if (result.__epSelected && result.id === descriptor.id) {
        matches.push({ id: descriptor.id, captureNames: result.captureNames })
      } else {
        strays += 1
      }
    }
    if (matches.length !== 1) {
      throw new Error(
        `[execution-points] Visitor for "${file}" must match exactly 1 expression; matched ${matches.length}.` +
          (strays > 0
            ? ` For ${strays} of the file's nodes it returned something that is not the node: return the node it was given, node.capture(...), or nothing.`
            : ''),
      )
    }
    cached = matches[0]
    return cached
  }

  // Eagerly resolve when the target module is already loaded so invalid visitors fail fast.
  if (registry.files.has(file)) resolveNow()
  return createPointHandle(file, resolveNow)
}

/**
 * Called by instrumented target code before evaluating a selectable expression, once a
 * replacement has been installed for an expression of its home.
 */
export function invoke(id, originalThunk, captureThunk) {
  const active = registry.storage.getStore()?.get(id) ?? registry.everywhere.get(id)?.at(-1)
  if (!active) return originalThunk()

  const call = (active.evaluations += 1)
  if (active.turns && !active.turns.includes(call)) return originalThunk()
  active.runs += 1
  registry.calls.set(id, (registry.calls.get(id) ?? 0) + 1)

  const getters = captureThunk()
  const locals = Object.create(null)
  for (const key of active.captureNames) {
    if (!Object.hasOwn(getters, key)) {
      const problem = new Error(
        `[execution-points] "${key}" is not a local that "${id}" can capture. ` +
          `It can capture: ${Object.keys(getters).join(', ') || 'nothing'}.`,
      )
      registry.problems.push(problem)
      throw problem
    }
    const getter = getters[key]
    locals[key] = typeof getter === 'function' ? getter() : getter
  }
  Object.freeze(locals)
  return active.handler(Object.freeze({ locals, original: originalThunk, call }))
}
