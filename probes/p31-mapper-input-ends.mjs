// Probe: what a mapper has to do when its input ends. Shows that a closed TypeScript API refuses
// every later request (so the mapper drops it and opens a new one for the next input), that
// closing twice is harmless, and that a stream reports its end only once someone reads it.
import { PassThrough } from 'node:stream'
import { API } from 'typescript/sync'
const api = new API()
const lease = api.createSourceFile('/x/a.json', '{"a": 1}')
lease.dispose()
api.close()
try {
  api.createSourceFile('/x/b.json', '{"b": 2}')
  console.log('after close: createSourceFile still works')
} catch (error) {
  console.log('after close: createSourceFile throws:', String(error.message).slice(0, 120))
}
try { api.close(); console.log('second close: fine') } catch (error) { console.log('second close throws:', String(error.message).slice(0, 80)) }
const input = new PassThrough()
let ended = 0
input.on('end', () => { ended += 1 })
input.end()
await new Promise((resolve) => setImmediate(resolve))
console.log('a PassThrough that is ended and has no data listener emits end:', ended)
input.on('data', () => {})
await new Promise((resolve) => setImmediate(resolve))
console.log('...after a data listener is attached:', ended)
