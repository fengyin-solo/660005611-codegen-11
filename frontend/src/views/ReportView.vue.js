/// <reference types="../../node_modules/.vue-global-types/vue_3.5_0_0_0.d.ts" />
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as echarts from 'echarts';
import { fetchStages, fetchSummary, fetchDetails, fetchTrend } from '@/api/report';
const DAY = 24 * 3600 * 1000;
const now = Date.now();
const stages = ref([]);
const loading = ref(false);
const detailsLoading = ref(false);
// 单一筛选条件来源：切换时间范围不会清掉环节选择
const filter = ref({ start: now - 14 * DAY, end: now, stageIds: [] });
const dateRange = ref([String(filter.value.start), String(filter.value.end)]);
const quickRange = ref('14d');
const summary = ref(null);
const details = ref(null);
const trend = ref(null);
const sortProp = ref('seq');
const sortAsc = ref(true);
const sumPage = ref(1);
const sumPageSize = ref(10);
// 明细分页（服务端分页：先 count 再取页，翻到后面几页 total 不变）
const detailPage = ref(1);
const detailPageSize = ref(10);
const trendLimit = ref(10);
const trendChartEl = ref();
let chart = null;
const darkCell = () => 'dark-cell';
const rowCls = ({ row }) => (row.executionCount === 0 ? 'zero-row' : 'clickable-row');
const sortedSummary = computed(() => {
    const items = [...(summary.value?.items ?? [])];
    items.sort((a, b) => {
        const va = a[sortProp.value], vb = b[sortProp.value];
        return sortAsc.value ? va - vb : vb - va;
    });
    return items;
});
const pagedSummary = computed(() => sortedSummary.value.slice((sumPage.value - 1) * sumPageSize.value, sumPage.value * sumPageSize.value));
// 数据刷新后若当前页超出范围（筛选导致行数变少），收回最后一页，避免空页
watch(sortedSummary, (items) => {
    const maxPage = Math.max(1, Math.ceil(items.length / sumPageSize.value));
    if (sumPage.value > maxPage)
        sumPage.value = maxPage;
});
function onSortChange({ prop, order }) {
    sortProp.value = (prop || 'seq');
    sortAsc.value = order !== 'descending';
    sumPage.value = 1;
}
// ---- 筛选操作 ----
function onDateChange(val) {
    if (!val)
        return;
    filter.value.start = Number(val[0]);
    filter.value.end = Number(val[1]);
    quickRange.value = '';
    applyFilter();
}
function onQuickRange(v) {
    const key = String(v);
    const end = Date.now();
    if (key === 'today') {
        filter.value.start = new Date().setHours(0, 0, 0, 0);
    }
    else if (key === '7d') {
        filter.value.start = end - 7 * DAY;
    }
    else if (key === '14d') {
        filter.value.start = end - 14 * DAY;
    }
    else {
        filter.value.start = 0; // 全部：后端会按数据实际范围返回
    }
    filter.value.end = end;
    dateRange.value = [String(filter.value.start), String(filter.value.end)];
    applyFilter();
}
function resetFilter() {
    filter.value.start = Date.now() - 14 * DAY;
    filter.value.end = Date.now();
    filter.value.stageIds = [];
    dateRange.value = [String(filter.value.start), String(filter.value.end)];
    quickRange.value = '14d';
    applyFilter();
}
// 任何筛选变化：页码归 1，但环节条件始终保留
function applyFilter() {
    sumPage.value = 1;
    detailPage.value = 1;
    reloadAll();
}
async function reloadAll() {
    loading.value = true;
    try {
        await Promise.all([loadSummary(), loadDetails(), loadTrend()]);
    }
    finally {
        loading.value = false;
    }
}
async function loadSummary() {
    summary.value = await fetchSummary(filter.value);
}
async function loadDetails() {
    detailsLoading.value = true;
    try {
        details.value = await fetchDetails(filter.value, detailPage.value, detailPageSize.value);
    }
    finally {
        detailsLoading.value = false;
    }
}
function onDetailSizeChange(size) {
    detailPageSize.value = size;
    detailPage.value = 1;
    loadDetails();
}
function onStageRowClick(row) {
    // 点击汇总行：用同一份筛选条件联动明细，方便逐条核对
    filter.value.stageIds = [row.stageId];
    applyFilter();
}
// ---- 趋势图 ----
const CHART_COLORS = ['#bb86fc', '#3182ce', '#38a169', '#e53e3e', '#d69e2e', '#06b6d4',
    '#ec4899', '#84cc16', '#f97316', '#14b8a6', '#a78bfa'];
