<template>
  <div class="card">
    <div class="card-head">
      <h3>📊 环节执行汇总</h3>
      <div class="overall">
        <span>筛选内执行 <b>{{ overall.executionCount }}</b> 次</span>
        <span>环节记录 <b>{{ formatNumber(overall.stageRowCount) }}</b> 条</span>
        <span>总条数 <b>{{ formatNumber(overall.totalRows) }}</b></span>
        <span>总耗时 <b>{{ formatDuration(overall.totalDurationMs) }}</b></span>
      </div>
    </div>

    <el-table :data="rows" size="small" :row-class-name="stripedRow" class="dark-table"
              :key="'summary-' + store.sortBy + store.sortOrder"
              @sort-change="onSortChange">
      <el-table-column prop="stageOrder" label="#" width="46" sortable="custom" />
      <el-table-column prop="taskName" label="环节" min-width="110" sortable="custom" />
      <el-table-column prop="execCount" label="执行次数" width="90" sortable="custom" align="right">
        <template #default="{ row }">{{ formatNumber(row.execCount) }}</template>
      </el-table-column>
      <el-table-column prop="totalRows" label="处理条数(合计)" width="130" sortable="custom" align="right">
        <template #default="{ row }">
          <a class="link" @click="drillStage(row.taskId)">{{ formatNumber(row.totalRows) }}</a>
        </template>
      </el-table-column>
      <el-table-column prop="avgRows" label="平均条数/次" width="120" sortable="custom" align="right">
        <template #default="{ row }">{{ formatNumber(Math.round(row.avgRows)) }}</template>
      </el-table-column>
      <el-table-column prop="totalDurationMs" label="处理耗时(合计)" width="130" sortable="custom" align="right">
        <template #default="{ row }">{{ formatDuration(row.totalDurationMs) }}</template>
      </el-table-column>
      <el-table-column prop="avgDurationMs" label="平均耗时/次" width="120" sortable="custom" align="right">
        <template #default="{ row }">{{ formatDuration(row.avgDurationMs) }}</template>
      </el-table-column>
      <el-table-column prop="pctDuration" label="耗时占比" min-width="180" sortable="custom">
        <template #default="{ row }">
          <div class="pct-cell">
            <div class="pct-bar"><div class="pct-fill" :style="{ width: (row.pctDuration * 100) + '%' }"></div></div>
            <span class="pct-text">{{ formatPct(row.pctDuration) }}</span>
          </div>
        </template>
      </el-table-column>
    </el-table>

    <div class="pager">
      <span class="total-hint">共 {{ store.summary?.total ?? 0 }} 个环节（总数不随翻页变化）</span>
      <el-pagination
        size="small"
        layout="sizes, prev, pager, next, jumper"
        :total="store.summary?.total ?? 0"
        :current-page="store.summaryPage"
        :page-size="store.summaryPageSize"
        :page-sizes="[11, 20, 50]"
        @current-change="onPageChange"
        @size-change="onSizeChange"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useReportStore } from '../../store/report'
import { formatDuration, formatNumber, formatPct } from '../../utils/format'

const emit = defineEmits<{ (e: 'drill', taskId: string): void }>()
const store = useReportStore()
const rows = computed(() => store.summary?.items ?? [])
const overall = computed(() => store.summary?.overall ?? {
  executionCount: 0, stageRowCount: 0, totalRows: 0, totalDurationMs: 0,
})

function onSortChange({ prop, order }: { prop: string; order: string | null }) {
  store.sortBy = prop
  store.sortOrder = order === 'descending' ? 'desc' : 'asc'
  store.summaryPage = 1
  store.refreshAll()
}

function onPageChange(p: number) {
  store.summaryPage = p
  store.refreshAll()
}

function onSizeChange(size: number) {
  store.summaryPageSize = size
  store.summaryPage = 1
  store.refreshAll()
}

function drillStage(taskId: string) {
  emit('drill', taskId)
}

function stripedRow({ rowIndex }: { row: unknown; rowIndex: number }) {
  return rowIndex % 2 === 1 ? 'report-striped' : ''
}
</script>

<style scoped>
.card { background:#1a1a2e; border:1px solid #2a2a4a; border-radius:8px; padding:12px; margin-bottom:12px }
.card-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; gap:12px; flex-wrap:wrap }
.card-head h3 { color:#bb86fc; font-size:14px }
.overall { display:flex; gap:14px; font-size:12px; color:#9aa0b4 }
.overall b { color:#e0e0e0 }
.pager { display:flex; justify-content:space-between; align-items:center; margin-top:10px }
.total-hint { font-size:12px; color:#6b7280 }
.pct-cell { display:flex; align-items:center; gap:8px }
.pct-bar { flex:1; height:8px; background:#26264a; border-radius:4px; overflow:hidden; min-width:60px }
.pct-fill { height:100%; background:linear-gradient(90deg,#7c3aed,#bb86fc); border-radius:4px }
.pct-text { font-size:11px; color:#c4b5fd; width:46px; text-align:right }
.link { color:#60a5fa; cursor:pointer; text-decoration:underline dotted }
.link:hover { color:#93c5fd }
</style>
