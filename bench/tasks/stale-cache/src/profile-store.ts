export interface Profile {
  id: string
  name: string
  displayName: string
}

const db = new Map<string, Profile>()
const cache = new Map<string, Profile>()

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

async function readFromDb(id: string): Promise<Profile | null> {
  await yieldIo()
  const row = db.get(id)
  return row ? { ...row } : null
}

async function formatProfile(profile: Profile): Promise<Profile> {
  await yieldIo()
  return { ...profile, displayName: profile.name.trim().toUpperCase() }
}

async function validateName(name: string): Promise<string> {
  await yieldIo()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Profile name cannot be empty')
  return trimmed
}

async function writeToDb(id: string, profile: Profile): Promise<void> {
  await yieldIo()
  db.set(id, { ...profile })
}

async function auditUpdate(_id: string, _profile: Profile): Promise<void> {
  await yieldIo()
}

export function resetStore(): void {
  db.clear()
  cache.clear()
}

export function clearCache(): void {
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