async function loadTrend() {
    trend.value = await fetchTrend(filter.value, trendLimit.value);
    renderChart();
}
function renderChart() {
    if (!chart || !trend.value)
        return;
    const cats = trend.value.executions.map(e => `#${e.id} ${fmtTime(e.startedAt).slice(5, 11)}`);
    chart.setOption({
        backgroundColor: 'transparent',
        title: cats.length ? undefined : {
            text: '该时间范围内暂无执行记录', left: 'center', top: 'center',
            textStyle: { color: '#6b7280', fontSize: 13, fontWeight: 'normal' },
        },
        tooltip: { trigger: 'axis', valueFormatter: (v) => v ? (v / 1000).toFixed(2) + ' s' : '无数据' },
        legend: { type: 'scroll', top: 0, textStyle: { color: '#9ca3af', fontSize: 10 }, pageTextStyle: { color: '#9ca3af' } },
        grid: { left: 48, right: 16, top: 38, bottom: 28 },
        xAxis: { type: 'category', data: cats, axisLabel: { color: '#888', fontSize: 10 } },
        yAxis: {
            type: 'value', name: '秒', nameTextStyle: { color: '#888' },
            axisLabel: { color: '#888', formatter: (v) => (v / 1000).toFixed(1) },
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
    }, true);
}
// ---- 格式化 ----
function fmtInt(v) { return v == null ? '—' : v.toLocaleString('zh-CN'); }
function fmtDur(ms) {
    if (ms == null)
        return '—';
    if (ms < 1000)
        return `${ms} ms`;
    return ms < 60000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 60000).toFixed(1)} min`;
}
function pct(r) { return Math.round(r * 1000) / 10; }
function ratioColor(r) {
    if (r >= 0.15)
        return '#e53e3e';
    if (r >= 0.08)
        return '#d69e2e';
    return '#38a169';
}
function fmtTime(ms) {
    const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function onResize() { chart?.resize(); }
onMounted(async () => {
    chart = echarts.init(trendChartEl.value);
    window.addEventListener('resize', onResize);
    stages.value = await fetchStages();
    await reloadAll();
    await nextTick();
    chart?.resize();
});
onBeforeUnmount(() => {
    window.removeEventListener('resize', onResize);
    chart?.dispose();
});
debugger; /* PartiallyEnd: #3632/scriptSetup.vue */
const __VLS_ctx = {};
let __VLS_components;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['card-h']} */ ;
/** @type {__VLS_StyleScopedClasses['dark-cell']} */ ;
/** @type {__VLS_StyleScopedClasses['el-pagination']} */ ;
/** @type {__VLS_StyleScopedClasses['el-pagination']} */ ;
/** @type {__VLS_StyleScopedClasses['el-pagination']} */ ;
/** @type {__VLS_StyleScopedClasses['el-pager']} */ ;
// CSS variable injection 
// CSS variable injection end 
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "report-view" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "filter-bar" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "f-label" },
});
const __VLS_0 = {}.ElDatePicker;
/** @type {[typeof __VLS_components.ElDatePicker, typeof __VLS_components.elDatePicker, ]} */ ;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent(__VLS_0, new __VLS_0({
    ...{ 'onChange': {} },
    modelValue: (__VLS_ctx.dateRange),
    type: "datetimerange",
    size: "small",
    rangeSeparator: "至",
    startPlaceholder: "开始时间",
    endPlaceholder: "结束时间",
    format: "MM-DD HH:mm",
    valueFormat: "x",
    clearable: (false),
    ...{ style: {} },
}));
const __VLS_2 = __VLS_1({
    ...{ 'onChange': {} },
    modelValue: (__VLS_ctx.dateRange),
    type: "datetimerange",
    size: "small",
    rangeSeparator: "至",
    startPlaceholder: "开始时间",
    endPlaceholder: "结束时间",
    format: "MM-DD HH:mm",
    valueFormat: "x",
    clearable: (false),
    ...{ style: {} },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_4;
let __VLS_5;
let __VLS_6;
const __VLS_7 = {
    onChange: (__VLS_ctx.onDateChange)
};
var __VLS_3;
const __VLS_8 = {}.ElRadioGroup;
/** @type {[typeof __VLS_components.ElRadioGroup, typeof __VLS_components.elRadioGroup, typeof __VLS_components.ElRadioGroup, typeof __VLS_components.elRadioGroup, ]} */ ;
// @ts-ignore
const __VLS_9 = __VLS_asFunctionalComponent(__VLS_8, new __VLS_8({
    ...{ 'onChange': {} },
    modelValue: (__VLS_ctx.quickRange),
    size: "small",
}));
const __VLS_10 = __VLS_9({
    ...{ 'onChange': {} },
    modelValue: (__VLS_ctx.quickRange),
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_9));
let __VLS_12;
let __VLS_13;
let __VLS_14;
const __VLS_15 = {
    onChange: (__VLS_ctx.onQuickRange)
};
__VLS_11.slots.default;
const __VLS_16 = {}.ElRadioButton;
/** @type {[typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, ]} */ ;
// @ts-ignore
const __VLS_17 = __VLS_asFunctionalComponent(__VLS_16, new __VLS_16({
    label: "today",
}));
const __VLS_18 = __VLS_17({
    label: "today",
}, ...__VLS_functionalComponentArgsRest(__VLS_17));
__VLS_19.slots.default;
var __VLS_19;
const __VLS_20 = {}.ElRadioButton;
/** @type {[typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, ]} */ ;
// @ts-ignore
const __VLS_21 = __VLS_asFunctionalComponent(__VLS_20, new __VLS_20({
    label: "7d",
}));
const __VLS_22 = __VLS_21({
    label: "7d",
}, ...__VLS_functionalComponentArgsRest(__VLS_21));
__VLS_23.slots.default;
var __VLS_23;
const __VLS_24 = {}.ElRadioButton;
/** @type {[typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, ]} */ ;
// @ts-ignore
const __VLS_25 = __VLS_asFunctionalComponent(__VLS_24, new __VLS_24({
    label: "14d",
}));
const __VLS_26 = __VLS_25({
    label: "14d",
}, ...__VLS_functionalComponentArgsRest(__VLS_25));
__VLS_27.slots.default;
var __VLS_27;
const __VLS_28 = {}.ElRadioButton;
/** @type {[typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, typeof __VLS_components.ElRadioButton, typeof __VLS_components.elRadioButton, ]} */ ;
// @ts-ignore
const __VLS_29 = __VLS_asFunctionalComponent(__VLS_28, new __VLS_28({
    label: "all",
}));
const __VLS_30 = __VLS_29({
    label: "all",
}, ...__VLS_functionalComponentArgsRest(__VLS_29));
__VLS_31.slots.default;
var __VLS_31;
var __VLS_11;
const __VLS_32 = {}.ElSelect;
/** @type {[typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, ]} */ ;
// @ts-ignore
const __VLS_33 = __VLS_asFunctionalComponent(__VLS_32, new __VLS_32({
    ...{ 'onChange': {} },
    modelValue: (__VLS_ctx.filter.stageIds),
    multiple: true,
    collapseTags: true,
    collapseTagsTooltip: true,
    size: "small",
    placeholder: "全部环节",
    ...{ style: {} },
}));
const __VLS_34 = __VLS_33({
    ...{ 'onChange': {} },
    modelValue: (__VLS_ctx.filter.stageIds),
    multiple: true,
    collapseTags: true,
    collapseTagsTooltip: true,
    size: "small",
    placeholder: "全部环节",
    ...{ style: {} },
}, ...__VLS_functionalComponentArgsRest(__VLS_33));
let __VLS_36;
let __VLS_37;
let __VLS_38;
const __VLS_39 = {
    onChange: (__VLS_ctx.applyFilter)
};
__VLS_35.slots.default;
for (const [s] of __VLS_getVForSourceType((__VLS_ctx.stages))) {
    const __VLS_40 = {}.ElOption;
    /** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
    // @ts-ignore
    const __VLS_41 = __VLS_asFunctionalComponent(__VLS_40, new __VLS_40({
        key: (s.stageId),
        value: (s.stageId),
        label: (s.stageName),
    }));
    const __VLS_42 = __VLS_41({
        key: (s.stageId),
        value: (s.stageId),
        label: (s.stageName),
    }, ...__VLS_functionalComponentArgsRest(__VLS_41));
}
var __VLS_35;
const __VLS_44 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_45 = __VLS_asFunctionalComponent(__VLS_44, new __VLS_44({
    ...{ 'onClick': {} },
    size: "small",
}));
const __VLS_46 = __VLS_45({
    ...{ 'onClick': {} },
    size: "small",
}, ...__VLS_functionalComponentArgsRest(__VLS_45));
let __VLS_48;
let __VLS_49;
let __VLS_50;
const __VLS_51 = {
    onClick: (__VLS_ctx.resetFilter)
};
__VLS_47.slots.default;
var __VLS_47;
const __VLS_52 = {}.ElButton;
/** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
// @ts-ignore
const __VLS_53 = __VLS_asFunctionalComponent(__VLS_52, new __VLS_52({
    ...{ 'onClick': {} },
    size: "small",
    type: "primary",
    plain: true,
    loading: (__VLS_ctx.loading),
}));
const __VLS_54 = __VLS_53({
    ...{ 'onClick': {} },
    size: "small",
    type: "primary",
    plain: true,
    loading: (__VLS_ctx.loading),
}, ...__VLS_functionalComponentArgsRest(__VLS_53));
let __VLS_56;
let __VLS_57;
let __VLS_58;
const __VLS_59 = {
    onClick: (__VLS_ctx.reloadAll)
};
__VLS_55.slots.default;
var __VLS_55;
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "f-hint" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "stat-row" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "stat-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "s-num" },
});
(__VLS_ctx.summary?.executionCount ?? '-');
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "s-label" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "stat-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "s-num" },
});
(__VLS_ctx.fmtInt(__VLS_ctx.summary?.totalRows));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "s-label" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "stat-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "s-num" },
});
(__VLS_ctx.fmtDur(__VLS_ctx.summary?.totalDurationMs));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "s-label" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "stat-card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "s-num" },
});
(__VLS_ctx.summary?.totalStages ?? '-');
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "s-label" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-h" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h4, __VLS_intrinsicElements.h4)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "muted" },
});
(__VLS_ctx.sortedSummary.length);
const __VLS_60 = {}.ElTable;
/** @type {[typeof __VLS_components.ElTable, typeof __VLS_components.elTable, typeof __VLS_components.ElTable, typeof __VLS_components.elTable, ]} */ ;
// @ts-ignore
const __VLS_61 = __VLS_asFunctionalComponent(__VLS_60, new __VLS_60({
    ...{ 'onSortChange': {} },
    ...{ 'onRowClick': {} },
    data: (__VLS_ctx.pagedSummary),
    size: "small",
    height: "300",
    border: true,
    stripe: true,
    headerCellClassName: (__VLS_ctx.darkCell),
    cellClassName: (__VLS_ctx.darkCell),
    defaultSort: ({ prop: 'seq', order: 'ascending' }),
    rowClassName: (__VLS_ctx.rowCls),
}));
const __VLS_62 = __VLS_61({
    ...{ 'onSortChange': {} },
    ...{ 'onRowClick': {} },
    data: (__VLS_ctx.pagedSummary),
    size: "small",
    height: "300",
    border: true,
    stripe: true,
    headerCellClassName: (__VLS_ctx.darkCell),
    cellClassName: (__VLS_ctx.darkCell),
    defaultSort: ({ prop: 'seq', order: 'ascending' }),
    rowClassName: (__VLS_ctx.rowCls),
}, ...__VLS_functionalComponentArgsRest(__VLS_61));
let __VLS_64;
let __VLS_65;
let __VLS_66;
const __VLS_67 = {
    onSortChange: (__VLS_ctx.onSortChange)
};
const __VLS_68 = {
    onRowClick: (__VLS_ctx.onStageRowClick)
};
__VLS_63.slots.default;
const __VLS_69 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_70 = __VLS_asFunctionalComponent(__VLS_69, new __VLS_69({
    label: "环节",
    prop: "seq",
    minWidth: "110",
    sortable: "custom",
}));
const __VLS_71 = __VLS_70({
    label: "环节",
    prop: "seq",
    minWidth: "110",
    sortable: "custom",
}, ...__VLS_functionalComponentArgsRest(__VLS_70));
__VLS_72.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_72.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({});
    (row.stageName);
    if (row.executionCount === 0) {
        const __VLS_73 = {}.ElTag;
        /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
        // @ts-ignore
        const __VLS_74 = __VLS_asFunctionalComponent(__VLS_73, new __VLS_73({
            size: "small",
            type: "info",
            effect: "dark",
            ...{ class: "zero-tag" },
        }));
        const __VLS_75 = __VLS_74({
            size: "small",
            type: "info",
            effect: "dark",
            ...{ class: "zero-tag" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_74));
        __VLS_76.slots.default;
        var __VLS_76;
    }
}
var __VLS_72;
const __VLS_77 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_78 = __VLS_asFunctionalComponent(__VLS_77, new __VLS_77({
    label: "执行次数",
    prop: "executionCount",
    width: "90",
    sortable: "custom",
    align: "right",
}));
const __VLS_79 = __VLS_78({
    label: "执行次数",
    prop: "executionCount",
    width: "90",
    sortable: "custom",
    align: "right",
}, ...__VLS_functionalComponentArgsRest(__VLS_78));
const __VLS_81 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_82 = __VLS_asFunctionalComponent(__VLS_81, new __VLS_81({
    label: "处理条数",
    prop: "totalRows",
    width: "120",
    sortable: "custom",
    align: "right",
}));
const __VLS_83 = __VLS_82({
    label: "处理条数",
    prop: "totalRows",
    width: "120",
    sortable: "custom",
    align: "right",
}, ...__VLS_functionalComponentArgsRest(__VLS_82));
__VLS_84.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_84.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    (__VLS_ctx.fmtInt(row.totalRows));
}
var __VLS_84;
const __VLS_85 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_86 = __VLS_asFunctionalComponent(__VLS_85, new __VLS_85({
    label: "总耗时",
    prop: "totalDurationMs",
    width: "110",
    sortable: "custom",
    align: "right",
}));
const __VLS_87 = __VLS_86({
    label: "总耗时",
    prop: "totalDurationMs",
    width: "110",
    sortable: "custom",
    align: "right",
}, ...__VLS_functionalComponentArgsRest(__VLS_86));
__VLS_88.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_88.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    (__VLS_ctx.fmtDur(row.totalDurationMs));
}
var __VLS_88;
const __VLS_89 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_90 = __VLS_asFunctionalComponent(__VLS_89, new __VLS_89({
    label: "平均耗时/次",
    prop: "avgDurationMs",
    width: "120",
    sortable: "custom",
    align: "right",
}));
const __VLS_91 = __VLS_90({
    label: "平均耗时/次",
    prop: "avgDurationMs",
    width: "120",
    sortable: "custom",
    align: "right",
}, ...__VLS_functionalComponentArgsRest(__VLS_90));
__VLS_92.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_92.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    (row.executionCount ? __VLS_ctx.fmtDur(row.avgDurationMs) : '—');
}
var __VLS_92;
const __VLS_93 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_94 = __VLS_asFunctionalComponent(__VLS_93, new __VLS_93({
    label: "耗时占比",
    prop: "durationRatio",
    width: "170",
    sortable: "custom",
}));
const __VLS_95 = __VLS_94({
    label: "耗时占比",
    prop: "durationRatio",
    width: "170",
    sortable: "custom",
}, ...__VLS_functionalComponentArgsRest(__VLS_94));
__VLS_96.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_96.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    __VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
        ...{ class: "ratio-cell" },
    });
    const __VLS_97 = {}.ElProgress;
    /** @type {[typeof __VLS_components.ElProgress, typeof __VLS_components.elProgress, ]} */ ;
    // @ts-ignore
    const __VLS_98 = __VLS_asFunctionalComponent(__VLS_97, new __VLS_97({
        percentage: (__VLS_ctx.pct(row.durationRatio)),
        strokeWidth: (10),
        color: (__VLS_ctx.ratioColor(row.durationRatio)),
        showText: (false),
        ...{ class: "ratio-bar" },
    }));
    const __VLS_99 = __VLS_98({
        percentage: (__VLS_ctx.pct(row.durationRatio)),
        strokeWidth: (10),
        color: (__VLS_ctx.ratioColor(row.durationRatio)),
        showText: (false),
        ...{ class: "ratio-bar" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_98));
    __VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
        ...{ class: "ratio-txt" },
    });
    ((row.durationRatio * 100).toFixed(1));
}
var __VLS_96;
var __VLS_63;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "pager" },
});
const __VLS_101 = {}.ElPagination;
/** @type {[typeof __VLS_components.ElPagination, typeof __VLS_components.elPagination, ]} */ ;
// @ts-ignore
const __VLS_102 = __VLS_asFunctionalComponent(__VLS_101, new __VLS_101({
    currentPage: (__VLS_ctx.sumPage),
    pageSize: (__VLS_ctx.sumPageSize),
    size: "small",
    pageSizes: ([5, 10, 20]),
    total: (__VLS_ctx.sortedSummary.length),
    layout: "total, sizes, prev, pager, next, jump",
}));
const __VLS_103 = __VLS_102({
    currentPage: (__VLS_ctx.sumPage),
    pageSize: (__VLS_ctx.sumPageSize),
    size: "small",
    pageSizes: ([5, 10, 20]),
    total: (__VLS_ctx.sortedSummary.length),
    layout: "total, sizes, prev, pager, next, jump",
}, ...__VLS_functionalComponentArgsRest(__VLS_102));
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-h" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h4, __VLS_intrinsicElements.h4)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "trend-tools" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "muted" },
});
const __VLS_105 = {}.ElSelect;
/** @type {[typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, typeof __VLS_components.ElSelect, typeof __VLS_components.elSelect, ]} */ ;
// @ts-ignore
const __VLS_106 = __VLS_asFunctionalComponent(__VLS_105, new __VLS_105({
    ...{ 'onChange': {} },
    modelValue: (__VLS_ctx.trendLimit),
    size: "small",
    ...{ style: {} },
}));
const __VLS_107 = __VLS_106({
    ...{ 'onChange': {} },
    modelValue: (__VLS_ctx.trendLimit),
    size: "small",
    ...{ style: {} },
}, ...__VLS_functionalComponentArgsRest(__VLS_106));
let __VLS_109;
let __VLS_110;
let __VLS_111;
const __VLS_112 = {
    onChange: (__VLS_ctx.loadTrend)
};
__VLS_108.slots.default;
const __VLS_113 = {}.ElOption;
/** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
// @ts-ignore
const __VLS_114 = __VLS_asFunctionalComponent(__VLS_113, new __VLS_113({
    value: (5),
    label: "5 次",
}));
const __VLS_115 = __VLS_114({
    value: (5),
    label: "5 次",
}, ...__VLS_functionalComponentArgsRest(__VLS_114));
const __VLS_117 = {}.ElOption;
/** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
// @ts-ignore
const __VLS_118 = __VLS_asFunctionalComponent(__VLS_117, new __VLS_117({
    value: (10),
    label: "10 次",
}));
const __VLS_119 = __VLS_118({
    value: (10),
    label: "10 次",
}, ...__VLS_functionalComponentArgsRest(__VLS_118));
const __VLS_121 = {}.ElOption;
/** @type {[typeof __VLS_components.ElOption, typeof __VLS_components.elOption, ]} */ ;
// @ts-ignore
const __VLS_122 = __VLS_asFunctionalComponent(__VLS_121, new __VLS_121({
    value: (20),
    label: "20 次",
}));
const __VLS_123 = __VLS_122({
    value: (20),
    label: "20 次",
}, ...__VLS_functionalComponentArgsRest(__VLS_122));
var __VLS_108;
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "muted" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ref: "trendChartEl",
    ...{ class: "trend-chart" },
});
/** @type {typeof __VLS_ctx.trendChartEl} */ ;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "card-h" },
});
__VLS_asFunctionalElement(__VLS_intrinsicElements.h4, __VLS_intrinsicElements.h4)({});
__VLS_asFunctionalElement(__VLS_intrinsicElements.span, __VLS_intrinsicElements.span)({
    ...{ class: "muted" },
});
(__VLS_ctx.details?.total ?? 0);
if (__VLS_ctx.filter.stageIds.length) {
    const __VLS_125 = {}.ElButton;
    /** @type {[typeof __VLS_components.ElButton, typeof __VLS_components.elButton, typeof __VLS_components.ElButton, typeof __VLS_components.elButton, ]} */ ;
    // @ts-ignore
    const __VLS_126 = __VLS_asFunctionalComponent(__VLS_125, new __VLS_125({
        ...{ 'onClick': {} },
        link: true,
        type: "primary",
        size: "small",
    }));
    const __VLS_127 = __VLS_126({
        ...{ 'onClick': {} },
        link: true,
        type: "primary",
        size: "small",
    }, ...__VLS_functionalComponentArgsRest(__VLS_126));
    let __VLS_129;
    let __VLS_130;
    let __VLS_131;
    const __VLS_132 = {
        onClick: (...[$event]) => {
            if (!(__VLS_ctx.filter.stageIds.length))
                return;
            __VLS_ctx.filter.stageIds = [];
            __VLS_ctx.applyFilter();
        }
    };
    __VLS_128.slots.default;
    (__VLS_ctx.filter.stageIds.length);
    var __VLS_128;
}
const __VLS_133 = {}.ElTable;
/** @type {[typeof __VLS_components.ElTable, typeof __VLS_components.elTable, typeof __VLS_components.ElTable, typeof __VLS_components.elTable, ]} */ ;
// @ts-ignore
const __VLS_134 = __VLS_asFunctionalComponent(__VLS_133, new __VLS_133({
    data: (__VLS_ctx.details?.items ?? []),
    size: "small",
    height: "330",
    border: true,
    stripe: true,
    headerCellClassName: (__VLS_ctx.darkCell),
    cellClassName: (__VLS_ctx.darkCell),
}));
const __VLS_135 = __VLS_134({
    data: (__VLS_ctx.details?.items ?? []),
    size: "small",
    height: "330",
    border: true,
    stripe: true,
    headerCellClassName: (__VLS_ctx.darkCell),
    cellClassName: (__VLS_ctx.darkCell),
}, ...__VLS_functionalComponentArgsRest(__VLS_134));
__VLS_asFunctionalDirective(__VLS_directives.vLoading)(null, { ...__VLS_directiveBindingRestFields, value: (__VLS_ctx.detailsLoading) }, null, null);
__VLS_136.slots.default;
const __VLS_137 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_138 = __VLS_asFunctionalComponent(__VLS_137, new __VLS_137({
    label: "执行#",
    prop: "executionId",
    width: "80",
}));
const __VLS_139 = __VLS_138({
    label: "执行#",
    prop: "executionId",
    width: "80",
}, ...__VLS_functionalComponentArgsRest(__VLS_138));
const __VLS_141 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_142 = __VLS_asFunctionalComponent(__VLS_141, new __VLS_141({
    label: "执行状态",
    width: "100",
}));
const __VLS_143 = __VLS_142({
    label: "执行状态",
    width: "100",
}, ...__VLS_functionalComponentArgsRest(__VLS_142));
__VLS_144.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_144.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    const __VLS_145 = {}.ElTag;
    /** @type {[typeof __VLS_components.ElTag, typeof __VLS_components.elTag, typeof __VLS_components.ElTag, typeof __VLS_components.elTag, ]} */ ;
    // @ts-ignore
    const __VLS_146 = __VLS_asFunctionalComponent(__VLS_145, new __VLS_145({
        size: "small",
        type: (row.executionStatus === 'SUCCESS' ? 'success' : 'danger'),
        effect: "dark",
    }));
    const __VLS_147 = __VLS_146({
        size: "small",
        type: (row.executionStatus === 'SUCCESS' ? 'success' : 'danger'),
        effect: "dark",
    }, ...__VLS_functionalComponentArgsRest(__VLS_146));
    __VLS_148.slots.default;
    (row.executionStatus === 'SUCCESS' ? '成功' : '失败');
    var __VLS_148;
}
var __VLS_144;
const __VLS_149 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_150 = __VLS_asFunctionalComponent(__VLS_149, new __VLS_149({
    label: "环节",
    prop: "stageName",
    minWidth: "110",
}));
const __VLS_151 = __VLS_150({
    label: "环节",
    prop: "stageName",
    minWidth: "110",
}, ...__VLS_functionalComponentArgsRest(__VLS_150));
const __VLS_153 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_154 = __VLS_asFunctionalComponent(__VLS_153, new __VLS_153({
    label: "条数",
    prop: "rowCount",
    width: "120",
    align: "right",
}));
const __VLS_155 = __VLS_154({
    label: "条数",
    prop: "rowCount",
    width: "120",
    align: "right",
}, ...__VLS_functionalComponentArgsRest(__VLS_154));
__VLS_156.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_156.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    (__VLS_ctx.fmtInt(row.rowCount));
}
var __VLS_156;
const __VLS_157 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_158 = __VLS_asFunctionalComponent(__VLS_157, new __VLS_157({
    label: "耗时",
    width: "110",
    align: "right",
}));
const __VLS_159 = __VLS_158({
    label: "耗时",
    width: "110",
    align: "right",
}, ...__VLS_functionalComponentArgsRest(__VLS_158));
__VLS_160.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_160.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    (__VLS_ctx.fmtDur(row.durationMs));
}
var __VLS_160;
const __VLS_161 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_162 = __VLS_asFunctionalComponent(__VLS_161, new __VLS_161({
    label: "重试",
    prop: "retries",
    width: "70",
    align: "center",
}));
const __VLS_163 = __VLS_162({
    label: "重试",
    prop: "retries",
    width: "70",
    align: "center",
}, ...__VLS_functionalComponentArgsRest(__VLS_162));
const __VLS_165 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_166 = __VLS_asFunctionalComponent(__VLS_165, new __VLS_165({
    label: "开始时间",
    width: "160",
}));
const __VLS_167 = __VLS_166({
    label: "开始时间",
    width: "160",
}, ...__VLS_functionalComponentArgsRest(__VLS_166));
__VLS_168.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_168.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    (__VLS_ctx.fmtTime(row.startedAt));
}
var __VLS_168;
const __VLS_169 = {}.ElTableColumn;
/** @type {[typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, typeof __VLS_components.ElTableColumn, typeof __VLS_components.elTableColumn, ]} */ ;
// @ts-ignore
const __VLS_170 = __VLS_asFunctionalComponent(__VLS_169, new __VLS_169({
    label: "结束时间",
    width: "160",
}));
const __VLS_171 = __VLS_170({
    label: "结束时间",
    width: "160",
}, ...__VLS_functionalComponentArgsRest(__VLS_170));
__VLS_172.slots.default;
{
    const { default: __VLS_thisSlot } = __VLS_172.slots;
    const [{ row }] = __VLS_getSlotParams(__VLS_thisSlot);
    (__VLS_ctx.fmtTime(row.endedAt));
}
var __VLS_172;
var __VLS_136;
__VLS_asFunctionalElement(__VLS_intrinsicElements.div, __VLS_intrinsicElements.div)({
    ...{ class: "pager" },
});
const __VLS_173 = {}.ElPagination;
/** @type {[typeof __VLS_components.ElPagination, typeof __VLS_components.elPagination, ]} */ ;
// @ts-ignore
const __VLS_174 = __VLS_asFunctionalComponent(__VLS_173, new __VLS_173({
    ...{ 'onCurrentChange': {} },
    ...{ 'onSizeChange': {} },
    currentPage: (__VLS_ctx.detailPage),
    pageSize: (__VLS_ctx.detailPageSize),
    size: "small",
    pageSizes: ([10, 20, 50]),
    total: (__VLS_ctx.details?.total ?? 0),
    layout: "total, sizes, prev, pager, next, jump",
}));
const __VLS_175 = __VLS_174({
    ...{ 'onCurrentChange': {} },
    ...{ 'onSizeChange': {} },
    currentPage: (__VLS_ctx.detailPage),
    pageSize: (__VLS_ctx.detailPageSize),
    size: "small",
    pageSizes: ([10, 20, 50]),
    total: (__VLS_ctx.details?.total ?? 0),
    layout: "total, sizes, prev, pager, next, jump",
}, ...__VLS_functionalComponentArgsRest(__VLS_174));
let __VLS_177;
let __VLS_178;
let __VLS_179;
const __VLS_180 = {
    onCurrentChange: (__VLS_ctx.loadDetails)
};
const __VLS_181 = {
    onSizeChange: (__VLS_ctx.onDetailSizeChange)
};
var __VLS_176;
/** @type {__VLS_StyleScopedClasses['report-view']} */ ;
/** @type {__VLS_StyleScopedClasses['filter-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['f-label']} */ ;
/** @type {__VLS_StyleScopedClasses['f-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-row']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
/** @type {__VLS_StyleScopedClasses['s-num']} */ ;
/** @type {__VLS_StyleScopedClasses['s-label']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
/** @type {__VLS_StyleScopedClasses['s-num']} */ ;
/** @type {__VLS_StyleScopedClasses['s-label']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
/** @type {__VLS_StyleScopedClasses['s-num']} */ ;
/** @type {__VLS_StyleScopedClasses['s-label']} */ ;
/** @type {__VLS_StyleScopedClasses['stat-card']} */ ;
/** @type {__VLS_StyleScopedClasses['s-num']} */ ;
/** @type {__VLS_StyleScopedClasses['s-label']} */ ;
/** @type {__VLS_StyleScopedClasses['card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-h']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['zero-tag']} */ ;
/** @type {__VLS_StyleScopedClasses['ratio-cell']} */ ;
/** @type {__VLS_StyleScopedClasses['ratio-bar']} */ ;
/** @type {__VLS_StyleScopedClasses['ratio-txt']} */ ;
/** @type {__VLS_StyleScopedClasses['pager']} */ ;
/** @type {__VLS_StyleScopedClasses['card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-h']} */ ;
/** @type {__VLS_StyleScopedClasses['trend-tools']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['trend-chart']} */ ;
/** @type {__VLS_StyleScopedClasses['card']} */ ;
/** @type {__VLS_StyleScopedClasses['card-h']} */ ;
/** @type {__VLS_StyleScopedClasses['muted']} */ ;
/** @type {__VLS_StyleScopedClasses['pager']} */ ;
var __VLS_dollars;
const __VLS_self = (await import('vue')).defineComponent({
    setup() {
        return {
            stages: stages,
            loading: loading,
            detailsLoading: detailsLoading,
            filter: filter,
            dateRange: dateRange,
            quickRange: quickRange,
            summary: summary,
            details: details,
            sumPage: sumPage,
            sumPageSize: sumPageSize,
            detailPage: detailPage,
            detailPageSize: detailPageSize,
            trendLimit: trendLimit,
            trendChartEl: trendChartEl,
            darkCell: darkCell,
            rowCls: rowCls,
            sortedSummary: sortedSummary,
            pagedSummary: pagedSummary,
            onSortChange: onSortChange,
            onDateChange: onDateChange,
            onQuickRange: onQuickRange,
            resetFilter: resetFilter,
            applyFilter: applyFilter,
            reloadAll: reloadAll,
            loadDetails: loadDetails,
            onDetailSizeChange: onDetailSizeChange,
            onStageRowClick: onStageRowClick,
            loadTrend: loadTrend,
            fmtInt: fmtInt,
            fmtDur: fmtDur,
            pct: pct,
            ratioColor: ratioColor,
            fmtTime: fmtTime,
        };
    },
});
export default (await import('vue')).defineComponent({
    setup() {
        return {};
    },
});
; /* PartiallyEnd: #4569/main.vue */
