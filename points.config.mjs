import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const config = JSON.parse(readFileSync(resolve(import.meta.dirname, 'points.ep'), 'utf8'))

export default {
  root: import.meta.dirname,
  ...config,
}
