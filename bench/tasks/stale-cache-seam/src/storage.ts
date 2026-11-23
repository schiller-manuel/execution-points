export interface Profile {
  id: string
  name: string
  displayName: string
}

const db = new Map<string, Profile>()

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

export function resetStorage(): void {
  db.clear()
}

export function seedStorage(id: string, profile: Profile): void {
  db.set(id, { ...profile })
}

export async function readFromDb(id: string): Promise<Profile | null> {
  await yieldIo()
  const row = db.get(id)
  return row ? { ...row } : null
}

export async function formatProfile(profile: Profile): Promise<Profile> {
  await yieldIo()
  return { ...profile, displayName: profile.name.trim().toUpperCase() }
}

export async function validateName(name: string): Promise<string> {
  await yieldIo()
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Profile name cannot be empty')
  return trimmed
}

export async function writeToDb(id: string, profile: Profile): Promise<void> {
  await yieldIo()
  db.set(id, { ...profile })
}

export async function auditUpdate(_id: string, _profile: Profile): Promise<void> {
  await yieldIo()
}
