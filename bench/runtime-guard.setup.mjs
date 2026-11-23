/**
 * Runtime integrity guard injected via Vitest `setupFiles` during grading.
 *
 * Enforces anti-global-monkey-patching and anti-real-sleep rules AT RUNTIME,
 * so aliases (`const host = globalThis`), destructuring, `vi['spyOn']`,
 * `Reflect.defineProperty`, `eval`/`new Function`, and imported helper modules
 * cannot bypass the benchmark rules (closes E-01, E-05, A-01).
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll } from 'vitest'

const reportPath = process.env.BENCH_GUARD_REPORT || ''
const srcRoot = process.env.BENCH_GUARD_SRC_ROOT ? path.resolve(process.env.BENCH_GUARD_SRC_ROOT) : ''
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
  if (!reportPath) return
  try {
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          globalPatches: [...new Set(violations.globalPatches)],
          realSleeps: [...new Set(violations.realSleeps)],
        },
        null,
        2,
      ),
    )
  } catch {
    // best-effort write
  }
}

function recordGlobalPatch(label) {
  violations.globalPatches.push(label)
  persistReport()
}

function recordRealSleep(label) {
  violations.realSleeps.push(label)
  persistReport()
}

// 1. Protect built-in globals and prototypes against both direct assignment AND
//    Object.defineProperty / Reflect.defineProperty / Reflect.set / vi.spyOn / vi.stubGlobal.
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

const PROTECTED_OBJECTS = new Map([
  [Promise, 'Promise'],
  [Promise.prototype, 'Promise.prototype'],
  [MessageChannel, 'MessageChannel'],
  [MessagePort, 'MessagePort'],
  [MessagePort.prototype, 'MessagePort.prototype'],
  [EventTarget, 'EventTarget'],
  [EventTarget.prototype, 'EventTarget.prototype'],
  [Map, 'Map'],
  [Map.prototype, 'Map.prototype'],
  [Set, 'Set'],
  [Set.prototype, 'Set.prototype'],
  [WeakMap.prototype, 'WeakMap.prototype'],
  [WeakSet.prototype, 'WeakSet.prototype'],
  [AbortController, 'AbortController'],
  [AbortController.prototype, 'AbortController.prototype'],
  [AbortSignal, 'AbortSignal'],
  [AbortSignal.prototype, 'AbortSignal.prototype'],
])

const nativeDefineProperty = Object.defineProperty
const nativeDefineProperties = Object.defineProperties
const nativeReflectDefineProperty = Reflect.defineProperty
const nativeReflectSet = Reflect.set
const nativeObjectAssign = Object.assign

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

// Install non-configurable getter/setter traps on protected globalThis keys
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

// Install non-configurable getter/setter traps on critical prototype/static methods
const TRAPPED_MEMBERS = [
  [Promise, ['resolve', 'reject', 'all', 'race', 'allSettled', 'any', 'withResolvers']],
  [Promise.prototype, ['then', 'catch', 'finally']],
  [MessagePort.prototype, ['postMessage', 'start', 'close', 'addEventListener', 'removeEventListener']],
  [EventTarget.prototype, ['addEventListener', 'removeEventListener', 'dispatchEvent']],
  [Map.prototype, ['get', 'set', 'has', 'delete', 'clear']],
  [Set.prototype, ['add', 'has', 'delete', 'clear']],
  [AbortController.prototype, ['abort']],
]

for (const [obj, keys] of TRAPPED_MEMBERS) {
  const objName = PROTECTED_OBJECTS.get(obj) ?? 'Object'
  for (const key of keys) {
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
          const label = `runtime:${objName}.${key}`
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

// Lock MessagePort.prototype.onmessage descriptor non-configurable while preserving instance setter
{
  const desc = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')
  if (desc && desc.configurable) {
    nativeDefineProperty(MessagePort.prototype, 'onmessage', {
      configurable: false,
      enumerable: desc.enumerable ?? true,
      get: desc.get,
      set: desc.set,
    })
  }
}

// Wrap reflection / defineProperty APIs so attempts to patch protected targets are logged explicitly
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

// 2. Runtime sleep guard: block Atomics.wait and detect wall-clock setTimeout/setInterval
//    called from agent test/helper files (ignoring Vitest fake timers and allowed timer production files).
const nativeAtomicsWait = Atomics.wait
Atomics.wait = function guardedAtomicsWait(...args) {
  recordRealSleep('runtime:Atomics.wait')
  throw new TypeError('Forbidden sleep: Atomics.wait')
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

// Note: vi.useFakeTimers() replaces globalThis.setTimeout with a fake clock, so this wrapper
// runs ONLY when real wall-clock timers are active!
globalThis.setTimeout = function guardedSetTimeout(fn, delay, ...args) {
  if (typeof delay === 'number' && delay > 0) {
    const stack = new Error().stack ?? ''
    if (isAgentNonAllowedStack(stack)) {
      recordRealSleep(`runtime:setTimeout(${delay})`)
    }
  }
  return nativeSetTimeout.call(globalThis, fn, delay, ...args)
}
// Copy custom promisify symbol so node:timers/promises interop stays intact
for (const sym of Object.getOwnPropertySymbols(nativeSetTimeout)) {
  globalThis.setTimeout[sym] = nativeSetTimeout[sym]
}

globalThis.setInterval = function guardedSetInterval(fn, delay, ...args) {
  if (typeof delay === 'number' && delay > 0) {
    const stack = new Error().stack ?? ''
    if (isAgentNonAllowedStack(stack)) {
      recordRealSleep(`runtime:setInterval(${delay})`)
    }
  }
  return nativeSetInterval.call(globalThis, fn, delay, ...args)
}

afterAll(() => {
  persistReport()
})
