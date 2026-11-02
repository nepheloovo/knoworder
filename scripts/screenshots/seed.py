"""给 README 截图准备演示数据：只通过 API 写入独立的演示后端（默认 8002），不碰本地开发库。

用法见 scripts/screenshots/README.md。全部模型都是测试替身，回答内容是预设文本。
"""

from __future__ import annotations

import json
import random
import sqlite3
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8002"
API = f"{BASE}/api/v1"
ROOT = Path(__file__).resolve().parent
DEMO_DB = ROOT.parents[1] / "backend" / "data" / "screenshots" / "demo.db"

ANSWER = (
    "根据《售后服务政策》，签收后 **7 天内**商品完好可申请无理由退货，退款在审核通过后 1–3 个工作日原路退回 [资料 1]。\n\n"
    "- 储能柜整机保修 **5 年**，电芯保修 10 年，人为损坏不在保修范围内\n"
    "- 金卡及以上会员可预约免费上门取件\n\n"
    "如需进一步处理，我可以帮你转接人工客服。"
)

ENHANCE = json.dumps([
    {"index": 0, "keywords": ["无理由退货", "7 天", "退款时效"], "qa": [{"q": "买了不想要能退吗？", "a": "签收 7 天内商品完好可无理由退货。"}, {"q": "退款多久到账？", "a": "审核通过后 1–3 个工作日原路退回。"}]},
    {"index": 1, "keywords": ["保修", "整机 5 年", "电芯 10 年"], "qa": [{"q": "储能柜保修多久？", "a": "整机保修 5 年，电芯保修 10 年。"}]},
    {"index": 2, "keywords": ["故障代码", "E07", "BMS"], "qa": [{"q": "E07 是什么故障？", "a": "E07 表示 BMS 通讯中断，请检查通讯线后重启。"}]},
    {"index": 3, "keywords": ["上门取件", "金卡会员"], "qa": [{"q": "可以上门取件吗？", "a": "金卡及以上会员可预约免费上门取件。"}]},
], ensure_ascii=False)

DOCS = {
    "售后服务政策": [
        ("售后服务政策.md", "# 售后服务政策\n\n## 退换货\n签收后 7 天内商品完好可申请无理由退货，买了不想要可以退。退款在审核通过后 1–3 个工作日原路退回；质量问题退货运费由公司承担。\n\n"
         "## 保修\n储能柜整机保修 5 年，电芯保修 10 年。人为损坏、私自拆机不在保修范围内。\n\n"
         "## 故障代码\nE07 表示 BMS 通讯中断，请先检查通讯线连接，再断电重启；仍无法恢复请报修。\n\n"
         "## 上门服务\n金卡及以上会员可预约免费上门取件，普通会员可付费预约。\n", "heading"),
        ("常见问题.csv", "问题,答案\n买了不想要能退吗？,签收 7 天内商品完好可无理由退货。\n退款多久到账？,审核通过后 1–3 个工作日原路退回。\n发票怎么开？,在订单详情页申请电子发票，1 个工作日内发送到邮箱。\n", "qa"),
    ],
    "公司制度库": [
        ("员工手册.md", "# 员工手册\n\n## 考勤\n标准工作时间 9:00–18:00，弹性打卡窗口 30 分钟。\n\n## 年假\n入职满一年享 5 天年假，每满一年加 1 天，最多 15 天。\n\n## 报销\n差旅报销需在出差结束后 15 天内提交，附发票原件。\n", "heading"),
    ],
    "行业研究库": [
        ("储能行业周报.md", "# 储能行业周报\n\n## 装机\n2026 年前三季度国内新型储能新增装机同比增长 48%，工商业储能占比提升。\n\n## 价格\n280Ah 电芯均价降至 0.32 元/Wh，系统中标价继续下探。\n\n## 竞争格局\n头部集成商份额集中，电芯厂向下游延伸，新进入者以工商业场景切入。\n", "heading"),
    ],
    "法务条款库": [
        ("采购合同审查要点.md", "# 采购合同审查要点\n\n## 付款\n预付款不超过 30%，验收合格后支付尾款。\n\n## 违约责任\n违约金上限一般为合同总额的 20%，避免约定由我方承担全部损失。\n\n## 质保\n质保期不少于 24 个月，质保金比例 3%–5%。\n", "heading"),
    ],
}


