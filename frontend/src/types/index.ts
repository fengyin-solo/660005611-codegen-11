export interface TaskNode { id: string; name: string; deps: string[]; x: number; y: number; status: string; startTime?: number; endTime?: number; retries: number }
export interface DAGWorkflow { id: number; name: string; nodes: TaskNode[]; edges: [string,string][] }
export interface ExecutionLog { taskId: string; status: string; timestamp: number; message: string }
export interface CircuitBreaker { taskId: string; failureCount: number; state: string; cooldownUntil: number }
export interface ExecutionInfo { workflow: DAGWorkflow; logs: ExecutionLog[]; circuitBreakers: CircuitBreaker[]; completed: boolean }

// ---- 执行报表 ----
export interface ReportFilter {
  start: number // 毫秒时间戳，按“执行开始时间”过滤
  end: number
  stageIds: string[] // 空数组表示全部环节
}
export interface StageDef { stageId: string; stageName: string; seq: number }
export interface SummaryItem {
  stageId: string
  stageName: string
  seq: number
  executionCount: number
  totalRows: number
  totalDurationMs: number
  avgDurationMs: number
  durationRatio: number // 占所有环节总耗时的比例
}
export interface SummaryResult {
  items: SummaryItem[]
  totalStages: number
  totalDurationMs: number
  totalRows: number
  executionCount: number
}
export interface DetailItem {
  id: number
  executionId: number
  executionStatus: string
  stageId: string
  stageName: string
  rowCount: number
  durationMs: number
  retries: number
  status: string
  startedAt: number
  endedAt: number
}
export interface DetailsResult { total: number; page: number; pageSize: number; items: DetailItem[] }
export interface TrendExecution { id: number; startedAt: number; status: string }
export interface TrendSeries { stageId: string; stageName: string; values: number[] }
export interface TrendResult { executions: TrendExecution[]; series: TrendSeries[] }
