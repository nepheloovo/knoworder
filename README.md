# 知序 KnowOrder · AI 应用中台

把企业知识变成**可上线、可评测、可追溯**的 AI 应用。

知序面向需要交付 AI 应用的团队（FDE / 解决方案 / 业务数字化），覆盖完整链路：接入模型，整理知识库，搭建问答、客服、报告、文案等应用，用评测集把关质量，发布给业务人员使用，再从线上运行记录里发现问题、回流成新的评测 Case。

![工作台](docs/images/workbench.png)

---

## 它解决什么问题

| 常见痛点 | 知序的做法 |
|---|---|
| 文档格式五花八门，切块效果全靠猜 | 上传后**按文件格式自动匹配切块方式**，每个文件都能看真实切块预览、单独调整；可选**自动抽取关键词、生成问答对**，提升口语化提问的命中率 |
| 换个模型就要改代码，不知道选哪个 | 选一家模型服务商、填一次 Key，**自动读取模型目录**，勾选即可接入；填单价后自动估算费用 |
| 改了提示词不知道有没有改坏 | **评测集 + 发布门禁**：门禁评测未全部通过（或结果早于当前草稿）就不能发布 |
| 写评测用例太费时间 | **AI 设计评测集**：按内置规则和你补充的业务方向自动生成带判定标准的 Case，生成后直接运行 |
| 线上答错了，不知道错在哪一步 | 每次运行都有完整 **Trace**：检索召回了什么、模型输入输出、工具调用、耗时、Token 和费用 |
| 发现问题后难以沉淀 | 从 Trace 一键**回流为 Good / Bad Case**，补上标准就进入回归评测 |
| 草稿改动影响线上 | 草稿与线上隔离：**不可变版本**、一键发布 / 下线 / 回滚，业务端只运行已发布版本 |

---

## 与 FastGPT、Dify 的区别

FastGPT 和 Dify 是成熟的通用 LLM 应用搭建平台，强项在**「把应用搭出来」**：可视化工作流、丰富的插件 / 工具生态、多渠道发布和庞大的社区。

知序的重心不同，在于**「把应用稳定地交付上线并持续变好」**。我们把质量闭环做成默认流程，而不是可选插件：

| | FastGPT / Dify | 知序 |
|---|---|---|
| **核心定位** | 通用应用搭建：编排能力强、覆盖场景广 | 面向交付团队：从知识整理、评测把关到上线运营的闭环 |
| **质量把关** | 发布主要依赖人工调试和日志检查 | **评测集即发布门禁**：门禁评测未全部通过不能发布；评测结果与配置指纹绑定，改了提示词或模型就必须重跑 |
| **评测用例从哪来** | 主要手工准备或借助外部评测工具 | **AI 按规则设计**（7 条内置规则 + 业务方向，带可自动判定的标准）＋ 从线上 Trace **一键回流 Good / Bad Case** |
| **问题定位** | 提供运行日志与调用详情 | 每次运行一条完整 Trace，可直接把这次运行转为评测 Case，形成「发现问题 → 沉淀用例 → 修复 → 回归」的闭环 |
| **知识导入** | 提供多种分段模式，按知识库或批次选择 | **按文件自动匹配切块方式**，逐个文件看真实预览、单独调整；扫描件、问答对表格等自动识别 |
| **版本与上线** | 支持发布与版本管理 | 草稿与线上严格隔离；回滚不受门禁阻塞，保证出事时能立即切回 |
| **使用者分工** | 以搭建者视角为主 | 搭建者（应用 / 知识库 / 评测 / 可观测）与业务使用者（只看到已发布应用的工作台）分开 |

**什么时候选它们**：需要复杂的可视化多步骤工作流、现成的大量插件和渠道（企业微信、飞书、网页嵌入等），或希望依托成熟社区时，FastGPT / Dify 更合适。知序的 Chat Flow 和多渠道发布仍在建设中。

**什么时候选知序**：你要为客户或业务部门**交付**问答、客服、报告类应用，需要回答「这个版本能不能上线」「上线后哪里答错了、改完有没有变差」这类问题时。

---

## 界面一览

### 1. 业务端：工作台与对话

业务人员登录后只看到已发布的应用，按场景筛选、收藏、开始使用。回答附带引用来源，可点赞 / 点踩；投诉、赔偿等场景自动转人工。

