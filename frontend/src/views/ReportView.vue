<template>
  <div class="report-view">
    <!-- 筛选栏：汇总表 / 明细表 / 趋势图共用同一份筛选条件 -->
    <div class="filter-bar">
      <span class="f-label">执行开始时间</span>
      <el-date-picker
        v-model="dateRange" type="datetimerange" size="small" range-separator="至"
        start-placeholder="开始时间" end-placeholder="结束时间"
        format="MM-DD HH:mm" value-format="x" :clearable="false" style="width: 330px"
        @change="onDateChange"
      />
      <el-radio-group v-model="quickRange" size="small" @change="onQuickRange">
        <el-radio-button label="today">今天</el-radio-button>
        <el-radio-button label="7d">近7天</el-radio-button>
        <el-radio-button label="14d">近14天</el-radio-button>
        <el-radio-button label="all">全部</el-radio-button>
      </el-radio-group>
      <el-select
        v-model="filter.stageIds" multiple collapse-tags collapse-tags-tooltip size="small"
        placeholder="全部环节" style="min-width: 200px"
        @change="applyFilter"
      >
        <el-option v-for="s in stages" :key="s.stageId" :value="s.stageId" :label="s.stageName" />
      </el-select>
      <el-button size="small" @click="resetFilter">重置</el-button>
      <el-button size="small" type="primary" plain :loading="loading" @click="reloadAll">刷新</el-button>
      <span class="f-hint">口径：汇总、明细、趋势均按「执行开始时间 + 环节」筛选</span>
    </div>

    <!-- 概览数字 -->
    <div class="stat-row">
      <div class="stat-card"><div class="s-num">{{ summary?.executionCount ?? '-' }}</div><div class="s-label">执行次数</div></div>
      <div class="stat-card"><div class="s-num">{{ fmtInt(summary?.totalRows) }}</div><div class="s-label">处理条数合计</div></div>
      <div class="stat-card"><div class="s-num">{{ fmtDur(summary?.totalDurationMs) }}</div><div class="s-label">环节总耗时</div></div>
      <div class="stat-card"><div class="s-num">{{ summary?.totalStages ?? '-' }}</div><div class="s-label">参与环节(含0数据)</div></div>
    </div>

    <!-- 按环节汇总 -->
    <div class="card">
      <div class="card-h">
        <h4>📊 按环节汇总</h4>
        <span class="muted">共 {{ sortedSummary.length }} 个环节，缺数据环节按 0 参与；点击某行可在下方明细中只看该环节</span>
      </div>
      <el-table
        :data="pagedSummary" size="small" height="300" border stripe
        :header-cell-class-name="darkCell" :cell-class-name="darkCell"
        :default-sort="{ prop: 'seq', order: 'ascending' }"
        @sort-change="onSortChange"
        @row-click="onStageRowClick" :row-class-name="rowCls"
      >
        <el-table-column label="环节" prop="seq" min-width="110" sortable="custom">
          <template #default="{ row }">
            <span>{{ row.stageName }}</span>
            <el-tag v-if="row.executionCount === 0" size="small" type="info" effect="dark" class="zero-tag">0 数据</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="执行次数" prop="executionCount" width="90" sortable="custom" align="right" />
        <el-table-column label="处理条数" prop="totalRows" width="120" sortable="custom" align="right">
          <template #default="{ row }">{{ fmtInt(row.totalRows) }}</template>
        </el-table-column>
        <el-table-column label="总耗时" prop="totalDurationMs" width="110" sortable="custom" align="right">
          <template #default="{ row }">{{ fmtDur(row.totalDurationMs) }}</template>
        </el-table-column>
        <el-table-column label="平均耗时/次" prop="avgDurationMs" width="120" sortable="custom" align="right">
          <template #default="{ row }">{{ row.executionCount ? fmtDur(row.avgDurationMs) : '—' }}</template>
        </el-table-column>
        <el-table-column label="耗时占比" prop="durationRatio" width="170" sortable="custom">
          <template #default="{ row }">
            <div class="ratio-cell">
              <el-progress
                :percentage="pct(row.durationRatio)" :stroke-width="10"
                :color="ratioColor(row.durationRatio)" :show-text="false" class="ratio-bar"
              />
              <span class="ratio-txt">{{ (row.durationRatio * 100).toFixed(1) }}%</span>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div class="pager">
        <el-pagination
          v-model:current-page="sumPage" v-model:page-size="sumPageSize" size="small"
          :page-sizes="[5, 10, 20]" :total="sortedSummary.length"
          layout="total, sizes, prev, pager, next, jump"
        />
      </div>
    </div>

    <!-- 最近若干次执行耗时趋势对照 -->
    <div class="card">
      <div class="card-h">
        <h4>📈 最近执行耗时趋势（按环节对照）</h4>
        <div class="trend-tools">
          <span class="muted">最近</span>
          <el-select v-model="trendLimit" size="small" style="width: 90px" @change="loadTrend">
            <el-option :value="5" label="5 次" /><el-option :value="10" label="10 次" />
            <el-option :value="20" label="20 次" />
          </el-select>
          <span class="muted">次执行，单位秒；断线/0 表示该次执行该环节无数据</span>
        </div>
      </div>
      <div ref="trendChartEl" class="trend-chart"></div>
    </div>

    <!-- 明细核对 -->
    <div class="card">
      <div class="card-h">
        <h4>🔍 执行明细（逐条核对）</h4>
        <span class="muted">
          与上方汇总同一筛选口径；当前共 {{ details?.total ?? 0 }} 条
          <el-button
            v-if="filter.stageIds.length" link type="primary" size="small"
            @click="filter.stageIds = []; applyFilter()"
          >清除环节过滤({{ filter.stageIds.length }})</el-button>
        </span>
      </div>
      <el-table
        :data="details?.items ?? []" size="small" height="330" border stripe
        :header-cell-class-name="darkCell" :cell-class-name="darkCell" v-loading="detailsLoading"
      >
        <el-table-column label="执行#" prop="executionId" width="80" />
        <el-table-column label="执行状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.executionStatus === 'SUCCESS' ? 'success' : 'danger'" effect="dark">
              {{ row.executionStatus === 'SUCCESS' ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="环节" prop="stageName" min-width="110" />
        <el-table-column label="条数" prop="rowCount" width="120" align="right">
          <template #default="{ row }">{{ fmtInt(row.rowCount) }}</template>
        </el-table-column>
        <el-table-column label="耗时" width="110" align="right">
          <template #default="{ row }">{{ fmtDur(row.durationMs) }}</template>
        </el-table-column>
        <el-table-column label="重试" prop="retries" width="70" align="center" />
        <el-table-column label="开始时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.startedAt) }}</template>
        </el-table-column>
        <el-table-column label="结束时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.endedAt) }}</template>
        </el-table-column>
      </el-table>
      <div class="pager">
        <el-pagination
          v-model:current-page="detailPage" v-model:page-size="detailPageSize" size="small"
          :page-sizes="[10, 20, 50]" :total="details?.total ?? 0"
          layout="total, sizes, prev, pager, next, jump"
          @current-change="loadDetails" @size-change="onDetailSizeChange"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as echarts from 'echarts'
import type { StageDef, SummaryResult, SummaryItem, DetailsResult, TrendResult } from '@/types'
import { fetchStages, fetchSummary, fetchDetails, fetchTrend } from '@/api/report'

const DAY = 24 * 3600 * 1000
const now = Date.now()

const stages = ref<StageDef[]>([])
const loading = ref(false)
const detailsLoading = ref(false)

// 单一筛选条件来源：切换时间范围不会清掉环节选择
const filter = ref({ start: now - 14 * DAY, end: now, stageIds: [] as string[] })
const dateRange = ref<[string, string]>([String(filter.value.start), String(filter.value.end)])
const quickRange = ref('14d')

const summary = ref<SummaryResult | null>(null)
const details = ref<DetailsResult | null>(null)
const trend = ref<TrendResult | null>(null)

// 汇总表排序（前端对当前筛选的完整结果排序，分页只是视图层切片）
type SortKey = 'seq' | 'executionCount' | 'totalRows' | 'totalDurationMs' | 'avgDurationMs' | 'durationRatio'
const sortProp = ref<SortKey>('seq')
const sortAsc = ref(true)
const sumPage = ref(1)
const sumPageSize = ref(10)

// 明细分页（服务端分页：先 count 再取页，翻到后面几页 total 不变）
const detailPage = ref(1)
const detailPageSize = ref(10)

const trendLimit = ref(10)
const trendChartEl = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null

const darkCell = () => 'dark-cell'
const rowCls = ({ row }: { row: SummaryItem }) => (row.executionCount === 0 ? 'zero-row' : 'clickable-row')

const sortedSummary = computed<SummaryItem[]>(() => {
  const items = [...(summary.value?.items ?? [])]
  items.sort((a, b) => {
    const va = a[sortProp.value], vb = b[sortProp.value]
    return sortAsc.value ? va - vb : vb - va
  })
  return items
})
const pagedSummary = computed(() =>
  sortedSummary.value.slice((sumPage.value - 1) * sumPageSize.value, sumPage.value * sumPageSize.value)
)

// 数据刷新后若当前页超出范围（筛选导致行数变少），收回最后一页，避免空页
watch(sortedSummary, (items) => {
  const maxPage = Math.max(1, Math.ceil(items.length / sumPageSize.value))
  if (sumPage.value > maxPage) sumPage.value = maxPage
})

function onSortChange({ prop, order }: { prop: string; order: string | null }) {
  sortProp.value = (prop || 'seq') as SortKey
  sortAsc.value = order !== 'descending'
  sumPage.value = 1
}

// ---- 筛选操作 ----
function onDateChange(val: [string, string] | null) {
  if (!val) return
  filter.value.start = Number(val[0])
  filter.value.end = Number(val[1])
  quickRange.value = ''
  applyFilter()
}
function onQuickRange(v: string | number | boolean | undefined) {
  const key = String(v)
  const end = Date.now()
  if (key === 'today') {
    filter.value.start = new Date().setHours(0, 0, 0, 0)
  } else if (key === '7d') {
    filter.value.start = end - 7 * DAY
  } else if (key === '14d') {
    filter.value.start = end - 14 * DAY
  } else {
    filter.value.start = 0 // 全部：后端会按数据实际范围返回
  }
  filter.value.end = end
  dateRange.value = [String(filter.value.start), String(filter.value.end)]
  applyFilter()
}
function resetFilter() {
  filter.value.start = Date.now() - 14 * DAY
  filter.value.end = Date.now()
  filter.value.stageIds = []
  dateRange.value = [String(filter.value.start), String(filter.value.end)]
  quickRange.value = '14d'
  applyFilter()
}
// 任何筛选变化：页码归 1，但环节条件始终保留
function applyFilter() {
  sumPage.value = 1
  detailPage.value = 1
  reloadAll()
}
async function reloadAll() {
  loading.value = true
  try {
    await Promise.all([loadSummary(), loadDetails(), loadTrend()])
  } finally {
    loading.value = false
  }
}

async function loadSummary() {
  summary.value = await fetchSummary(filter.value)
}
async function loadDetails() {
  detailsLoading.value = true
  try {
    details.value = await fetchDetails(filter.value, detailPage.value, detailPageSize.value)
  } finally {
    detailsLoading.value = false
  }
}
function onDetailSizeChange(size: number) {
  detailPageSize.value = size
  detailPage.value = 1
  loadDetails()
}
function onStageRowClick(row: SummaryItem) {
  // 点击汇总行：用同一份筛选条件联动明细，方便逐条核对
  filter.value.stageIds = [row.stageId]
  applyFilter()
}

// ---- 趋势图 ----
const CHART_COLORS = ['#bb86fc', '#3182ce', '#38a169', '#e53e3e', '#d69e2e', '#06b6d4',
  '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#a78bfa']
async function loadTrend() {
  trend.value = await fetchTrend(filter.value, trendLimit.value)
  renderChart()
}
function renderChart() {
  if (!chart || !trend.value) return
  const cats = trend.value.executions.map(e => `#${e.id} ${fmtTime(e.startedAt).slice(5, 11)}`)
  chart.setOption({
    backgroundColor: 'transparent',
    title: cats.length ? undefined : {
      text: '该时间范围内暂无执行记录', left: 'center', top: 'center',
      textStyle: { color: '#6b7280', fontSize: 13, fontWeight: 'normal' },
    },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => v ? (v / 1000).toFixed(2) + ' s' : '无数据' },
    legend: { type: 'scroll', top: 0, textStyle: { color: '#9ca3af', fontSize: 10 }, pageTextStyle: { color: '#9ca3af' } },
    grid: { left: 48, right: 16, top: 38, bottom: 28 },
    xAxis: { type: 'category', data: cats, axisLabel: { color: '#888', fontSize: 10 } },
    yAxis: {
      type: 'value', name: '秒', nameTextStyle: { color: '#888' },
      axisLabel: { color: '#888', formatter: (v: number) => (v / 1000).toFixed(1) },
      splitLine: { lineStyle: { color: '#2a2a4a' } },
    },
    series: trend.value.series.map((s, i) => ({
      name: s.stageName,
      type: 'line',
      connectNulls: false,
      symbol: 'circle', symbolSize: 5,
      itemStyle: { color: CHART_COLORS[i % CHART_COLORS.length] },
      // 0 表示该环节本次无数据，图上断线而不是连成 0
      data: s.values.map(v => (v > 0 ? v : null)),
    })),
  }, true)
}

// ---- 格式化 ----
function fmtInt(v?: number) { return v == null ? '—' : v.toLocaleString('zh-CN') }
function fmtDur(ms?: number) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  return ms < 60000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 60000).toFixed(1)} min`
}
function pct(r: number) { return Math.round(r * 1000) / 10 }
function ratioColor(r: number) {
  if (r >= 0.15) return '#e53e3e'
  if (r >= 0.08) return '#d69e2e'
  return '#38a169'
}
function fmtTime(ms: number) {
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function onResize() { chart?.resize() }

onMounted(async () => {
  chart = echarts.init(trendChartEl.value!)
  window.addEventListener('resize', onResize)
  stages.value = await fetchStages()
  await reloadAll()
  await nextTick()
  chart?.resize()
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  chart?.dispose()
})
</script>

<style scoped>
.report-view { padding: 12px 16px 24px; display: flex; flex-direction: column; gap: 12px; height: 100%; overflow-y: auto; }
.filter-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; padding: 10px 12px; }
.f-label { color: #bb86fc; font-size: 12px; font-weight: 600; }
.f-hint { color: #6b7280; font-size: 11px; }
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.stat-card { background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; padding: 10px 14px; }
.s-num { font-size: 20px; font-weight: 700; color: #bb86fc; }
.s-label { color: #888; font-size: 11px; margin-top: 2px; }
.card { background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px; padding: 10px 12px; }
.card-h { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 10px; flex-wrap: wrap; }
.card-h h4 { color: #e0e0e0; font-size: 13px; }
.muted { color: #888; font-size: 11px; }
.pager { display: flex; justify-content: flex-end; margin-top: 8px; }
.ratio-cell { display: flex; align-items: center; gap: 8px; }
.ratio-bar { flex: 1; min-width: 60px; }
.ratio-txt { font-size: 11px; color: #ccc; min-width: 44px; text-align: right; }
.zero-tag { margin-left: 6px; transform: scale(0.85); }
.trend-chart { width: 100%; height: 280px; }
:deep(.dark-cell) { background: #16162a !important; color: #e0e0e0 !important; border-color: #2a2a4a !important; }
:deep(.el-table th.dark-cell) { background: #101020 !important; color: #bb86fc !important; }
:deep(.clickable-row) { cursor: pointer; }
:deep(.zero-row) { color: #6b7280; cursor: pointer; }
:deep(.el-range-separator), :deep(.el-range-input) { color: #ccc; }
:deep(.el-pagination) { color: #aaa; --el-pagination-bg-color: transparent; --el-pagination-button-bg-color: #101020; --el-pagination-hover-color: #bb86fc; }
:deep(.el-pagination button:disabled) { background: #101020; color: #555; }
:deep(.el-pagination .el-pager li) { background: #101020; color: #ccc; }
:deep(.el-pagination .el-pager li.is-active) { color: #bb86fc; }
</style>
