#!/usr/bin/env node
// The mapper as the process that TypeScript starts: everything it does is in content-mapper.ts.
import { serve } from './content-mapper.ts'

serve(process.stdin, process.stdout)
