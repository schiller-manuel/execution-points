import {
  auditUpdate,
  formatProfile,
  readFromDb,
  resetStorage,
  seedStorage,
  validateName,
  writeToDb,
  type Profile,
} from './storage'

export type { Profile }

const cache = new Map<string, Profile>()

export function resetStore(): void {
  resetStorage()
  cache.clear()
}

export function clearCache(): void {
  cache.clear()
}

export function seedProfile(id: string, name: string): void {
  const clean = name.trim()
  seedStorage(id, { id, name: clean, displayName: clean.toUpperCase() })
  cache.delete(id)
}

export async function getProfile(id: string): Promise<Profile | null> {
  const cached = cache.get(id)
  if (cached) return { ...cached }
  const raw = await readFromDb(id)
  if (!raw) return null
  const formatted = await formatProfile(raw)
  cache.set(id, formatted)
  return { ...formatted }
}

export async function updateProfile(id: string, name: string): Promise<Profile> {
  const clean = await validateName(name)
  const next: Profile = { id, name: clean, displayName: clean.toUpperCase() }
  await writeToDb(id, next)
  await auditUpdate(id, next)
  cache.set(id, next)
  return { ...next }
}
