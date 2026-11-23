let searchSeq = 0

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

export function resetSearchApi(): void {
  searchSeq = 0
}

export async function fetchSearchResults(query: string): Promise<string[]> {
  await yieldIo()
  searchSeq += 1
  await yieldIo()
  return [`${query}:result-${searchSeq}`]
}
