# 知序 RAG 中台 · 现状审计（2026-10-27）

目标对标：FastGPT 式「知识库 + 应用编排（Chat Flow / Agent）+ 业务工作台」。

## 1. 现状概览

| 维度 | 现状 | 评价 |
|---|---|---|
| 规模 | 前端 ~3.9k 行（React 18 + Vite），后端 ~6.9k 行（FastAPI + SQLAlchemy + Celery） | 模块化单体，结构清晰 |
| 测试 | 后端 `pytest` 81 passed / 1 skipped；前端 `vitest` 3 passed；`tsc` 通过 | 后端覆盖较好，前端几乎无测试 |
| 知识流水线 | PDF/DOCX/MD/图片/XLSX/CSV 解析、OCR、元数据抽取、分阶段进度、瞬时错误重试 | **扎实，可直接复用** |
| 切块 | 结构递归 / 父子 / LLM 语义 三种，按知识库全局配置 | 方式偏少，缺预览 |
| 检索 | 纯向量（pgvector HNSW）+ 可选 Rerank + 阈值；父子去重；多库 RRF 融合 | 缺全文/混合检索 |
| 应用 | `fde.app/v1` Manifest：单次「提示词 + 可选检索 + LLM」 | **无工作流图、无 Agent 工具循环** |
| 交付治理 | 草稿 / 预览 / 评测集 / 不可变版本 / 发布 / 回滚 / 反馈 | 亮点，FastGPT 没有的部分 |
| 权限 | 工作区、成员角色、PBKDF2、会话 Token、Agent API Token、审计事件 | 基础完整 |

## 2. 与目标的关键差距

### P0：阻塞 Chat Flow / Agent

1. **运行时是单步的**。`backend/app/fde/runtime.py` 的 `execute_manifest` 只做「校验输入 → 检索 → 拼提示词 → 调一次 LLM」。没有节点、连线、分支、循环、变量传递，所以 Chat Flow 无法表达。
2. **没有工具调用**。Manifest 的 `tools` 实际只识别 `knowledge_retrieval`；能力目录明确返回 `external_http_tools=false`。Agent 需要 function calling 循环和工具注册表（知识库、HTTP、代码、子工作流、MCP）。
3. **FDE 运行非流式**。报告撰写这类长输出体验差；目前只有旧版问答走 SSE。

### P1：知识库能力不足

4. **切块方式少，且粒度太粗**。只有 3 种，并且挂在知识库上，改一次就要全库重建。FastGPT 是按「导入集合」配置的。还缺：自定义分隔符、按 Markdown 标题层级、按页、表格按行、QA 问答对拆分、固定 Token 长度。
5. **导入前不能预览切块**。用户看不到切块效果就要等索引构建，调参成本高。
6. **数据源只有本地文件**。没有网页链接、自定义文本、CSV 问答对、API / 飞书文档同步。
7. **只有向量检索**。条款编号、产品型号、合同号这类精确匹配是制度审校和客服的刚需，纯向量召回不稳。需要全文检索（tsvector + 中文分词）和混合检索（RRF），另外缺问题改写。
8. **每个分块只有一个索引**。FastGPT 支持一块多索引（自定义问题、摘要）。现在是把元数据里的 `likely_questions` 拼进 embedding 文本，算部分替代。

### P2：信息架构与前端可维护性

9. **两套应用体系并存**。旧版 `QAApp` + `/apps` + `/chat`（SSE）和 FDE Manifest + `/studio` + `/portal` 共用 `qa_apps` 表，`top_k`、`scenario_type` 等字段重复。导航有 9 项，「应用中心 / AI 设计室 / 业务应用 / 在线对话」四个入口职责重叠。
10. **角色模型混乱**。已有真实登录，但界面仍保留 localStorage 的「体验视角 · 非鉴权」角色切换和演示横条。
11. **页面代码难维护**。多个页面把整张表格写在一行 JSX 里（如 `KnowledgeDetailPage.tsx:238`），977 行全局 CSS，没有组件库和画布库，不适合承载工作流编辑器。
12. **模板与业务脱节**。内置样例是「特色菜文案」，跟公司要落地的报告、客服、审校场景不匹配。

## 3. 建议路线

**前端**：按 `prototype/` 原型重建信息架构，收敛为 **工作台 / 应用 / 知识库 / 工具与模型 / 日志与评测** 五个入口。应用分三类：简易应用、Chat Flow、Agent。画布用 `@xyflow/react`。

**后端（支撑原型所需，按优先级）**：

1. Manifest 升级为 `fde.app/v2`：新增 `type: simple | chatflow | agent`。chatflow 用 `graph: {nodes, edges}` 描述，agent 用 `agent: {tools, max_steps}` 描述。v1 自动迁移成 `simple`。
2. 图执行器：拓扑执行 + 条件分支 + 变量池 + 每节点 Trace（复用现有 `TraceStep`），SSE 流式输出。
3. Agent 循环：基于 OpenAI-compatible tool calling，工具注册表先接知识库检索、HTTP、子工作流，人工转接作为特殊工具。
4. 切块配置下沉到「导入集合」，新增 `POST /knowledge-bases/{id}/chunk-preview`，只解析和切块、不入索引。补齐分隔符、标题层级、按页、表格行、QA 拆分。
5. 混合检索：`document_chunks` 增加 `tsvector` 列（zhparser 或 jieba 预分词）与 GIN 索引，用 RRF 融合；检索测试页暴露模式切换。
6. 旧版 `QAApp` / `/chat` 迁到 v2 的 `simple` 类型后下线，保留 SSE 能力。

现有的交付治理（评测门禁、不可变版本、回滚）建议完整保留，并扩展到 Chat Flow / Agent，这是相对 FastGPT 的差异化优势。
