# README 截图

`docs/images` 下的截图由这里的脚本生成：独立的演示后端和数据库，不影响本地开发数据；模型都是测试替身。

```bash
# 1. 演示后端（8002，数据写在 backend/data/screenshots）
rm -rf backend/data/screenshots && mkdir -p backend/data/screenshots
APP_DATABASE_URL="sqlite+aiosqlite:///./backend/data/screenshots/demo.db" \
APP_LOCAL_STORAGE_PATH="./backend/data/screenshots/uploads" \
uv run --project backend uvicorn app.main:app --app-dir backend --port 8002

# 2. 演示前端（4174，接口指向 8002）
pnpm exec vite --config scripts/screenshots/vite.config.ts

# 3. 写入演示数据，输出各对象 ID
uv run --project backend python scripts/screenshots/seed.py > /tmp/knoworder-seed.json

# 4. 用本机 Chrome 无头截图（1440×900）
uv run --no-project --with playwright --with httpx python scripts/screenshots/capture.py /tmp/knoworder-seed.json
```

- `seed.py`：模型、知识库与文档、5 个应用（含两个 Chat Flow）、3 个业务账号的线上使用与反馈、发布门禁评测集；运行时间分散到最近 7 天。
- `flows/`：「报告撰写」「合同审校」两个 Chat Flow 的节点图。
- 「接入模型服务商」截图需要真实 API Key 才能读取模型目录，脚本用一份示例目录代替服务商响应。
