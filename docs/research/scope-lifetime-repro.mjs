// Reproduce against the runtime inspected for the prior-art survey.
// Run from the repository root: node docs/research/scope-lifetime-repro.mjs
import { fromFile, invoke, registerFile } from '../../src/runtime.mjs'

registerFile('scope-proof.ts', [{
  id: 'scope-proof',
  kind: 'CallExpression',
  inFunction: 'run',
  callee: 'read',
  nth: 0,
}])

const point = fromFile('scope-proof.ts', (file) =>
  file.fn('run').call('read'),
)

async function scenario(otherScopeActive) {
  let release
  let later
  const gate = new Promise((resolve) => { release = resolve })

  point.withReplacement(() => 'A', () => {
    later = gate.then(() =>
      invoke('scope-proof', () => 'original', () => ({})),
    )
  })

  if (otherScopeActive) {
    return point.withReplacement(() => 'B', async () => {
      release()
      return await later
    })
  }

  release()
  return await later
}

console.log(JSON.stringify({
  noOtherScope: await scenario(false),
  otherScopeActive: await scenario(true),
}, null, 2))
