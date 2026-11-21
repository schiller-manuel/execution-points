export function invoice(base: number) {
  const fee = 3
  return base + fee
}

async function fetchTotal(id: string): Promise<number> {
  return id.length * 10
}

export async function remoteTotal(id: string) {
  const source = 'remote'
  return await fetchTotal(id)
}
