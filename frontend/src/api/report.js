import axios from 'axios';
// 汇总 / 明细 / 趋势三处共用同一组查询参数，保证口径一致：
// 时间按执行开始时间过滤，环节按 stageIds 过滤（空 = 全部）。
function commonParams(f) {
    return { start: f.start, end: f.end, stageIds: f.stageIds.length ? f.stageIds.join(',') : undefined };
}
export async function fetchStages() {
    const { data } = await axios.get('/api/reports/stages');
    return data.items;
}
export async function fetchSummary(f) {
    const { data } = await axios.get('/api/reports/summary', { params: commonParams(f) });
    return data;
}
export async function fetchDetails(f, page, pageSize) {
    const { data } = await axios.get('/api/reports/details', {
        params: { ...commonParams(f), page, pageSize },
    });
    return data;
}
export async function fetchTrend(f, limit) {
    const { data } = await axios.get('/api/reports/trend', { params: { start: f.start, end: f.end, limit } });
    return data;
}
