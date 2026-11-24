/**
 * Runtime integrity guard injected via Vitest `setupFiles` during grading (harness v2.4;
 * the guard itself is unchanged since v2.2).
 *
 * Closes E-01, E-05, A-01, N-22, N-23, N-24:
 * - Walks and locks the ENTIRE prototype chain (up to excluding Object.prototype)
 *   of every protected built-in (including NodeEventTarget.prototype — N-22!).
 * - Wraps Object.setPrototypeOf, Reflect.setPrototypeOf, and Object.prototype.__proto__
 *   setter to block prototype replacement attacks.
 * - Writes one unique per-worker report JSON inside `BENCH_GUARD_REPORT_DIR`
 *   (never overwrites another worker's file — closes N-23!). Harness merges all
 *   worker reports and fails closed if zero reports exist.
 * - Protects Error.stackTraceLimit from being zeroed to hide real-sleep stacks.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll } from 'vitest'

const reportDir = process.env.BENCH_GUARD_REPORT_DIR || ''
const workerFile = reportDir
  ? path.join(
      reportDir,
      `guard-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    )
  : ''
const srcRoot = process.env.BENCH_GUARD_SRC_ROOT
  ? path.resolve(process.env.BENCH_GUARD_SRC_ROOT)
  : ''
const allowedTimerFiles = new Set(
  (process.env.BENCH_GUARD_ALLOWED_TIMER_FILES || '')
    .split(',')
    .filter(Boolean)
    .map((p) => path.resolve(p)),
)

const violations = {
  globalPatches: [],
  realSleeps: [],
}

function persistReport() {
  if (!workerFile) return
  try {
    mkdirSync(reportDir, { recursive: true })
    writeFileSync(
      workerFile,
      JSON.stringify(
        {
          pid: process.pid,
          loaded: true,
          globalPatches: [...new Set(violations.globalPatches)],
          realSleeps: [...new Set(violations.realSleeps)],
        },
        null,
        2,
      ),
    )
  } catch {
    // Harness fails closed if no report file exists
  }
}

// Write initial sentinel immediately on setup load so fail-closed check knows guard ran
persistReport()

function recordGlobalPatch(label) {
  violations.globalPatches.push(label)
  persistReport()
}

function recordRealSleep(label) {
  violations.realSleeps.push(label)
  persistReport()
}

const PROTECTED_GLOBAL_KEYS = new Set([
  'Promise',
  'MessageChannel',
  'MessagePort',
  'EventTarget',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'AbortController',
  'AbortSignal',
])

// Walk full prototype chains (excluding Object.prototype) so NodeEventTarget.prototype etc. are protected (N-22!)
const PROTECTED_OBJECTS = new Map()

function registerWithPrototypeChain(obj, baseName) {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return
  let cur = obj
  let depth = 0
  while (cur && cur !== Object.prototype && cur !== Function.prototype) {
    if (!PROTECTED_OBJECTS.has(cur)) {
      const label = depth === 0 ? baseName : `${baseName}.__proto__^${depth}`
      PROTECTED_OBJECTS.set(cur, label)
    }
    cur = Object.getPrototypeOf(cur)
    depth += 1
  }
}

registerWithPrototypeChain(Promise, 'Promise')
registerWithPrototypeChain(Promise.prototype, 'Promise.prototype')
registerWithPrototypeChain(MessageChannel, 'MessageChannel')
registerWithPrototypeChain(MessageChannel.prototype, 'MessageChannel.prototype')
registerWithPrototypeChain(MessagePort, 'MessagePort')
registerWithPrototypeChain(MessagePort.prototype, 'MessagePort.prototype')
registerWithPrototypeChain(EventTarget, 'EventTarget')
registerWithPrototypeChain(EventTarget.prototype, 'EventTarget.prototype')
registerWithPrototypeChain(Map, 'Map')
registerWithPrototypeChain(Map.prototype, 'Map.prototype')
registerWithPrototypeChain(Set, 'Set')
registerWithPrototypeChain(Set.prototype, 'Set.prototype')
registerWithPrototypeChain(WeakMap.prototype, 'WeakMap.prototype')
registerWithPrototypeChain(WeakSet.prototype, 'WeakSet.prototype')
registerWithPrototypeChain(AbortController, 'AbortController')
registerWithPrototypeChain(AbortController.prototype, 'AbortController.prototype')
registerWithPrototypeChain(AbortSignal, 'AbortSignal')
registerWithPrototypeChain(AbortSignal.prototype, 'AbortSignal.prototype')

const nativeDefineProperty = Object.defineProperty
const nativeDefineProperties = Object.defineProperties
const nativeReflectDefineProperty = Reflect.defineProperty
const nativeReflectSet = Reflect.set
const nativeObjectAssign = Object.assign
const nativeSetPrototypeOf = Object.setPrototypeOf
const nativeReflectSetPrototypeOf = Reflect.setPrototypeOf

function checkTargetMutation(target, prop) {
  if (target === globalThis && PROTECTED_GLOBAL_KEYS.has(String(prop))) {
    const label = `runtime:globalThis.${String(prop)}`
    recordGlobalPatch(label)
    throw new TypeError(`Forbidden global monkey-patch: ${label}`)
  }
  const name = PROTECTED_OBJECTS.get(target)
  if (name) {
    const label = `runtime:${name}.${String(prop)}`
    recordGlobalPatch(label)
    throw new TypeError(`Forbidden global monkey-patch: ${label}`)
  }
}

// 1. Non-configurable traps on protected globalThis keys
for (const key of PROTECTED_GLOBAL_KEYS) {
  const original = globalThis[key]
  if (original === undefined) continue
  const desc = Object.getOwnPropertyDescriptor(globalThis, key)
  if (!desc || !desc.configurable) continue
  nativeDefineProperty(globalThis, key, {
    configurable: false,
    enumerable: desc.enumerable ?? false,
    get() {
      return original
    },
    set() {
      const label = `runtime:globalThis.${key}`
      recordGlobalPatch(label)
      throw new TypeError(`Forbidden global monkey-patch: ${label}`)
    },
  })
}

// 2. Lock EVERY string-keyed own property on EVERY protected object & prototype-chain link (closes N-22!)
for (const [obj, objName] of PROTECTED_OBJECTS.entries()) {
  for (const key of Reflect.ownKeys(obj)) {
    if (
      typeof key === 'symbol' ||
      key === 'constructor' ||
      key === 'prototype' ||
      key === 'length' ||
      key === 'name'
    ) {
      continue
    }
    const desc = Object.getOwnPropertyDescriptor(obj, key)
    if (!desc || !desc.configurable) continue
    if ('value' in desc) {
      const original = desc.value
      nativeDefineProperty(obj, key, {
        configurable: false,
        enumerable: desc.enumerable ?? false,
        get() {
          return original
        },
        set() {
          const label = `runtime:${objName}.${String(key)}`
          recordGlobalPatch(label)
          throw new TypeError(`Forbidden global monkey-patch: ${label}`)
        },
      })
    } else {
      // Preserve native getter/setter (e.g. MessagePort.prototype.onmessage) while preventing redefinition
      nativeDefineProperty(obj, key, {
        configurable: false,
        enumerable: desc.enumerable ?? false,
        get: desc.get,
        set: desc.set,
      })
    }
  }
}

// 3. Wrap reflection, defineProperty, and setPrototypeOf APIs (closes N-22!)
Object.defineProperty = function guardedDefineProperty(target, prop, descriptor) {
  checkTargetMutation(target, prop)
  return nativeDefineProperty.call(Object, target, prop, descriptor)
}
Object.defineProperties = function guardedDefineProperties(target, props) {
  if (props && typeof props === 'object') {
    for (const key of Reflect.ownKeys(props)) {
      checkTargetMutation(target, key)
    }
  }
  return nativeDefineProperties.call(Object, target, props)
}
Reflect.defineProperty = function guardedReflectDefineProperty(target, prop, descriptor) {
  checkTargetMutation(target, prop)
  return nativeReflectDefineProperty.call(Reflect, target, prop, descriptor)
}
Reflect.set = function guardedReflectSet(target, prop, value, receiver) {
  checkTargetMutation(target, prop)
  return nativeReflectSet.call(Reflect, target, prop, value, receiver)
}
Object.assign = function guardedObjectAssign(target, ...sources) {
  if (target === globalThis || PROTECTED_OBJECTS.has(target)) {
    for (const src of sources) {
      if (src && typeof src === 'object') {
        for (const key of Object.keys(src)) {
          checkTargetMutation(target, key)
        }
      }
    }
  }
  return nativeObjectAssign.call(Object, target, ...sources)
}
Object.setPrototypeOf = function guardedSetPrototypeOf(target, proto) {
  if (target === globalThis || PROTECTED_OBJECTS.has(target)) {
    const label = `runtime:setPrototypeOf(${PROTECTED_OBJECTS.get(target) ?? 'globalThis'})`
    recordGlobalPatch(label)
    throw new TypeError(`Forbidden global monkey-patch: ${label}`)
  }
  return nativeSetPrototypeOf.call(Object, target, proto)
}
Reflect.setPrototypeOf = function guardedReflectSetPrototypeOf(target, proto) {
  if (target === globalThis || PROTECTED_OBJECTS.has(target)) {
    const label = `runtime:Reflect.setPrototypeOf(${PROTECTED_OBJECTS.get(target) ?? 'globalThis'})`
    recordGlobalPatch(label)
    throw new TypeError(`Forbidden global monkey-patch: ${label}`)
  }
  return nativeReflectSetPrototypeOf.call(Reflect, target, proto)
}
{
  const protoDesc = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__')
  if (protoDesc && protoDesc.configurable && typeof protoDesc.set === 'function') {
    const origSet = protoDesc.set
    nativeDefineProperty(Object.prototype, '__proto__', {
      configurable: false,
      enumerable: protoDesc.enumerable ?? false,
      get: protoDesc.get,
      set(val) {
        if (this === globalThis || PROTECTED_OBJECTS.has(this)) {
          const label = `runtime:__proto__(${PROTECTED_OBJECTS.get(this) ?? 'globalThis'})`
          recordGlobalPatch(label)
          throw new TypeError(`Forbidden global monkey-patch: ${label}`)
        }
        return origSet.call(this, val)
      },
    })
  }
}

// 4. Runtime sleep guard: block Atomics.wait and detect wall-clock setTimeout/setInterval
const nativeAtomicsWait = Atomics.wait
Atomics.wait = function guardedAtomicsWait(...args) {
  recordRealSleep('runtime:Atomics.wait')
  throw new TypeError('Forbidden sleep: Atomics.wait')
}

function captureSafeStack() {
  // Keep V8's native Error.stackTraceLimit intact (required by Vitest's vi.mock resolver),
  // while defeating any cheat that zeroes Error.stackTraceLimit before sleeping.
  const prev = Error.stackTraceLimit
  const lowered = typeof prev !== 'number' || prev < 20
  if (lowered) Error.stackTraceLimit = 20
  const stack = new Error().stack ?? ''
  if (lowered) Error.stackTraceLimit = prev
  return stack
}

function isAgentNonAllowedStack(stack) {
  if (!stack || !srcRoot) return false
  for (const line of stack.split('\n')) {
    if (!line.includes(srcRoot)) continue
    let allowed = false
    for (const f of allowedTimerFiles) {
      if (line.includes(f)) {
        allowed = true
        break
      }
    }
    if (!allowed) return true
  }
  return false
}

const nativeSetTimeout = globalThis.setTimeout
const nativeSetInterval = globalThis.setInterval

globalThis.setTimeout = function guardedSetTimeout(fn, delay, ...args) {
  if (typeof delay === 'number' && delay > 0) {
    const stack = captureSafeStack()
    if (isAgentNonAllowedStack(stack)) {
      recordRealSleep(`runtime:setTimeout(${delay})`)
    }
  }
  return nativeSetTimeout.call(globalThis, fn, delay, ...args)
}
for (const sym of Object.getOwnPropertySymbols(nativeSetTimeout)) {
  globalThis.setTimeout[sym] = nativeSetTimeout[sym]
}

globalThis.setInterval = function guardedSetInterval(fn, delay, ...args) {
  if (typeof delay === 'number' && delay > 0) {
    const stack = captureSafeStack()
    if (isAgentNonAllowedStack(stack)) {
      recordRealSleep(`runtime:setInterval(${delay})`)
    }
  }
  return nativeSetInterval.call(globalThis, fn, delay, ...args)
}

afterAll(() => {
  persistReport()
})
