interface SessionRecord {
  userId: string
  token: string | null
}

const sessions = new Map<string, SessionRecord>()
let tokenSeq = 0

function yieldIo(): Promise<void> {
  return new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      port2.close()
      resolve()
    }
    port2.postMessage(0)
  })
}

async function requestNewToken(userId: string): Promise<string> {
  await yieldIo()
  tokenSeq += 1
  return `tok-${userId}-${tokenSeq}`
}

async function verifyTokenPolicy(_userId: string, token: string): Promise<string> {
  await yieldIo()
  return token
}

async function prepareRevocation(_userId: string): Promise<void> {
  await yieldIo()
}

async function notifyAuthServer(_userId: string): Promise<void> {
  await yieldIo()
}

async function flushAuditLog(_userId: string): Promise<void> {
  await yieldIo()
}

export function resetSessions(): void {
  sessions.clear()
  tokenSeq = 0
}

export function login(userId: string): void {
  sessions.set(userId, { userId, token: null })
}

export async function getActiveToken(userId: string): Promise<string | null> {
  const existing = sessions.get(userId)
  if (!existing) return null
  if (existing.token !== null) return existing.token
  const raw = await requestNewToken(userId)
  const verified = await verifyTokenPolicy(userId, raw)
  sessions.set(userId, { userId, token: verified })
  return verified
}

export async function logout(userId: string): Promise<void> {
  await prepareRevocation(userId)
  await notifyAuthServer(userId)
  await flushAuditLog(userId)
  sessions.delete(userId)
}
