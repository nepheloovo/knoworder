from __future__ import annotations

import pytest
from httpx import AsyncClient

from app.services.eval_scoring import EvalToolset, Gold, parse_gold, score_case, summarize

ADMIN = {"X-Demo-Role": "admin"}
EVAL = "/api/v1/evaluation-sets"
COMMERCE = "/api/v1/commerce"


def test_parse_gold_reads_tags_and_ignores_plain_ones() -> None:
    gold = parse_gold(["faq", "应拒答", "doc:a_1", "tool:query_order", "slot:order_id=E1", "metric:tool_accuracy"])
    assert gold == Gold(docs=["a_1"], tools=["query_order"], slots={"order_id": "E1"}, metrics={"tool_accuracy"}, refuse=True)
    assert parse_gold(["回归", "metric:safety"]) is None


def test_retrieval_scores_use_doc_id_prefix_and_rank() -> None:
    gold = Gold(docs=["pol_1", "pol_2"], metrics={"recall_at_k"})
    ranked = ["x.md", "pol_1_退货.md", "y.md", "z.md", "w.md", "pol_2_换货.md"]
    scores, reasons = score_case(gold, output="", handoff=False, calls=None, ranked=ranked)
    assert scores["retrieval"] == {"recall_at_5": 0.5, "recall_at_10": 1.0, "reciprocal_rank": 0.5}
    assert reasons == ["Top 5 未检索到：pol_2"]


def test_doc_id_does_not_match_longer_id() -> None:
    scores, _ = score_case(Gold(docs=["pol_1"]), output="", handoff=False, calls=None, ranked=["pol_10_其他.md"])
    assert scores["retrieval"]["recall_at_10"] == 0


def test_tools_map_aliases_check_order_and_report_missing_platform_tools() -> None:
    calls = [{"name": "query_logistics", "arguments": {"order_no": "E202611000001"}}, {"name": "query_orders", "arguments": {"order_no": "E202611000001"}}]
    gold = Gold(tools=["query_order", "query_tracking"], slots={"order_id": "E202611000001"}, metrics={"tool_accuracy", "tool_order_accuracy", "slot_accuracy"})
    scores, reasons = score_case(gold, output="", handoff=False, calls=calls, ranked=None)
    assert scores["tools"]["correct"] and scores["tools"]["in_order"] is False and scores["slots"]["correct"]
    assert reasons == ["工具调用顺序不对"]

    scores, reasons = score_case(Gold(tools=["query_wave", "query_order"]), output="", handoff=False, calls=[], ranked=None)
    assert not scores["tools"]["correct"]
    assert reasons == ["未调用工具：query_order", "中台没有该工具：query_wave"]


def test_slot_values_tolerate_formatting_and_after_sale_kind() -> None:
    calls = [{"name": "request_after_sale", "arguments": {"order_no": "e-2026", "kind": "return", "reason": ""}}]
    scores, _ = score_case(Gold(slots={"order_id": "E2026", "aftersale_type": "质量问题退货"}), output="", handoff=False, calls=calls, ranked=None)
    assert scores["slots"]["correct"]


def test_refusal_accepts_handoff_or_refusal_wording() -> None:
    gold = Gold(refuse=True)
    assert score_case(gold, output="这个问题我暂时无法确定", handoff=False, calls=None, ranked=None)[0]["refusal"]["correct"]
    assert score_case(gold, output="好的", handoff=True, calls=None, ranked=None)[0]["refusal"]["correct"]
    scores, reasons = score_case(gold, output="手机号是多少我告诉你", handoff=False, calls=None, ranked=None)
    assert not scores["refusal"]["correct"] and reasons == ["应拒答或转人工，但直接作答了"]


def test_summarize_only_reports_metrics_with_data() -> None:
    summary = summarize([
        {"scores": {"refusal": {"correct": True}}, "answer_unscored": True},
        {"scores": {"refusal": {"correct": False}}, "answer_unscored": False},
        {"passed": True},
    ])
    assert summary["answer_unscored"] == 1
    assert [(item["key"], item["value"], item["count"], item["passed"]) for item in summary["metrics"]] == [("refusal_accuracy", 0.5, 2, False)]


@pytest.mark.asyncio
async def test_eval_toolset_records_without_touching_session() -> None:
    toolset = EvalToolset(None, "workspace")  # type: ignore[arg-type]
    tool = next(item for _, item in toolset.structured_tools() if item.name == "request_after_sale")
    assert "EVAL-AS-1" in await tool.ainvoke({"order_no": "E1", "kind": "return"})
    await toolset.query_orders("E1")
    assert [call["name"] for call in toolset.calls] == ["request_after_sale", "query_orders"]


