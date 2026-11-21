interface User {
  id: string
  name: string
  isTestAccount: boolean
}

interface Order {
  id: string
  region: 'EU' | 'US'
  user: User | null
}

interface Quote {
  total: number
  currency: 'EUR' | 'USD'
}

export const events: string[] = []

const pricing = {
  multiplier: 2,
  send(orderId: string, attempt: number): Quote {
    events.push(`send:${orderId}:${attempt}`)
    return { total: 50 * this.multiplier, currency: 'EUR' }
  },
}

function getClient() {
  events.push('getClient')
  return pricing
}

// Application code contains no testing hooks, markers, or exports for internal targets.
export function checkout(order: Order) {
  let attempt = 0
  const user = order.user
  if (!user) throw new Error('A user is required')
  const region = order.region
  const quote = getClient().send(order.id, attempt++)
  return { quote, attempt, userName: user.name, region }
}