![对话](docs/images/chat.png)

### 2. 应用编排与调试

左侧配置模型、提示词、知识库、表单、工具和安全策略，右侧用草稿实时调试（不影响线上）。修改 1 秒后自动保存；提示词中可点「插入变量」或输入 `{{` 引用表单字段。

![应用编排](docs/images/app-editor.png)

![应用列表](docs/images/apps.png)

### 3. 知识库：导入、切块与增强

上传文件后按格式自动匹配切块方式（PDF 按页、Markdown / Word 按标题、表格按行，表头为「问题 / 答案」的 CSV 识别为问答对）。左侧是文件列表，右侧是当前文件的切块方式、参数和真实预览。

![导入与切块](docs/images/knowledge-import.png)

开启「分块增强」后，导入时为每个分块抽取关键词、生成它能回答的问答对，结果可查看和修改，并参与检索：

![分块增强](docs/images/knowledge-chunks.png)

检索测试支持语义 / 全文 / 混合三种模式，调好的参数可一键写入引用本库的应用：

![检索测试](docs/images/knowledge-search.png)

### 4. 评测：AI 设计评测集与发布门禁

勾选评测规则（按应用场景预选推荐项），补充业务方向，AI 生成带判定标准的 Case，并可立即运行：

![AI 设计评测集](docs/images/eval-ai-design.png)

运行时逐条显示进度；把评测集设为「发布门禁」后，未全部通过就不能发布：

![评测集](docs/images/eval-set.png)

### 5. 可观测

总览运行成功率、延迟、失败、转人工、费用和知识构建状态，并可下钻到单次 Trace：

![可观测总览](docs/images/observability.png)

![Trace](docs/images/observability-trace.png)

### 6. 集成：接入模型服务商

选择服务商、填一次 API Key，读取模型目录后按类型筛选、勾选接入：

![接入模型服务商](docs/images/integration-provider.png)

> 以上截图使用本地演示数据和测试替身模型（界面中标注「测试替身」）生成，回答内容不代表真实模型效果。

---

## 快速开始

### 方式一：本地开发（SQLite，最快）

```bash
# 前端依赖
pnpm install

# 后端依赖
(cd backend && uv sync)

# 在仓库根目录启动后端（默认使用 SQLite 和本地文件存储，数据在 backend/data/）
uv run --project backend uvicorn app.main:app --app-dir backend --port 8001
```

另开一个终端启动前端：

```bash
pnpm dev
```

打开 <http://127.0.0.1:4173>，开发环境初始账号：

- 邮箱：`admin@fde.local`
- 密码：`fde-dev-admin`（由 `APP_BOOTSTRAP_ADMIN_PASSWORD` 控制，生产环境必须修改）

### 方式二：Docker（PostgreSQL + pgvector + Redis + S3）

```bash
cp .env.example .env
docker-compose up -d --build
pnpm install && pnpm dev
```

| 服务 | 地址 |
|---|---|
| 前端 | `http://127.0.0.1:4173` |
| API / OpenAPI | `http://127.0.0.1:8001` / `http://127.0.0.1:8001/docs` |
| PostgreSQL | `127.0.0.1:56432` |
| Redis | `127.0.0.1:57379` |
| S3 API | `http://127.0.0.1:59000` |

### 升级已有环境

拉取新版本后先执行数据库迁移：

```bash
cd backend
APP_DATABASE_URL='postgresql+asyncpg://USER:PASSWORD@HOST:5432/rag_hub' uv run alembic upgrade head
```

---

## 操作指南：从零上线一个应用

以「售后客服助手」为例，完整走一遍约 15 分钟。

### 第 1 步：接入模型（集成 → 模型）

1. 点击 **接入模型服务商**，选择 OpenRouter / AIHubMix / DeepSeek。
2. 填写 API Key，点击 **读取模型列表**。
3. 至少勾选一个**对话模型（LLM）**和一个**索引模型（Embedding）**，点击 **接入选中的模型**。
4. 在列表中点 **测试** 确认连通；可编辑模型填写输入 / 输出单价，用于费用估算。

> 通义或私有网关可用 **手动添加**。已接入的服务商可点 **添加更多模型**，无需重新填 Key。

### 第 2 步：建知识库（知识库 → 新建知识库）

