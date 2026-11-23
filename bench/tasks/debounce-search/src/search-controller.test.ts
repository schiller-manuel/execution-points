import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resetSearchApi } from './search-api'
import { createSearchController } from './search-controller'

beforeEach(() => {
  vi.useFakeTimers()
  resetSearchApi()
})

afterEach(() => {
  vi.useRealTimers()
})

test('debounces rapid typing and populates results for final query', async () => {
  const ctrl = createSearchController(25)
  ctrl.onInput('r')
  await vi.advanceTimersByTimeAsync(10)
  ctrl.onInput('re')
  await vi.advanceTimersByTimeAsync(10)
  ctrl.onInput('react')
  await vi.advanceTimersByTimeAsync(25)
  await ctrl.flush()

  const snap = ctrl.getSnapshot()
  expect(snap.query).toBe('react')
  expect(snap.results[0]).toMatch(/^react:result-/)
})
