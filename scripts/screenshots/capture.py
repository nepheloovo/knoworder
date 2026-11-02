"""用本机 Chrome 无头截取 README 截图（1440×900），输出到 docs/images。

依赖演示环境（scripts/screenshots/README.md）：前端 4174 → 演示后端 8002，并已运行 seed.py。
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import httpx
from playwright.sync_api import Page, sync_playwright

WEB = "http://127.0.0.1:4174"
API = "http://127.0.0.1:8002/api/v1"
OUT = Path(__file__).resolve().parents[2] / "docs" / "images"

# 读取模型目录需要真实 API Key；截图时用一份示例目录代替服务商响应
CATALOG = {
    "ok": True, "detail": "OpenRouter 连接成功，已加载 6 个可选模型", "latency_ms": 412,
    "models": [
        {"id": "deepseek/deepseek-chat-v3", "name": "DeepSeek V3", "description": "", "model_type": "llm", "context_length": 64000, "modality": "text->text", "prompt_price": "0.00000027", "is_free": False},
        {"id": "qwen/qwen3-235b-a22b", "name": "Qwen3 235B", "description": "", "model_type": "llm", "context_length": 128000, "modality": "text->text", "prompt_price": "0.00000013", "is_free": False},
        {"id": "meta-llama/llama-3.3-70b-instruct:free", "name": "Llama 3.3 70B (free)", "description": "", "model_type": "llm", "context_length": 128000, "modality": "text->text", "prompt_price": "0", "is_free": True},
        {"id": "baai/bge-m3", "name": "BAAI: bge-m3", "description": "", "model_type": "embedding", "context_length": 8192, "modality": "text->embedding", "prompt_price": "0.00000001", "is_free": False},
        {"id": "openai/text-embedding-3-small", "name": "Text Embedding 3 Small", "description": "", "model_type": "embedding", "context_length": 8192, "modality": "text->embedding", "prompt_price": "0.00000002", "is_free": False},
        {"id": "cohere/rerank-v3.5", "name": "Cohere Rerank 3.5", "description": "", "model_type": "rerank", "context_length": None, "modality": "text->rerank", "prompt_price": None, "is_free": False},
    ],
}


def settle(page: Page, ms: int = 700) -> None:
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(ms)


def shot(page: Page, name: str) -> None:
    page.mouse.move(1, 899)  # 避免悬停样式
    page.screenshot(path=str(OUT / f"{name}.png"))
    print("saved", name)


def main() -> None:
    seed = json.loads(Path(sys.argv[1]).read_text())
    apps, kbs = seed["apps"], seed["knowledge_bases"]
    token = httpx.post(f"{API}/auth/login", json={"email": "admin@fde.local", "password": "fde-dev-admin"}).json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    policy_file = next(item for item in httpx.get(f"{API}/knowledge-bases/{kbs['售后服务政策']}/files", headers=headers).json() if item["filename"].endswith(".md"))

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1, locale="zh-CN")
        context.add_init_script(f"localStorage.setItem('fde-access-token', {json.dumps(token)})")
        page = context.new_page()

        def go(path: str, ms: int = 700) -> None:
            page.goto(WEB + path)
            settle(page, ms)

        go("/workbench")
        shot(page, "workbench")

        go(f"/chat/{apps['售后客服助手']}?conversation={seed['conversation']}")
        shot(page, "chat")

        go(f"/apps/{apps['售后客服助手']}")
        page.get_by_label("输入消息").fill("买了不想要能退吗？")
        page.keyboard.press("Enter")
        page.get_by_text("查看 Trace").first.wait_for()
        settle(page, 400)
        shot(page, "app-editor")

        go("/apps")
        shot(page, "apps")

        go(f"/apps/{apps['行业研究报告']}", 1200)
        page.get_by_label("收起节点库").click()
        page.get_by_role("button", name="Fit View").click()
        settle(page, 600)
        shot(page, "chatflow")

        with tempfile.TemporaryDirectory() as folder:
            manual = Path(folder) / "门店运营手册.md"
            manual.write_text("# 门店运营手册\n\n## 开店流程\n每日 9:00 前完成陈列检查与设备巡检。\n\n## 闭店流程\n盘点现金并上传当日日报。\n\n## 客诉处理\n先致歉并记录诉求，30 分钟内回电。\n", encoding="utf-8")
            faq = Path(folder) / "门店FAQ.csv"
            faq.write_text("问题,答案\n营业时间是几点？,每天 9:00–21:00。\n可以开发票吗？,可以，前台扫码申请电子发票。\n", encoding="utf-8")
            go(f"/knowledge/{kbs['售后服务政策']}/import")
            page.locator('input[type="file"]').set_input_files([str(manual), str(faq)])
            page.wait_for_timeout(800)
            page.get_by_role("button", name="下一步").click()
            settle(page, 1200)
            page.get_by_role("button", name="调整参数").click()
            page.wait_for_timeout(400)
            shot(page, "knowledge-import")

        go(f"/knowledge/{kbs['售后服务政策']}/files/{policy_file['id']}")
        shot(page, "knowledge-chunks")

        go(f"/knowledge/{kbs['售后服务政策']}/search")
        page.get_by_label("测试问题").fill("储能柜保修多久？")
        page.get_by_role("button", name="全文").click()
        page.get_by_role("button", name="测试", exact=True).click()
        settle(page, 800)
        shot(page, "knowledge-search")

        go("/evaluation-sets")
        page.get_by_role("button", name="AI 设计").first.click()
        page.locator("select").filter(has=page.locator("option", has_text="售后客服助手")).first.select_option(label="售后客服助手")
        settle(page, 800)
        page.get_by_placeholder("例如：重点测试退换货时效").fill("重点测试退换货时效、保修范围、故障代码解释；投诉和赔偿必须转人工")
        shot(page, "eval-ai-design")

        go(f"/evaluation-sets?set={seed['evaluation_set']}")
        shot(page, "eval-set")

        go("/observability", 1000)
        shot(page, "observability")

        go(f"/observability?view=runs&trace={seed['trace']}", 1000)
        shot(page, "observability-trace")

        go("/insights", 1000)
        shot(page, "insights")

        page.route("**/api/v1/models/providers/openrouter/catalog", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(CATALOG)))
        go("/tools?tab=models")
        page.get_by_role("button", name="接入模型服务商").first.click()
        page.wait_for_timeout(500)
        page.get_by_placeholder("OpenRouter API Key").fill("sk-or-v1-demo-key-000000")
        page.get_by_role("button", name="读取模型列表").click()
        page.get_by_text("连接成功").wait_for()
        for label in ("DeepSeek V3", "BAAI: bge-m3"):
            page.locator("label, .method-card, .row").filter(has_text=label).locator('input[type="checkbox"]').first.check()
        page.wait_for_timeout(400)
        shot(page, "integration-provider")
        browser.close()


if __name__ == "__main__":
    main()
