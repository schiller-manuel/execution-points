// A cache in front of a slow store, with a race between a read and an update.
const store = new Map<string, string>()
const cache = new Map<string, string>()

async function readStore(id: string) {
  await Promise.resolve()
  return store.get(id) ?? 'unknown'
}

async function writeStore(id: string, name: string) {
  await Promise.resolve()
  store.set(id, name)
}

async function normalize(name: string) {
  await Promise.resolve()
  return name.trim()
}

export async function getProfile(id: string) {
  const hit = cache.get(id)
  if (hit !== undefined) return hit
  const raw = await readStore(id)
  const name = await normalize(raw)
  // If an update finished while this read was in flight, this caches the old name.
  cache.set(id, name)
  return name
}

export async function updateProfile(id: string, name: string) {
  await writeStore(id, name)
  cache.set(id, name)
}

export function reset() {
  store.clear()
  cache.clear()
  store.set('u1', 'Alice')
}

export const cachedName = (id: string) => cache.get(id)
