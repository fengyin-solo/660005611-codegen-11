<template>
  <div class="report-root">
    <div class="filter-bar card">
      <span class="label">时间范围</span>
      <el-date-picker
        v-model="store.timeRange"
        type="datetimerange"
        range-separator="至"
        start-placeholder="开始时间"
        end-placeholder="结束时间"
        format="MM-DD HH:mm"
        size="small"
        style="width:340px"
      />
      <span class="label">执行状态</span>
      <el-select v-model="store.status" size="small" style="width:110px" clearable placeholder="全部">
        <el-option label="成功" value="SUCCESS" />
        <el-option label="失败" value="FAILED" />
        <el-option label="运行中" value="RUNNING" />
      </el-select>
      <el-button type="primary" size="small" :loading="store.loading" @click="store.applyFilters()">筛选</el-button>
      <el-button size="small" @click="store.resetFilters()">重置</el-button>
      <el-button size="small" @click="store.refreshAll()">刷新</el-button>
      <el-button size="small" type="info" plain @click="resample">重建演示数据</el-button>
      <span v-if="store.error" class="err">{{ store.error }}</span>
      <span v-else-if="store.loading" class="loading-hint">加载中…</span>
      <span class="scope-hint">
        当前口径：{{ scopeText }} —— 汇总、明细、趋势共用同一筛选条件
      </span>
    </div>

    <SummaryTable @drill="onDrillStage" />
    <DetailTable ref="detailRef" />
    <TrendChart />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import SummaryTable from '../components/report/SummaryTable.vue'
import DetailTable from '../components/report/DetailTable.vue'
import TrendChart from '../components/report/TrendChart.vue'
import { useReportStore } from '../store/report'
import { seedDemo } from '../api/report'
import { formatDateTime } from '../utils/format'

const store = useReportStore()
const detailRef = ref<InstanceType<typeof DetailTable>>()

const scopeText = computed(() => {
  const [s, e] = store.timeRange ?? []
  const range = s && e ? `${formatDateTime(s.getTime() / 1000)} ~ ${formatDateTime(e.getTime() / 1000)}` : '全部时间'
  const st = { SUCCESS: '成功', FAILED: '失败', RUNNING: '运行中' }[store.status] || '全部状态'
  return `${range} / ${st}${store.detailTaskId ? ` / 环节:${store.detailTaskId}（仅明细）` : ''}`
})

async function onDrillStage(taskId: string) {
  // Keep all shared filters; only the detail table narrows to one stage and
  // jumps back to page 1. Summary/trend are untouched so totals stay visible.
  store.detailTaskId = taskId
  store.detailPage = 1
  await store.refreshAll()
  await nextTick()
  detailRef.value?.$el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function resample() {
  await seedDemo(60, 21)
  await store.resetFilters()
}

onMounted(async () => {
  await store.loadStages()
  await store.refreshAll()
})
</script>

<style scoped>
.report-root {
  padding:14px 18px; height:100%; overflow-y:auto;
  /* Dark-theme overrides for Element Plus controls used inside the report */
  --el-bg-color: #14142b;
  --el-bg-color-overlay: #1a1a2e;
  --el-fill-color-blank: #14142b;
  --el-fill-color-light: #22223f;
  --el-text-color-primary: #e0e0e0;
  --el-text-color-regular: #c4c4d8;
  --el-text-color-placeholder: #6b7280;
  --el-border-color: #2a2a4a;
  --el-border-color-light: #2a2a4a;
  --el-border-color-lighter: #2a2a4a;
  --el-border-color-extra-light: #2a2a4a;
  --el-mask-color: rgba(10,10,25,0.8);
  color: #e0e0e0;
}
.report-root :deep(.el-table) { --el-table-bg-color: transparent; --el-table-tr-bg-color: transparent;
  --el-table-row-hover-bg-color: #22223f; --el-table-header-bg-color: #20203c;
  --el-table-header-text-color: #bb86fc; --el-table-border-color: #2a2a4a;
  --el-table-text-color: #d8d8e8; background: transparent }
.report-root :deep(.report-striped) { background: rgba(255,255,255,0.025) !important }
.report-root :deep(.el-pagination) { --el-pagination-bg-color: #14142b; --el-pagination-button-color:#c4c4d8;
  --el-pagination-hover-color: #bb86fc; color:#c4c4d8 }
.report-root :deep(.el-pagination .el-pager li.is-active) { color:#14142b }
.report-root :deep(.el-collapse), .report-root :deep(.el-collapse-item__header),
.report-root :deep(.el-collapse-item__wrap), .report-root :deep(.el-collapse-item__content) {
  background: transparent; border-color: #2a2a4a; color: #d8d8e8 }
.report-root :deep(.el-input__wrapper), .report-root :deep(.el-select__wrapper) {
  background-color: #14142b; box-shadow: 0 0 0 1px #2a2a4a inset }
.report-root :deep(.el-popper) { background:#1a1a2e; border:1px solid #2a2a4a }
.report-root :deep(.el-popper .el-popper__arrow::before) { background:#1a1a2e; border-color:#2a2a4a }
.filter-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px }
.filter-bar .label { font-size:12px; color:#9aa0b4 }
.card { background:#1a1a2e; border:1px solid #2a2a4a; border-radius:8px; padding:10px 12px }
.err { color:#f87171; font-size:12px }
.loading-hint { color:#9aa0b4; font-size:12px }
.scope-hint { margin-left:auto; font-size:11px; color:#6b7280 }
</style>