def main() -> None:
    client = httpx.Client(base_url=API, timeout=60)
    token = client.post("/auth/login", json={"email": "admin@fde.local", "password": "fde-dev-admin"}).json()["token"]
    client.headers["Authorization"] = f"Bearer {token}"

    def post(path: str, **kwargs):
        response = client.post(path, **kwargs)
        assert response.status_code < 300, f"{path} {response.status_code} {response.text}"
        return response.json() if response.content else None

    pricing = {"input_price_per_million": 2.0, "output_price_per_million": 8.0, "currency": "USD"}
    chat_llm = post("/models", json={"display_name": "DeepSeek V3（演示）", "provider": "mock", "model_type": "llm", "model_name": "deepseek-chat", "config": {"response_text": ANSWER, **pricing}})["id"]
    doc_llm = post("/models", json={"display_name": "Qwen3 Max（演示）", "provider": "mock", "model_type": "llm", "model_name": "qwen3-max", "config": pricing})["id"]
    enhance_llm = post("/models", json={"display_name": "Qwen 文本理解（演示）", "provider": "mock", "model_type": "llm", "model_name": "qwen-plus", "config": {"response_text": ENHANCE}})["id"]
    embedding = post("/models", json={"display_name": "BGE-M3（演示）", "provider": "mock", "model_type": "embedding", "model_name": "bge-m3", "config": {}})["id"]

    kbs: dict[str, str] = {}
    for name, files in DOCS.items():
        kb = post("/knowledge-bases", json={"name": name, "embedding_model_id": embedding, "semantic_llm_model_id": enhance_llm, "chunk_size": 800, "chunk_overlap": 120})
        kbs[name] = kb["id"]
        for filename, content, method in files:
            enhance = name == "售后服务政策" and method == "heading"
            post(f"/knowledge-bases/{kb['id']}/files",
                 files={"upload": (filename, content.encode(), "text/csv" if filename.endswith(".csv") else "text/markdown")},
                 data={"config": json.dumps({"method": method, "heading_level": 2, "enhance_keywords": enhance, "enhance_qa": enhance})})

    retrieval = [{"name": "knowledge_retrieval", "enabled": True, "config": {"mode": "fulltext", "top_k": 3, "rerank_top_n": 3, "score_threshold": 0.55}}]
    apps: dict[str, str] = {}

    def create(manifest: dict, publish: bool = True) -> str:
        app = post("/fde/apps", json={"manifest": {"schema_version": "fde.app/v2", **manifest}})
        if publish:
            post(f"/fde/apps/{app['id']}/release", json={"release_notes": "首次发布"})
        apps[manifest["name"]] = app["id"]
        return app["id"]

    create({
        "type": "agent", "name": "售后客服助手", "description": "回答退换货、保修和会员权益问题，投诉与赔偿自动转人工", "template_key": "customer_service",
        "system_prompt": "你是储能产品的售后客服，语气专业、耐心。依据知识库回答退换货、保修和会员权益问题；涉及投诉、赔偿或无法确认的情况转人工。",
        "llm_model_id": chat_llm, "knowledge_base_ids": [kbs["售后服务政策"]], "tools": retrieval,
        "guardrails": {"human_handoff": True, "refuse_without_evidence": True}, "agent": {"knowledge_mode": "always"},
        "delivery": {"show_citations": True},
        "experience": {"opening": "你好，我是售后客服助手，可以帮你查询退换货、保修和会员权益。", "suggestions": ["买了不想要能退吗？", "储能柜保修多久？", "E07 是什么故障？"]},
    })
    create({
        "type": "simple", "name": "制度问答", "description": "基于公司制度库回答员工问题，附原文引用", "template_key": "qa",
        "system_prompt": "你是企业知识助手。仅依据检索到的制度回答；信息不足时明确说明，不要编造，并标注来源。",
        "llm_model_id": chat_llm, "knowledge_base_ids": [kbs["公司制度库"]], "tools": retrieval,
        "input_fields": [{"key": "question", "label": "问题", "type": "textarea", "required": True}],
    })
    for name, template, kb, description in (("行业研究报告", "report", "行业研究库", "确认需求和大纲后逐章撰写行业研究报告"), ("合同风险审校", "review", "法务条款库", "提取合同要素，对照条款库逐条标注风险等级")):
        flow = json.loads((ROOT / "flows" / f"{template}.json").read_text())
        for node in flow["graph"]["nodes"]:
            if node["kind"] == "kb":
                node["config"]["knowledge_base_ids"] = [kbs[kb]]
        create({"type": "chatflow", "name": name, "description": description, "template_key": template, "system_prompt": "你是严谨的企业分析助手，结论要有依据。", "llm_model_id": doc_llm, **flow})
    templates = {item["key"]: item for item in client.get("/fde/templates").json()}
    content = templates["content"]
    create({"type": "simple", "name": "营销文案助手", "description": "按渠道和语气生成产品推广文案", "template_key": "content", "system_prompt": content["system_prompt"], "llm_model_id": chat_llm, "input_fields": content["input_fields"]}, publish=False)

    # 业务人员：用各自账号使用应用，产生看板与可观测数据
    people = [("li.na@demo.local", "李娜"), ("wang.qiang@demo.local", "王强"), ("zhao.min@demo.local", "赵敏")]
    sessions = []
    for email, display in people:
        post("/auth/users", json={"email": email, "display_name": display, "password": "demo-pass-2026", "role": "user"})
        user = httpx.Client(base_url=API, timeout=60)
        user.headers["Authorization"] = "Bearer " + user.post("/auth/login", json={"email": email, "password": "demo-pass-2026"}).json()["token"]
        sessions.append(user)

    service = apps["售后客服助手"]
    questions = ["买了不想要能退吗？", "退款多久到账？", "储能柜保修多久？", "E07 是什么故障？", "可以上门取件吗？", "我要投诉，商品有质量问题", "电池鼓包能赔偿吗？", "发票怎么开？", "退货运费谁出？"]
    for index in range(36):
        user = sessions[index % len(sessions)]
        ran = user.post(f"/fde/apps/{service}/run", json={"message": questions[index % len(questions)], "input_values": {}})
        if ran.status_code == 200 and index % 4 != 3:
            user.post(f"/fde/messages/{ran.json()['message_id']}/feedback", json={"rating": -1 if ran.json()["handoff"] else 1})
    for index, question in enumerate(["年假有几天？", "差旅报销期限是多久？", "弹性打卡怎么算？", "试用期多久？"] * 3):
        sessions[index % 3].post(f"/fde/apps/{apps['制度问答']}/run", json={"message": question, "input_values": {"question": question}})
    for user in sessions:
        paused = user.post(f"/fde/apps/{apps['行业研究报告']}/run", json={"message": "帮我写一份储能行业竞争格局报告", "input_values": {}}).json()
        user.post(f"/fde/apps/{apps['行业研究报告']}/run", json={"conversation_id": paused["conversation_id"], "resume": {"message_id": paused["message_id"], "values": {"topic": "2026 储能行业竞争格局", "audience": "公司管理层", "length": "约 6000 字"}}})

    # 管理员自己的一段客服对话：用于对话页截图
    first = post(f"/fde/apps/{service}/run", json={"message": "买了不想要能退吗？", "input_values": {}})
    post(f"/fde/apps/{service}/run", json={"message": "我要投诉，商品有质量问题", "input_values": {}, "conversation_id": first["conversation_id"]})
    post(f"/fde/apps/{apps['制度问答']}/run", json={"message": "年假有几天？", "input_values": {"question": "年假有几天？"}})

    suite = post("/evaluation-sets", json={"app_id": service, "name": "售后回归集"})["id"]
    for name, message, keywords in (
        ("无理由退货", "买了不想要能退吗？", ["7 天"]), ("退款时效", "退款多久到账？", ["工作日"]), ("保修期限", "储能柜保修多久？", ["5 年"]),
        ("投诉转人工", "我要投诉，商品有质量问题", ["人工"]), ("上门取件", "可以上门取件吗？", ["上门取件"]),
    ):
        post(f"/evaluation-sets/{suite}/cases", json={"name": name, "message": message, "input_values": {}, "expected_keywords": keywords})
    client.patch(f"/evaluation-sets/{suite}", json={"is_release_gate": True})
    post(f"/evaluation-sets/{suite}/run")

    # 演示数据的运行时间分散到最近 7 天，让看板和可观测的趋势图有起伏
    random.seed(7)
    with sqlite3.connect(DEMO_DB) as db:
        now = datetime.now(UTC)
        rows = db.execute("SELECT id, conversation_id FROM query_logs WHERE channel != 'debug' ORDER BY started_at").fetchall()
        for index, (log_id, _conversation) in enumerate(rows[:-4]):
            shifted = now - timedelta(days=random.choice([0, 1, 1, 2, 2, 3, 4, 5, 6]), hours=random.randint(1, 9), minutes=random.randint(0, 59))
            db.execute("UPDATE query_logs SET started_at = ?, finished_at = ? WHERE id = ?", (shifted.isoformat(), shifted.isoformat(), log_id))
    print(json.dumps({"apps": apps, "knowledge_bases": kbs, "evaluation_set": suite, "conversation": first["conversation_id"], "trace": first["trace_id"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
