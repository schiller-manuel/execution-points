import { beforeEach, expect, test } from 'vitest'
import { select } from 'execution-points-prototype'
import { checkout, events } from './checkout'

const quotePoint = select('examples/checkout.ts', (node) => {
  if (node.inFunction === 'checkout' && node.kind === 'CallExpression' && node.callee === 'send') {
    return node.capture('region', 'user', 'attempt')
  }
})

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
