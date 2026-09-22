<template>
  <div class="card">
    <div class="card-head">
      <h3>🔎 执行明细核对</h3>
      <div class="head-actions">
        <el-tag v-if="store.detailTaskId" closable type="primary" size="small" @close="clearStage">
          已限定环节：{{ stageName }}
        </el-tag>
        <el-checkbox :model-value="showReconcile" size="small" @change="toggleReconcile">显示口径核对</el-checkbox>
      </div>
    </div>

    <el-table :data="rows" size="small" :row-class-name="stripedRow" class="dark-table" height="340">
      <el-table-column prop="executionId" label="执行#" width="70" />
      <el-table-column label="执行开始时间" width="160">
        <template #default="{ row }">{{ formatDateTime(row.executionStartTime) }}</template>
      </el-table-column>
      <el-table-column prop="executionStatus" label="执行状态" width="90">
        <template #default="{ row }">
          <span class="status" :class="row.executionStatus.toLowerCase()">{{ statusText(row.executionStatus) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="taskName" label="环节" min-width="100">
        <template #default="{ row }">
          {{ row.taskName }}
          <span class="tid">({{ row.taskId }})</span>
        </template>
      </el-table-column>
      <el-table-column prop="status" label="环节结果" width="80">
        <template #default="{ row }">
          <span class="status" :class="row.status.toLowerCase()">{{ statusText(row.status) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="rowCount" label="条数" width="110" align="right">
        <template #default="{ row }">{{ formatNumber(row.rowCount) }}</template>
      </el-table-column>
      <el-table-column prop="durationMs" label="处理耗时" width="110" align="right">
        <template #default="{ row }">{{ formatDuration(row.durationMs) }}</template>
      </el-table-column>
      <el-table-column prop="retries" label="重试" width="60" align="right" />
    </el-table>

    <div class="pager">
      <el-pagination
        size="small"
        layout="total, sizes, prev, pager, next, jumper"
        :total="store.details?.total ?? 0"
        :current-page="store.detailPage"
        :page-size="store.detailPageSize"
        :page-sizes="[10, 20, 50]"
        @current-change="onPageChange"
        @size-change="onSizeChange"
      />
    </div>

    <!-- Reconciliation block: totals here are computed by the SAME shared
         filter SQL as the summary endpoint — they must match exactly. -->
    <el-collapse v-model="activePanels" class="reconcile-collapse">
      <el-collapse-item name="r">
        <template #title>
          <span class="recon-title">
            口径核对（筛选条件与汇总表完全一致）
            <span class="recon-ok" v-if="reconciled">✓ 两处一致</span>
            <span class="recon-bad" v-else>✗ 数据不一致，请刷新</span>
          </span>
        </template>
        <div class="recon-grid">
          <div class="recon-item">
            <span>环节记录条数</span>
            <b>{{ formatNumber(detailTotals.stageRowCount) }}</b>
            <i>汇总：{{ formatNumber(reconStageRowCount) }}</i>
          </div>
          <div class="recon-item">
            <span>处理条数合计</span>
            <b>{{ formatNumber(detailTotals.totalRows) }}</b>
            <i>汇总：{{ formatNumber(reconTotalRows) }}</i>
          </div>
          <div class="recon-item">
            <span>处理耗时合计</span>
            <b>{{ formatDuration(detailTotals.totalDurationMs) }}</b>
            <i>汇总：{{ formatDuration(reconTotalDurationMs) }}</i>
          </div>
        </div>
        <p class="recon-note">
          注：翻页只改变展示的明细行，合计与总条数恒定；点击汇总表中的环节条数可在此限定到该环节，
          此时与汇总表对应行核对。清空环节限定后恢复与整表核对。
        </p>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useReportStore } from '../../store/report'
import { formatDateTime, formatDuration, formatNumber } from '../../utils/format'

const store = useReportStore()
const showReconcile = ref(true)
const activePanels = ref<string[]>(['r'])
function toggleReconcile(v: boolean) {
  showReconcile.value = v
  activePanels.value = v ? ['r'] : []
}
const rows = computed(() => store.details?.items ?? [])

const stageName = computed(() =>
  store.stages.find(s => s.id === store.detailTaskId)?.name || store.detailTaskId)

const detailTotals = computed(() => store.details?.totals ?? { stageRowCount: 0, totalRows: 0, totalDurationMs: 0 })
const summaryOverall = computed(() => store.reconcileSummary?.overall ?? { stageRowCount: 0, totalRows: 0, totalDurationMs: 0 })

const matchedSummary = computed(() =>
  store.reconcileSummary?.items.find(i => i.taskId === store.detailTaskId))

// When drilling into one stage, compare against that stage's row in the full
// (page-independent) summary fetched for reconciliation; otherwise compare
// against the grand-total overall block.
const reconStageRowCount = computed(() => matchedSummary.value?.execCount ?? summaryOverall.value.stageRowCount)
const reconTotalRows = computed(() => matchedSummary.value?.totalRows ?? summaryOverall.value.totalRows)
const reconTotalDurationMs = computed(() => matchedSummary.value?.totalDurationMs ?? summaryOverall.value.totalDurationMs)

const reconciled = computed(() => {
  const d = detailTotals.value
  const m = matchedSummary.value
  const baseCount = m ? m.execCount : summaryOverall.value.stageRowCount
  const baseRows = m ? m.totalRows : summaryOverall.value.totalRows
  const baseDuration = m ? m.totalDurationMs : summaryOverall.value.totalDurationMs
  return d.totalRows === baseRows
    && Math.abs(d.totalDurationMs - baseDuration) < 1e-6
    && d.stageRowCount === baseCount
})

function statusText(s: string) {
  return { SUCCESS: '成功', FAILED: '失败', RUNNING: '运行中' }[s] || s
}
function onPageChange(p: number) { store.detailPage = p; store.refreshAll() }
function onSizeChange(size: number) { store.detailPageSize = size; store.detailPage = 1; store.refreshAll() }
function clearStage() {
  store.detailTaskId = ''
  store.detailPage = 1
  store.refreshAll()
}

function stripedRow({ rowIndex }: { row: unknown; rowIndex: number }) {
  return rowIndex % 2 === 1 ? 'report-striped' : ''
}
defineExpose({ clearStage })
</script>

<style scoped>
.card { background:#1a1a2e; border:1px solid #2a2a4a; border-radius:8px; padding:12px }
.card-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px }
.card-head h3 { color:#bb86fc; font-size:14px }
.head-actions { display:flex; gap:10px; align-items:center }
.pager { margin-top:10px; display:flex; justify-content:flex-end }
.tid { color:#6b7280; font-size:10px }
.status { font-weight:700; font-size:11px }
.status.success { color:#34d399 }
.status.failed { color:#f87171 }
.status.running { color:#fbbf24 }
.reconcile-collapse { margin-top:6px; border-top:1px dashed #2a2a4a }
.recon-title { font-size:12px; color:#c4b5fd }
.recon-ok { color:#34d399; margin-left:10px; font-weight:700 }
.recon-bad { color:#f87171; margin-left:10px; font-weight:700 }
.recon-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin:8px 0 }
.recon-item { background:#14142b; border-radius:6px; padding:8px 10px; font-size:12px; display:flex; flex-direction:column; gap:3px }
.recon-item span { color:#9aa0b4 }
.recon-item b { color:#e0e0e0; font-size:14px }
.recon-item i { color:#6b7280; font-style:normal; font-size:11px }
.recon-note { font-size:11px; color:#6b7280; margin-top:4px }
</style>
