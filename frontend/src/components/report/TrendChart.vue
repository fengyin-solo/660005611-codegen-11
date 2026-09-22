<template>
  <div class="card">
    <div class="card-head">
      <h3>📈 最近执行耗时趋势对照</h3>
      <div class="head-actions">
        <el-select v-model="store.trendStageIds" multiple collapse-tags collapse-tags-tooltip
                   size="small" class="stage-select" @change="reload">
          <el-option v-for="s in store.stages" :key="s.id" :value="s.id" :label="s.name" />
        </el-select>
        <el-select v-model="store.trendLimit" size="small" style="width:130px" @change="reload">
          <el-option :value="5" label="最近 5 次" />
          <el-option :value="10" label="最近 10 次" />
          <el-option :value="20" label="最近 20 次" />
          <el-option :value="30" label="最近 30 次" />
        </el-select>
      </div>
    </div>
    <div ref="chartEl" class="chart"></div>
    <p class="hint">范围与顶部时间筛选一致；失败执行未到达的环节没有数据，折线在此处断开（按 0 参与汇总但不伪造为 0 ms）。</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import * as echarts from 'echarts'
import { useReportStore } from '../../store/report'
import { formatRunLabel } from '../../utils/format'

const store = useReportStore()
const chartEl = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null

const PALETTE = ['#bb86fc', '#60a5fa', '#34d399', '#fbbf24', '#f87171', '#22d3ee', '#f472b6', '#a3e635', '#fb923c', '#818cf8', '#e879f9']

function render() {
  if (!chart) return
  const t = store.trend
  if (!t) { chart.clear(); return }
  const xLabels = t.executions.map((e, i) => `#${e.id} ${formatRunLabel(e.startTime)}`)
  const nameOf = (id: string) => store.stages.find(s => s.id === id)?.name || id

  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1a1a2e', borderColor: '#2a2a4a', textStyle: { color: '#e0e0e0' },
      formatter(params: any[]) {
        const run = t.executions[params[0].dataIndex]
        const lines = params
          .filter(p => p.value != null)
          .map(p => `${p.marker}${p.seriesName}: <b>${(p.value / 1000).toFixed(2)} s</b>`)
        return `${xLabels[params[0].dataIndex]} · ${run.status === 'SUCCESS' ? '成功' : '失败'}<br/>${lines.join('<br/>') || '无环节数据'}`
      },
    },
    legend: { textStyle: { color: '#9aa0b4', fontSize: 11 }, top: 0, type: 'scroll' },
    grid: { left: 50, right: 20, top: 36, bottom: 48 },
    xAxis: {
      type: 'category', data: xLabels, boundaryGap: false,
      axisLabel: { color: '#6b7280', fontSize: 10, rotate: 24 },
      axisLine: { lineStyle: { color: '#2a2a4a' } },
    },
    yAxis: {
      type: 'value', name: 'ms',
      axisLabel: { color: '#6b7280', formatter: (v: number) => v >= 1000 ? `${v / 1000}s` : `${v}` },
      splitLine: { lineStyle: { color: '#22223f' } },
      nameTextStyle: { color: '#6b7280' },
    },
    series: t.stages.map((id, i) => ({
      name: nameOf(id),
      type: 'line',
      smooth: true,
      symbol: 'circle',
      symbolSize: 7,
      connectNulls: false,
      lineStyle: { width: 2, color: PALETTE[i % PALETTE.length] },
      itemStyle: { color: PALETTE[i % PALETTE.length] },
      data: t.series[id]?.map(p => (p ? Math.round(p.durationMs) : null)) ?? [],
    })),
  }, { notMerge: true })
}

function reload() { store.loadTrend() }
function onResize() { chart?.resize() }

onMounted(async () => {
  await nextTick()
  chart = echarts.init(chartEl.value!)
  render()
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); chart?.dispose(); chart = null })
watch(() => store.trend, () => nextTick(render), { deep: true })
</script>

<style scoped>
.card { background:#1a1a2e; border:1px solid #2a2a4a; border-radius:8px; padding:12px }
.card-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:10px; flex-wrap:wrap }
.card-head h3 { color:#bb86fc; font-size:14px }
.head-actions { display:flex; gap:8px; align-items:center }
.stage-select { width:300px }
.chart { width:100%; height:320px }
.hint { font-size:11px; color:#6b7280; margin-top:6px }
</style>