1. 填写名称和简介（Agent 会依据简介判断何时检索本库），选择索引模型；需要语义分块、问答对生成时再选一个**文本理解模型**；扫描版 PDF 需要选择 **图片理解 / OCR** 模型。
2. 创建后进入导入：选择 **本地文件 / 网页链接 / 自定义文本**。
3. **切块与预览**：系统已按格式匹配切块方式；点左侧文件查看预览，不满意就在右侧切换方式或展开 **调整参数**。需要时打开 **抽取关键词 / 生成问答对**。
4. **确认导入**，等待解析、切块、增强、向量化完成。
5. 在 **检索测试** 里用真实问题验证召回效果，满意后可 **把这组参数用到应用**。

### 第 3 步：搭建应用（应用 → 新建应用）

1. 三种方式任选：**从业务模板**（知识问答、智能客服、结构化报告、知识审校、营销内容）、**空白应用**、**AI 帮我搭建**（描述需求自动生成第一版）。
2. 选择应用类型：**简易应用**（提示词 + 知识库 + 表单）或 **Agent**（自主调用知识库、业务工具、转人工）。类型创建后不可更改。
3. 在编排页关联知识库、调整提示词和检索参数，用右侧 **调试预览** 提问；每条回答可 **查看 Trace**。

### 第 4 步：评测（应用 → 评测，或 评测集）

1. 点击 **AI 设计评测集**：确认推荐规则，补充业务方向（例如「重点覆盖退款时效、保修范围和投诉处理」），选择数量，**生成并运行**。
2. 也可以 **手工新增 Case**，或在可观测里把真实对话回流为 Good / Bad Case。
3. 打开 **发布门禁** 开关：之后每次发布前，该评测集必须基于当前草稿全部通过。

### 第 5 步：发布与运营

1. 点击右上角 **发布**，查看配置校验和门禁结果，填写版本说明后发布。
2. 应用出现在业务人员的 **工作台**；在 **发布渠道** 可创建免登录分享链接，或用 API Token 接入业务系统（Token 在 **设置 → API Token** 创建）。
3. 在 **可观测** 关注失败、转人工、差评和费用；发现问题回流为 Case，修改草稿、重新评测、再发布。
4. 出问题时在 **版本** 页一键回滚（回滚不受门禁限制）。

---

## 能力清单

**模型与集成**
- 模型服务商目录接入（OpenRouter、AIHubMix、DeepSeek），支持手动添加通义及 OpenAI 兼容接口。
- LLM / Embedding / Rerank / OCR 四类模型，连通性测试，单价与费用估算。
- HTTP 业务工具：参数 Schema、鉴权（Bearer / API Key）、内网访问控制、副作用工具执行前需用户确认。

**知识库**
- PDF、DOCX、Markdown、图片、XLSX / XLSM、CSV、网页、自定义文本。
- 9 种切块方式：智能、按标题、自定义分隔符、固定长度、父子块、语义（LLM）、按页、表格按行、问答对。
- 分块增强：关键词抽取（无模型时规则抽取）、问答对生成（LLM）；模型输出异常时降级而不中断导入。
- 文档元数据抽取与人工修订、分块编辑后即时重新向量化、单文件重新切块、全库重建。
- 语义 / 全文 / 混合检索，可选重排。

**应用**
- 简易应用与 Agent 两种类型；Chat Flow 即将上线。
- 动态表单（文本、长文本、数字、下拉、开关），提示词变量插入。
- 引用、无依据拒答、禁止话题、转人工、多轮记忆、开场白与推荐问题。
- 草稿自动保存、不可变版本、发布 / 下线 / 回滚；工作台、免登录分享链接、API 三种渠道。

**评测**
- 手工 Case、线上回流 Good / Bad Case、AI 设计评测集（7 条内置规则 + 自定义业务方向）。
- 判定标准：必须包含、禁止出现、要求引用、与期望输出一致。
- 逐条运行显示进度，中断后可继续；发布门禁按评测集分别校验，且必须基于当前配置运行。

**可观测**
- 运行 Trace（上下文、检索、模型、工具、护栏）、对话日志、知识构建任务、用量与费用（按应用 / 模型 / 渠道归因）。

**账号与安全**
- 工作区成员与三种角色（管理员、应用管理员、业务使用者），API Token 按权限范围授权，审计事件。

---

## 技术架构

