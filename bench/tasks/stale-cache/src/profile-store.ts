export interface Profile {
  id: string
  name: string
  displayName: string
}

const db = new Map<string, Profile>()
const cache = new Map<string, Profile>()

async function readFromDb(id: string): Promise<Profile | null> {
  await Promise.resolve()
  const row = db.get(id)
  return row ? { ...row } : null
}

async function formatProfile(profile: Profile): Promise<Profile> {
  await Promise.resolve()
  return { ...profile, displayName: profile.name.trim().toUpperCase() }
}

async function validateName(name: string): Promise<string> {
  await Promise.resolve()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Profile name cannot be empty')
  return trimmed
}

async function writeToDb(id: string, profile: Profile): Promise<void> {
  await Promise.resolve()
  db.set(id, { ...profile })
}

async function auditUpdate(_id: string, _profile: Profile): Promise<void> {
  await Promise.resolve()
}

export function resetStore(): void {
  db.clear()
  cache.clear()
}

export function seedProfile(id: string, name: string): void {
  const clean = name.trim()
  db.set(id, { id, name: clean, displayName: clean.toUpperCase() })
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
