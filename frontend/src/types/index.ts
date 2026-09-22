export interface TaskNode { id: string; name: string; deps: string[]; x: number; y: number; status: string; startTime?: number; endTime?: number; retries: number }
export interface DAGWorkflow { id: number; name: string; nodes: TaskNode[]; edges: [string,string][] }
export interface ExecutionLog { taskId: string; status: string; timestamp: number; message: string }
export interface CircuitBreaker { taskId: string; failureCount: number; state: string; cooldownUntil: number }
export interface ExecutionInfo { workflow: DAGWorkflow; logs: ExecutionLog[]; circuitBreakers: CircuitBreaker[]; completed: boolean; status?: string }

// ---- Execution report ----
export interface Stage {
  id: string
  name: string
  stageOrder: number
  baseDurationMs: number
  baseRows: number
}

export interface ReportOverall {
  executionCount: number
  stageRowCount: number
  totalRows: number
  totalDurationMs: number
}

export interface StageSummaryRow {
  taskId: string
  taskName: string
  stageOrder: number
  execCount: number
  totalRows: number
  totalDurationMs: number
  avgRows: number
  avgDurationMs: number
  pctDuration: number
}

export interface SummaryResponse {
  page: number
  pageSize: number
  total: number
  overall: ReportOverall
  items: StageSummaryRow[]
}

export interface DetailRow {
  id: number
  executionId: number
  workflowName: string
  executionStatus: string
  executionStartTime: number
  executionEndTime: number | null
  taskId: string
  taskName: string
  stageOrder: number
  status: string
  rowCount: number
  durationMs: number
  retries: number
  startTime: number
  endTime: number
}

export interface DetailsResponse {
  page: number
  pageSize: number
  total: number
  totals: { stageRowCount: number; totalRows: number; totalDurationMs: number }
  items: DetailRow[]
}

export interface TrendStagePoint { status: string; rowCount: number; durationMs: number }

export interface TrendResponse {
  limit: number
  stages: string[]
  executions: { id: number; workflowName: string; status: string; startTime: number; endTime: number | null }[]
  series: Record<string, (TrendStagePoint | null)[]>
}

export interface ReportQuery {
  startTime: number | null
  endTime: number | null
  status: string
  page: number
  pageSize: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
  taskId?: string | null
}