| 层 | 技术 |
|---|---|
| 前端 | React 18、TypeScript、Vite、React Router、Vitest |
| API | FastAPI、Pydantic、SQLAlchemy Async、Alembic |
| RAG | LangChain、PostgreSQL 16 + pgvector（本地开发可用 SQLite）、可选 Rerank |
| 异步任务 | Celery、Redis |
| 文件存储 | S3 协议（Docker 使用 RustFS），本地开发使用文件系统 |
| 模型 | OpenAI 兼容网关，支持 OpenRouter、AIHubMix、DeepSeek、通义及测试替身 |

采用「模块化单体 API + 独立 Worker」，当前规模不拆微服务。

---

## API 接入

在 **设置 → API Token** 创建 Token（按需勾选 `apps:run`、`knowledge:write` 等权限），业务系统调用已发布应用：

```bash
curl -X POST http://127.0.0.1:8001/api/v1/fde/apps/$APP_ID/run \
  -H "Authorization: Bearer $FDE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "买了不想要能退吗？", "input_values": {}, "conversation_id": null}'
```

推送文件到知识库：

```bash
curl -X POST http://127.0.0.1:8001/api/v1/knowledge-bases/$KB_ID/files \
  -H "Authorization: Bearer $FDE_TOKEN" \
  -F "upload=@document.pdf" \
  -F 'config={"method":"heading","heading_level":2,"chunk_size":800,"chunk_overlap":80,"enhance_keywords":true}'
```

常用端点（完整列表见 `/docs`）：

| 操作 | API |
|---|---|
| 能力发现 / 模板 | `GET /api/v1/fde/capabilities`、`GET /api/v1/fde/templates` |
| 创建草稿 / 更新草稿 | `POST /api/v1/fde/apps`、`PUT /api/v1/fde/apps/{id}/manifest` |
| 草稿调试 | `POST /api/v1/fde/apps/{id}/preview` |
| 发布（固化版本并发布） | `POST /api/v1/fde/apps/{id}/release` |
| 回滚 / 下线 | `POST /api/v1/fde/apps/{id}/rollback`、`/unpublish` |
| 业务运行 | `POST /api/v1/fde/apps/{id}/run` |
| AI 设计评测集 | `POST /api/v1/evaluation-sets/ai-design` |
| 运行评测（一次性 / 分步） | `POST /api/v1/evaluation-sets/{id}/run`、`/runs` + `/runs/{run_id}/step` |
| 运行 Trace | `GET /api/v1/observability/runs/{trace_id}` |

不要在前端代码或仓库中硬编码 Token。

---

## 开发与测试

```bash
# 后端
cd backend
uv run pytest -q
APP_RUN_INTEGRATION=1 uv run pytest tests/test_integration_services.py -q

# 前端
pnpm test
pnpm typecheck
pnpm build
```

---

## 当前边界

- 应用运行为非流式响应。
- Chat Flow（可视化多步骤编排）、网页嵌入、企业微信、飞书渠道尚未开放，界面中标注「即将上线」。
- 智能客服提供知识回答和转人工事件，不包含完整工单、SLA 和坐席系统。
- 测试替身只用于自动化测试和本地演示，响应始终标记为模拟数据，生产环境禁止创建。

## 生产检查清单

- 设置强随机 `APP_ENCRYPTION_KEY`、`APP_BOOTSTRAP_ADMIN_PASSWORD` 和存储凭据。
- 设置 `APP_ENV=production`、`APP_AUTO_CREATE_DB=false`，先运行 Alembic 迁移。
- 使用真实登录或 API Token，Demo Header 在生产环境无效。
- 配置 HTTPS、反向代理、CORS、限流、备份恢复、日志脱敏与数据保留策略。
- 使用 PostgreSQL + Celery + S3 和真实模型完成发布前验收，不以 SQLite / 测试替身结果证明模型质量。

更多资料：[`docs/AUDIT.md`](docs/AUDIT.md)（现状审计）、[`docs/EVALUATION_CASE_RETURN.md`](docs/EVALUATION_CASE_RETURN.md)（线上 Case 回流设计）、[`prototype/`](prototype/README.md)（交互原型）。

## 致谢

本项目在 [chusimin/zhishu-rag-platform](https://github.com/chusimin/zhishu-rag-platform) 的基础上经授权二次开发。
