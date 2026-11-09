"""按用例标签里的金标给评测结果判分：检索、工具调用、槽位、拒答。

金标写在 Case 的标签里：``doc:`` 应检索文档，``tool:`` 期望工具，``slot:名称=值`` 槽位，
``应拒答``，``metric:`` 该用例适用的指标。没有这些标签的 Case 不受影响。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from ..commerce.assistant import CommerceToolset
from ..commerce.service import AFTER_SALE_KIND_LABEL
from ..models import KnowledgeBase
from .retrieval import retrieve_knowledge_base

PLATFORM_TOOLS = {"query_orders", "query_logistics", "query_stock", "request_after_sale"}
# 评测集使用通用工具名，这里映射到中台实际的工具；映射不到的工具中台没有，按未调用计
TOOL_ALIASES = {
    "query_order": "query_orders",
    "query_tracking": "query_logistics",
    "query_inventory": "query_stock",
    "create_aftersale": "request_after_sale",
}
AFTER_SALE_KINDS = {"退货": "return", "换货": "exchange", "退款": "refund"}
RETRIEVAL_METRICS = ("recall_at_k", "context_recall", "mrr", "ndcg")
ANSWER_METRICS = ("answer_correctness", "faithfulness", "multi_hop_coverage", "context_resolution")
REFUSAL = re.compile(r"无法|不能|抱歉|不支持|不提供|没有权限|无权|未检索到|人工客服|人工处理|不确定|不清楚|超出")
RETRIEVAL_DEPTH = 10
FIXTURE_ORDER = "E000000000000"


@dataclass(slots=True)
class Gold:
    docs: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)
    slots: dict[str, str] = field(default_factory=dict)
    metrics: set[str] = field(default_factory=set)
    refuse: bool = False


def parse_gold(tags: list[str]) -> Gold | None:
    gold = Gold()
    for tag in tags:
        if tag == "应拒答":
            gold.refuse = True
        elif tag.startswith("doc:"):
            gold.docs.append(tag[4:])
        elif tag.startswith("tool:"):
            gold.tools.append(tag[5:])
        elif tag.startswith("metric:"):
            gold.metrics.add(tag[7:])
        elif tag.startswith("slot:") and "=" in tag:
            name, value = tag[5:].split("=", 1)
            gold.slots[name] = value
    return gold if gold.docs or gold.tools or gold.slots or gold.refuse else None


class EvalToolset(CommerceToolset):
    """评测专用：只记录调用并返回固定数据，不读写业务库，创建售后也不会落库。"""

    def __init__(self, session: AsyncSession, workspace_id: str) -> None:
        super().__init__(session, workspace_id, None)  # type: ignore[arg-type]
        self.calls: list[dict[str, Any]] = []

    async def _orders(self, order_no: str = "") -> list[Any]:
        return [SimpleNamespace(order_no=order_no.strip().upper() or FIXTURE_ORDER, status="shipped")]

    async def query_orders(self, order_no: str = "") -> str:
        self.calls.append({"name": "query_orders", "arguments": {"order_no": order_no}})
        return json.dumps([{"order_no": order_no or FIXTURE_ORDER, "status": "已发货", "amount": 99.0, "items": ["评测商品 ×1"]}], ensure_ascii=False)

    async def query_logistics(self, order_no: str = "") -> str:
        self.calls.append({"name": "query_logistics", "arguments": {"order_no": order_no}})
        return json.dumps([{"order_no": order_no or FIXTURE_ORDER, "status": "已发货", "carrier": "评测快递", "tracking_no": "EVAL0000001", "latest": "运输中"}], ensure_ascii=False)

    async def query_stock(self, keyword: str) -> str:
        self.calls.append({"name": "query_stock", "arguments": {"keyword": keyword}})
        return json.dumps([{"product": keyword, "code": "EVAL-SKU", "price": 99.0, "in_stock": True, "stock_tip": "有货"}], ensure_ascii=False)

    async def request_after_sale(self, order_no: str, kind: str, reason: str = "") -> str:
        self.calls.append({"name": "request_after_sale", "arguments": {"order_no": order_no, "kind": kind, "reason": reason}})
        return json.dumps({"after_sale_no": "EVAL-AS-1", "kind": AFTER_SALE_KIND_LABEL.get(kind, kind), "status": "待审核", "amount": 99.0}, ensure_ascii=False)


async def ranked_documents(session: AsyncSession, knowledge_bases: list[KnowledgeBase], query: str, mode: str) -> list[str]:
    """按相关度返回文件名，同一文件只保留最靠前的一次。"""
    chunks = []
    for knowledge_base in knowledge_bases:
        run = await retrieve_knowledge_base(
            session, knowledge_base, query, top_k=RETRIEVAL_DEPTH, rerank_top_n=RETRIEVAL_DEPTH, score_threshold=-1.0, mode=mode,
        )
        chunks.extend(run.results)
    chunks.sort(key=lambda item: item.final_score, reverse=True)
    return list(dict.fromkeys(item.filename for item in chunks))


def _matches(doc_id: str, filename: str) -> bool:
    return filename == doc_id or filename.startswith((f"{doc_id}_", f"{doc_id}."))


def _compact(value: Any) -> str:
    return re.sub(r"[^0-9a-z一-鿿]", "", str(value).lower())


def _slot_found(name: str, value: str, calls: list[dict[str, Any]]) -> bool:
    target = _compact(value)
    for call in calls:
        arguments = call["arguments"]
        if any(target in _compact(item) for item in arguments.values()):
            return True
        if name == "aftersale_type" and any(word in value and arguments.get("kind") == kind for word, kind in AFTER_SALE_KINDS.items()):
            return True
    return False


def _in_order(expected: list[str], called: list[str]) -> bool:
    remaining = iter(called)
    return all(name in remaining for name in expected)


def score_case(gold: Gold, *, output: str, handoff: bool, calls: list[dict[str, Any]] | None, ranked: list[str] | None) -> tuple[dict[str, Any], list[str]]:
    """返回 (各项得分, 未通过原因)。只评该用例声明的指标；没有可评数据的项跳过。"""
    scores: dict[str, Any] = {}
    reasons: list[str] = []

    def wants(*names: str) -> bool:
        return not gold.metrics or bool(gold.metrics.intersection(names))

    if gold.docs and ranked is not None and wants(*RETRIEVAL_METRICS):
        ranks = [next((index for index, name in enumerate(ranked, start=1) if _matches(doc, name)), None) for doc in gold.docs]
        hits = [rank for rank in ranks if rank is not None]
        recall_at_5 = sum(rank <= 5 for rank in hits) / len(gold.docs)
        scores["retrieval"] = {
            "recall_at_5": recall_at_5,
            "recall_at_10": len(hits) / len(gold.docs),
            "reciprocal_rank": 1 / min(hits) if hits else 0.0,
        }
        missing = [doc for doc, rank in zip(gold.docs, ranks) if rank is None or rank > 5]
        if missing:
            reasons.append(f"Top 5 未检索到：{'、'.join(missing)}")

    if gold.tools and calls is not None and wants("tool_accuracy", "tool_order_accuracy"):
        expected = [TOOL_ALIASES.get(name, name) for name in gold.tools]
        called = [item["name"] for item in calls]
        absent = [name for name, target in zip(gold.tools, expected) if target not in called]
        correct = not absent
        scores["tools"] = {"correct": correct, "expected": gold.tools, "called": called}
        if len(expected) > 1 and wants("tool_order_accuracy"):
            scores["tools"]["in_order"] = _in_order(expected, called)
        unsupported = [name for name in absent if TOOL_ALIASES.get(name, name) not in PLATFORM_TOOLS]
        callable_absent = [name for name in absent if name not in unsupported]
        if callable_absent:
            reasons.append(f"未调用工具：{'、'.join(callable_absent)}")
        if unsupported:
            reasons.append(f"中台没有该工具：{'、'.join(unsupported)}")
        if correct and scores["tools"].get("in_order") is False:
            reasons.append("工具调用顺序不对")

    if gold.slots and calls is not None and wants("slot_accuracy"):
        missing_slots = [name for name, value in gold.slots.items() if not _slot_found(name, value, calls)]
        scores["slots"] = {"correct": not missing_slots}
        if missing_slots:
            reasons.append(f"槽位未正确传入：{'、'.join(missing_slots)}")

    if gold.refuse:
        refused = handoff or bool(REFUSAL.search(output))
        scores["refusal"] = {"correct": refused}
        if not refused:
            reasons.append("应拒答或转人工，但直接作答了")
    return scores, reasons


def needs_answer_judge(gold: Gold) -> bool:
    return bool(gold.metrics.intersection(ANSWER_METRICS))


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    """汇总一次运行的指标，目标值取自评测集建议的第一轮通过线。"""
    scored = [item["scores"] for item in results if item.get("scores")]

    def metric(key: str, label: str, values: list[float], target: float | None = None) -> dict[str, Any] | None:
        if not values:
            return None
        value = sum(values) / len(values)
        return {"key": key, "label": label, "value": value, "count": len(values), "target": target, "passed": None if target is None else value >= target}

    retrieval = [item["retrieval"] for item in scored if "retrieval" in item]
    tools = [item["tools"] for item in scored if "tools" in item]
    candidates = [
        metric("recall_at_5", "Recall@5", [item["recall_at_5"] for item in retrieval], 0.85),
        metric("recall_at_10", "Recall@10", [item["recall_at_10"] for item in retrieval]),
        metric("mrr", "MRR", [item["reciprocal_rank"] for item in retrieval], 0.70),
        metric("tool_accuracy", "工具准确率", [float(item["correct"]) for item in tools], 0.90),
        metric("tool_order", "工具顺序", [float(item["in_order"]) for item in tools if "in_order" in item]),
        metric("slot_accuracy", "槽位准确率", [float(item["slots"]["correct"]) for item in scored if "slots" in item]),
        metric("refusal_accuracy", "拒答准确率", [float(item["refusal"]["correct"]) for item in scored if "refusal" in item], 0.95),
    ]
    return {
        "metrics": [item for item in candidates if item],
        "answer_unscored": sum(bool(item.get("answer_unscored")) for item in results),
    }
