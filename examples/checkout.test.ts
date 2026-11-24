import { beforeEach, expect, test } from 'vitest'
import { select } from 'execution-points-prototype'
import { checkout, events } from './checkout'

const quotePoint = select('examples/checkout.ts', (node) => {
  if (node.inFunction === 'checkout' && node.kind === 'CallExpression' && node.callee === 'send') {
    return node.capture('region', 'user', 'attempt')
  }
})

// Minimal selector without kind or inFunction: && short-circuit works directly on callee
const minimalQuotePoint = select('examples/checkout.ts', (n) => n.callee === 'send' && n).capture('region', 'user')

// Same target with a narrowed capture subset via chained .capture()
const userOnlyQuotePoint = quotePoint.capture('user')

const order = () => ({
  id: 'order-1',
  region: 'EU' as const,
  user: { id: 'user-1', name: 'Ada', isTestAccount: true },
})

beforeEach(() => { events.length = 0 })

test('runs application code normally when no replacement is active', () => {
  expect(checkout(order())).toMatchObject({ quote: { total: 100 }, attempt: 1 })
  expect(events).toEqual(['getClient', 'send:order-1:0'])
})

test('reads narrowed locals and skips the whole selected expression', () => {
  const result = quotePoint.withReplacement(({ locals }) => {
    /* binding-check */
    expect(/* captured-region */ locals.region).toBe('EU')
    expect(locals.user.id).toBe('user-1')
    expect(locals.attempt).toBe(0)
    return { total: /* invalid-return */ 7, currency: 'EUR' }
  }, () => checkout(order()))

  expect(result.quote.total).toBe(7)
  expect(result.attempt).toBe(0)
  expect(events).toEqual([])
})

test('supports minimal callee selection without kind or inFunction', () => {
  const result = minimalQuotePoint.withReplacement(({ locals }) => {
    expect(locals.region).toBe('EU')
    expect(locals.user.id).toBe('user-1')
    return { total: 42, currency: 'EUR' }
  }, () => checkout(order()))

  expect(result.quote.total).toBe(42)
  expect(events).toEqual([])
})

test('supports chained capture subsets on an existing point', () => {
  const result = userOnlyQuotePoint.withReplacement(({ locals }) => {
    return { total: locals.user.isTestAccount ? 0 : 99, currency: 'EUR' }
  }, () => checkout(order()))

  expect(result.quote.total).toBe(0)
  expect(events).toEqual([])
})

test('shares captured objects and preserves receiver and side effects on call-through', () => {
  const input = order()
  const result = quotePoint.withReplacement(({ locals, original }) => {
    locals.user.name = 'Changed by the test'
    return original()
  }, () => checkout(input))

  expect(result.quote.total).toBe(100)
  expect(result.userName).toBe('Changed by the test')
  expect(input.user.name).toBe('Changed by the test')
  expect(result.attempt).toBe(1)
  expect(events).toEqual(['getClient', 'send:order-1:0'])
})

test('restores the outer replacement after a nested scope', () => {
  const totals = quotePoint.withReplacement(() => ({ total: 1, currency: 'EUR' }), () => [
    checkout(order()).quote.total,
    quotePoint.withReplacement(() => ({ total: 2, currency: 'EUR' }), () => checkout(order()).quote.total),
    checkout(order()).quote.total,
  ])
  expect(totals).toEqual([1, 2, 1])
  expect(checkout(order()).quote.total).toBe(100)
})

test('cleans up after a replacement throws', () => {
  expect(() => quotePoint.withReplacement(() => { throw new Error('injected failure') }, () => checkout(order())))
    .toThrow('injected failure')
  expect(checkout(order()).quote.total).toBe(100)
})

test('isolates concurrent asynchronous scopes', async () => {
  const totals = await Promise.all([1, 2].map(total => quotePoint.withReplacement(
    () => ({ total, currency: 'EUR' }),
    async () => { await Promise.resolve(); return checkout(order()).quote.total },
  )))
  expect(totals).toEqual([1, 2])
})

test('fails loudly when a replacement never runs', () => {
  // The action never reaches the selected expression, so the replacement did nothing.
  expect(() => quotePoint.withReplacement(() => ({ total: 1, currency: 'EUR' }), () => 'no checkout here'))
    .toThrow('ran 0 times; expected at least once')

  // `times` says how often it must run: 0 asserts that the expression is not reached.
  quotePoint.withReplacement(() => ({ total: 1, currency: 'EUR' }), () => 'no checkout here', { times: 0 })
  expect(() => quotePoint.withReplacement(() => ({ total: 1, currency: 'EUR' }), () => checkout(order()), { times: 2 }))
    .toThrow('ran once; expected 2 times')
})

test('replaces chosen evaluations and counts them', () => {
  // `on` picks the evaluations the handler takes; `call` tells the handler which one it is on.
  const totals = quotePoint.withReplacement(
    ({ call }) => ({ total: call, currency: 'EUR' }),
    () => [checkout(order()), checkout(order()), checkout(order())].map((result) => result.quote.total),
    { on: [1, 3] },
  )
  expect(totals).toEqual([1, 100, 3])
  expect(quotePoint.calls).toBe(2)
})

test('replaces everywhere until the end of the block with `using`', () => {
  {
    using replacement = quotePoint.returns({ total: 5, currency: 'USD' })
    expect(checkout(order()).quote).toEqual({ total: 5, currency: 'USD' })
    expect(replacement.calls).toBe(1)
  }
  expect(checkout(order()).quote.total).toBe(100)
})

test('injects a failure for the rest of the test', () => {
  // No `using` and no scope: the replacement is restored, and checked, when the test ends.
  quotePoint.throws(new Error('pricing service is down'))
  expect(() => checkout(order())).toThrow('pricing service is down')
})
