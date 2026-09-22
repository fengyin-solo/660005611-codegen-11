import { defineStore } from 'pinia'
import { ref } from 'vue'
import { fetchDetails, fetchStages, fetchSummary, fetchTrend } from '@/api/report'
import type { DetailsResponse, Stage, SummaryResponse, TrendResponse } from '@/types'
import { endOfToday, startOfToday } from '@/utils/format'

/**
 * The report view keeps every filter/pagination/sort piece of state in this
 * store, so switching back to the report tab restores the exact view — the
 * time range, chosen page and stage selection are never silently reset.
 */
export const useReportStore = defineStore('report', () => {
  // ---- shared filters (identical payload for summary, details and trend) ----
  const timeRange = ref<[Date, Date]>([startOfToday(-20), endOfToday(0)])
  const status = ref('')
  const loading = ref(false)
  const error = ref('')
  const stages = ref<Stage[]>([])

  // ---- summary table state (server-side sort + pagination) ----
  const summary = ref<SummaryResponse | null>(null)
  const summaryPage = ref(1)
  const summaryPageSize = ref(11)
  const sortBy = ref('stageOrder')
  const sortOrder = ref<'asc' | 'desc'>('asc')

  // ---- detail table state (server-side pagination, optional stage filter) ----
  const details = ref<DetailsResponse | null>(null)
  const detailPage = ref(1)
  const detailPageSize = ref(10)
  const detailTaskId = ref<string>('')

  // Full (unpaginated) summary rows under the current filter, fetched for
  // point-by-point reconciliation so a drilled stage can be checked even
  // when it lives on a different page of the paginated summary table.
  const reconcileSummary = ref<SummaryResponse | null>(null)

  // ---- trend chart state ----
  const trend = ref<TrendResponse | null>(null)
  const trendLimit = ref(10)
  const trendStageIds = ref<string[]>(['extract', 'transform', 'aggregate', 'export_report'])

  function epoch(v: Date | null | undefined): number | null {
    return v ? v.getTime() / 1000 : null
  }
  function sharedFilters() {
    return {
      startTime: epoch(timeRange.value?.[0]),
      endTime: epoch(timeRange.value?.[1]),
      status: status.value,
    }
  }

  async function loadStages() {
    if (stages.value.length) return
    stages.value = await fetchStages()
  }

  async function loadSummary() {
    return fetchSummary({
      ...sharedFilters(),
      page: summaryPage.value,
      pageSize: summaryPageSize.value,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
    }).then(d => { summary.value = d })
  }

  async function loadDetails() {
    return fetchDetails({
      ...sharedFilters(),
      taskId: detailTaskId.value,
      page: detailPage.value,
      pageSize: detailPageSize.value,
    }).then(d => { details.value = d })
  }

  async function loadReconcile() {
    return fetchSummary({
      ...sharedFilters(),
      page: 1,
      pageSize: 100,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
    }).then(d => { reconcileSummary.value = d })
  }

  async function loadTrend() {
    return fetchTrend({
      ...sharedFilters(),
      limit: trendLimit.value,
      taskIds: trendStageIds.value,
    }).then(d => { trend.value = d })
  }

  /** Re-fetch everything with the *same* filter payload. */
  async function refreshAll() {
    loading.value = true
    error.value = ''
    try {
      await Promise.all([loadSummary(), loadDetails(), loadTrend(), loadReconcile()])
    } catch (e: any) {
      error.value = e?.response?.data?.detail || e?.message || '加载报表失败'
    } finally {
      loading.value = false
    }
  }

  /** Filter change: keep the filter values but restart both tables at page 1. */
  function applyFilters() {
    summaryPage.value = 1
    detailPage.value = 1
    return refreshAll()
  }

  function resetFilters() {
    timeRange.value = [startOfToday(-20), endOfToday(0)]
    status.value = ''
    detailTaskId.value = ''
    sortBy.value = 'stageOrder'
    sortOrder.value = 'asc'
    summaryPage.value = 1
    detailPage.value = 1
    return applyFilters()
  }

  return {
    timeRange, status, loading, error, stages,
    summary, summaryPage, summaryPageSize, sortBy, sortOrder,
    details, detailPage, detailPageSize, detailTaskId,
    reconcileSummary,
    trend, trendLimit, trendStageIds,
    loadStages, refreshAll, applyFilters, resetFilters, loadTrend,
  }
})
