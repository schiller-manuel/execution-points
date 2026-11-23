import { fetchRefreshToken, resetAuthClient } from './auth-client'

const tokenCache = new Map<string, string>()

export function resetTokenCache(): void {
  tokenCache.clear()
  resetAuthClient()
}

export function invalidateToken(tenantId: string): void {
  tokenCache.delete(tenantId)
}

export async function getToken(tenantId: string): Promise<string> {
  const cached = tokenCache.get(tenantId)
  if (cached !== undefined) return cached
  const fresh = await fetchRefreshToken(tenantId)
  tokenCache.set(tenantId, fresh)
  return fresh
}
