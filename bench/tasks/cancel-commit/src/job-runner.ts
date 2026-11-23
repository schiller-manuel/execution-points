import fs from 'node:fs/promises'
import path from 'node:path'

export interface JobRecord {
  jobId: string
  status: 'running' | 'completed' | 'cancelled'
  payload?: string
  result?: string
}

export interface JobRunner {
  startJob(jobId: string, payload: string): Promise<JobRecord>
  cancelJob(jobId: string): Promise<JobRecord>
  getJobState(jobId: string): Promise<JobRecord | null>
}

export function createJobRunner(dataDir: string): JobRunner {
  const statePath = (jobId: string) => path.join(dataDir, `${jobId}.json`)
  const stagePath = (jobId: string) => path.join(dataDir, `${jobId}.stage.tmp`)

  async function readState(jobId: string): Promise<JobRecord | null> {
    try {
      const raw = await fs.readFile(statePath(jobId), 'utf8')
      return JSON.parse(raw) as JobRecord
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async function writeState(record: JobRecord): Promise<void> {
    await fs.writeFile(statePath(record.jobId), JSON.stringify(record), 'utf8')
  }

  async function startJob(jobId: string, payload: string): Promise<JobRecord> {
    const running: JobRecord = { jobId, status: 'running', payload }
    await writeState(running)

    const computed = `processed:${payload.trim().toUpperCase()}`
    await fs.writeFile(stagePath(jobId), computed, 'utf8')
    const staged = await fs.readFile(stagePath(jobId), 'utf8')

    const completed: JobRecord = {
      jobId,
      status: 'completed',
      payload,
      result: staged,
    }
    await writeState(completed)
    await fs.rm(stagePath(jobId), { force: true })
    return completed
  }

  async function cancelJob(jobId: string): Promise<JobRecord> {
    const cancelled: JobRecord = { jobId, status: 'cancelled' }
    await writeState(cancelled)
    await fs.rm(stagePath(jobId), { force: true })
    return cancelled
  }

  async function getJobState(jobId: string): Promise<JobRecord | null> {
    return readState(jobId)
  }

  return { startJob, cancelJob, getJobState }
}
