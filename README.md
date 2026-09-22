# 分布式任务工作流DAG编排与执行引擎

基于Vue 3 + FastAPI的任务编排平台，DAG拓扑排序、任务状态机、多Worker并发池、执行甘特图。

## 目标用户
数据工程师、ETL/ML Pipeline开发者、技术架构师

## 技术栈
- 前端: Vue 3 + TypeScript + Vite + Pinia + Element Plus + ECharts
- 后端: Python FastAPI + NumPy + SQLite + WebSocket

## 核心功能
1. DAG工作流编辑器：拖拽添加任务节点、连线建立依赖关系、BFS拓扑排序验证环检测
2. Spring StateMachine风格任务状态机：PENDING→RUNNING→SUCCESS/FAILED/TIMEOUT
3. 多Worker并发池模拟：可配置Worker数量、任务执行耗时模拟(指数分布)
4. 任务编排策略：FIFO/优先级/最大并发三种调度策略
5. 重试机制：可配置最大重试次数、指数退避延迟
6. 执行监控：ECharts甘特图时间线渲染、实时WebSocket推送任务状态
7. 熔断保护：连续失败阈值触发熔断，冷却时间后自动恢复
8. 执行报表（SQLite 持久化）：
   - 按环节汇总每次执行的处理条数、处理耗时与耗时占比，支持时间范围/状态筛选、任意列排序与分页
   - 执行明细逐条核对：汇总、明细、趋势共用同一套筛选 SQL，两处口径完全一致；分页只改展示行，总数恒定
   - 最近若干次执行的耗时趋势对照（ECharts 折线，未到达的环节以断点展示）
   - 无数据环节通过维度表 LEFT JOIN 按 0 参与聚合，不会整段丢失
   - 筛选/分页/排序状态保存在 Pinia，切到别的视图再回来仍然保留
   - 首次启动自动播种演示历史数据；也可用 `POST /api/report/seed` 重新生成

## 启动
```bash
# 后端 (默认 8000)
cd backend && pip install -r requirements.txt && uvicorn app.main:app --port 8000

# 前端 (默认 3000, /api 与 /ws 已代理到 8000)
cd frontend && npm install && npm run dev
```

## 报表 API
- `GET /api/report/summary?startTime=&endTime=&status=&page=&pageSize=&sortBy=&sortOrder=` 环节汇总（含 overall 总计）
- `GET /api/report/details?startTime=&endTime=&status=&taskId=&page=&pageSize=` 逐条明细（含同口径 totals 供核对）
- `GET /api/report/trend?startTime=&endTime=&status=&taskId=...&limit=` 最近 N 次执行趋势（taskId 可重复传）
- `GET /api/report/stages` 环节维度；`POST /api/report/seed` 生成演示数据
