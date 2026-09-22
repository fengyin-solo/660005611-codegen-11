import axios from 'axios'
import type { DetailsResponse, Stage, SummaryResponse, TrendResponse } from '@/types'

function filterParams(q: {
  startTime: number | null
  endTime: number | null
  status: string
  page: number
  pageSize: number
  sortBy?: string
  sortOrder?: string
  taskId?: string | null
}) {
  const p: Record<string, string | number> = {
    page: q.page,
    pageSize: q.pageSize,
  }
  if (q.startTime != null) p.startTime = q.startTime
  if (q.endTime != null) p.endTime = q.endTime
  if (q.status) p.status = q.status
  if (q.sortBy) p.sortBy = q.sortBy
  if (q.sortOrder) p.sortOrder = q.sortOrder
  if (q.taskId) p.taskId = q.taskId
  return p
}

export async function fetchStages() {
  const { data } = await axios.get<{ items: Stage[] }>('/api/report/stages')
  return data.items
}

export async function fetchSummary(q: Parameters<typeof filterParams>[0]) {
  const { data } = await axios.get<SummaryResponse>('/api/report/summary', { params: filterParams(q) })
  return data
}

export async function fetchDetails(q: Parameters<typeof filterParams>[0]) {
  const { data } = await axios.get<DetailsResponse>('/api/report/details', { params: filterParams(q) })
  return data
}

export async function fetchTrend(q: {
  startTime: number | null
  endTime: number | null
  status: string
  limit: number
  taskIds: string[]
}) {
  const params: Record<string, string | number> = { limit: q.limit }
  if (q.startTime != null) params.startTime = q.startTime
  if (q.endTime != null) params.endTime = q.endTime
  if (q.status) params.status = q.status
  const { data } = await axios.get<TrendResponse>('/api/report/trend', {
    params: { ...params, taskId: q.taskIds },
    paramsSerializer: { indexes: null }, // repeated params: taskId=a&taskId=b
  })
  return data
}

export async function seedDemo(runs = 60, days = 21) {
  const { data } = await axios.post('/api/report/seed', { runs, days, reset: true })
  return data as { created: number; failed: number }
}
