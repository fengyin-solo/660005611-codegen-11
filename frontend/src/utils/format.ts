/** Display helpers shared by the summary table, detail table and trend chart. */

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '-'
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function formatNumber(n: number): string {
  return (n ?? 0).toLocaleString('zh-CN')
}

/** Duration in ms -> human readable, keeping milliseconds when sub-second. */
export function formatDuration(ms: number): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`
  const m = Math.floor(ms / 60_000)
  const s = ((ms % 60_000) / 1000).toFixed(1)
  return `${m} 分 ${s} 秒`
}

export function formatPct(v: number): string {
  return `${((v ?? 0) * 100).toFixed(1)}%`
}

/** Short id used as trend x-axis label. */
export function formatRunLabel(ts: number): string {
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function startOfToday(offsetDays = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  d.setHours(0, 0, 0, 0)
  return d
}

export function endOfToday(offsetDays = 0): Date {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  d.setHours(23, 59, 59, 999)
  return d
}