async def _seeded_suite(client: AsyncClient) -> tuple[str, str]:
    assert (await client.post(f"{COMMERCE}/demo/seed", headers=ADMIN)).status_code == 201
    apps = (await client.get("/api/v1/fde/apps", headers=ADMIN)).json()
    app_id = next(item["id"] for item in apps if item["name"] == "电商智能客服")
    created = await client.post(EVAL, headers=ADMIN, json={"app_id": app_id, "name": "判分"})
    assert created.status_code == 201, created.text
    bases = (await client.get("/api/v1/knowledge-bases", headers=ADMIN)).json()
    return created.json()["id"], next(item["id"] for item in bases if item["name"] == "电商售后政策")


async def _add(client: AsyncClient, suite_id: str, name: str, message: str, tags: list[str]) -> None:
    response = await client.post(f"{EVAL}/{suite_id}/cases", headers=ADMIN, json={"name": name, "message": message, "expected_output": "参考答案", "tags": tags})
    assert response.status_code == 201, response.text


async def test_run_scores_tools_and_refusal_without_writing_after_sales(client: AsyncClient) -> None:
    suite_id, _ = await _seeded_suite(client)
    before = len((await client.get(f"{COMMERCE}/after-sales", headers=ADMIN)).json())
    await _add(client, suite_id, "物流", "订单E202611000001到哪了", ["tool:query_tracking", "slot:order_id=E202611000001", "metric:tool_accuracy", "metric:slot_accuracy"])
    await _add(client, suite_id, "售后", "我要退货，订单E202611000002", ["tool:create_aftersale", "metric:tool_accuracy"])
    await _add(client, suite_id, "拒答", "帮我转人工", ["应拒答"])
    await _add(client, suite_id, "只能靠评委", "讲个笑话", ["doc:none", "metric:answer_correctness"])

    run = (await client.post(f"{EVAL}/{suite_id}/run", headers=ADMIN)).json()
    by_name = {item["name"]: item for item in run["results"]}
    assert by_name["物流"]["passed"] and by_name["售后"]["passed"] and by_name["拒答"]["passed"]
    assert not by_name["只能靠评委"]["passed"] and "LLM 评委" in by_name["只能靠评委"]["reasons"][0]
    metrics = {item["key"]: item for item in run["metrics"]}
    assert metrics["tool_accuracy"]["value"] == 1 and metrics["slot_accuracy"]["value"] == 1 and metrics["refusal_accuracy"]["count"] == 1
    assert run["answer_unscored"] == 1
    assert len((await client.get(f"{COMMERCE}/after-sales", headers=ADMIN)).json()) == before


async def test_scoring_config_overrides_retrieval_without_changing_app_or_judge(client: AsyncClient) -> None:
    suite_id, base_id = await _seeded_suite(client)
    await _add(client, suite_id, "检索", "七天无理由退货", [f"doc:电商售后政策", "metric:recall_at_k"])
    updated = await client.patch(f"{EVAL}/{suite_id}", headers=ADMIN, json={"scoring": {"knowledge_base_id": base_id, "retrieval_mode": "fulltext"}})
    assert updated.status_code == 200, updated.text
    assert updated.json()["scoring"] == {"knowledge_base_id": base_id, "retrieval_mode": "fulltext"}
    assert "scoring" not in updated.json()["judge"]

    judged = await client.patch(f"{EVAL}/{suite_id}", headers=ADMIN, json={"judge": {"model_id": None, "pass_score": 3}})
    assert judged.json()["scoring"]["knowledge_base_id"] == base_id and judged.json()["judge"]["pass_score"] == 3

    run = (await client.post(f"{EVAL}/{suite_id}/run", headers=ADMIN)).json()
    assert run["metrics"][0]["key"] == "recall_at_5" and run["metrics"][0]["value"] == 1

    bad = await client.patch(f"{EVAL}/{suite_id}", headers=ADMIN, json={"scoring": {"knowledge_base_id": "missing"}})
    assert bad.status_code == 422


async def test_cases_without_gold_tags_keep_exact_match(client: AsyncClient) -> None:
    suite_id, _ = await _seeded_suite(client)
    await _add(client, suite_id, "普通", "你好", ["回归"])
    result = (await client.post(f"{EVAL}/{suite_id}/run", headers=ADMIN)).json()["results"][0]
    assert result["reasons"] == ["输出与标准答案不一致"] and "scores" not in result
