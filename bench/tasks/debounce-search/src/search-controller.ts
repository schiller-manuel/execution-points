import { fetchSearchResults } from './search-api'

export interface SearchSnapshot {
  query: string
  results: string[]
  disposed: boolean
}

export interface SearchController {
  onInput(query: string): void
  flush(): Promise<void>
  dispose(): void
  getSnapshot(): SearchSnapshot
}

export function createSearchController(debounceMs = 20): SearchController {
  let latestQuery = ''
  let latestResults: string[] = []
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const pending = new Set<Promise<void>>()

  function runSearch(query: string): Promise<void> {
    const task = (async () => {
      const results = await fetchSearchResults(query)
      latestQuery = query
      latestResults = results
    })()
    pending.add(task)
    task.finally(() => pending.delete(task)).catch(() => {})
    return task
  }

  function onInput(query: string): void {
    if (disposed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void runSearch(query)
    }, debounceMs)
  }

  async function flush(): Promise<void> {
    while (pending.size > 0) {
      await Promise.all([...pending])
    }
  }

  function dispose(): void {
    disposed = true
  }

  function getSnapshot(): SearchSnapshot {
    return {
      query: latestQuery,
      results: [...latestResults],
      disposed,
    }
  }

  return { onInput, flush, dispose, getSnapshot }
}
