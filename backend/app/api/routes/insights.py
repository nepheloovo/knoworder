"""运营看板：调用量、满意度、知识命中率、转人工率，以及把未解决的问题聚成知识缺口回流到知识库。

全部从线上运行日志（QueryLog）和用户反馈（Feedback）实时汇总，编排页里的调试运行（channel=debug）不计入。
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ...db import get_session
from ...models import Conversation, Feedback, QAApp, QueryLog, RunStatus
from ...security import AuthContext, require_roles

router = APIRouter(dependencies=[Depends(require_roles("admin", "manager"))])

GAP_SIMILARITY = 0.55


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _rate(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def _bigrams(text: str) -> set[str]:
    compact = re.sub(r"[\s\W_]+", "", text.lower())
    return {compact[index : index + 2] for index in range(len(compact) - 1)} or {compact}


def cluster_questions(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按字符二元组 Dice 相似度贪心聚类，词序不同的相近问法合成一个缺口（不理解语义，同义改写可能分开）。"""
    clusters: list[dict[str, Any]] = []
    for item in items:
        grams = _bigrams(item["query"])
        best, best_score = None, GAP_SIMILARITY
        for cluster in clusters:
            score = 2 * len(grams & cluster["grams"]) / max(len(grams) + len(cluster["grams"]), 1)
            if score >= best_score:
                best, best_score = cluster, score
        if best is None:
            best = {"grams": grams, "question": item["query"], "samples": [], "count": 0, "reasons": defaultdict(int), "apps": defaultdict(int), "last_at": item["at"]}
            clusters.append(best)
        best["count"] += 1
        best["reasons"][item["reason"]] += 1
        best["apps"][item["app_id"]] += 1
        best["last_at"] = max(best["last_at"], item["at"])
        if item["query"] not in best["samples"] and len(best["samples"]) < 5:
            best["samples"].append(item["query"])
    return sorted(clusters, key=lambda cluster: (cluster["count"], cluster["last_at"]), reverse=True)


@router.get("")
async def insights(
    days: int = Query(default=7, ge=1, le=90),
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    now = datetime.now(UTC)
    since, previous_since = now - timedelta(days=days), now - timedelta(days=days * 2)
    rows = (
        await session.execute(
            select(
                QueryLog.app_id, QueryLog.status, QueryLog.query, QueryLog.started_at, QueryLog.run_metadata,
                QueryLog.message_id, QueryLog.trace_id, Conversation.user_id,
            )
            .outerjoin(Conversation, Conversation.id == QueryLog.conversation_id)
            .where(QueryLog.workspace_id == context.workspace_id, QueryLog.started_at >= previous_since, QueryLog.channel != "debug")
            .order_by(QueryLog.started_at.desc())
            .limit(50000)
        )
    ).all()
    message_ids = {row.message_id for row in rows if row.message_id}
    ratings: dict[str, int] = {}
    if message_ids:
        for message_id, rating in (await session.execute(select(Feedback.message_id, Feedback.rating).where(Feedback.message_id.in_(message_ids)).order_by(Feedback.created_at))).all():
            ratings[message_id] = rating  # 同一条回答多次反馈时以最后一次为准
    apps = {
        app.id: app
        for app in await session.scalars(select(QAApp).where(QAApp.workspace_id == context.workspace_id).options(selectinload(QAApp.knowledge_bases)))
    }

    def summarize(window: list[Any]) -> dict[str, Any]:
        success = [row for row in window if row.status == RunStatus.SUCCESS]
        knowledge_runs = [row for row in success if row.app_id in apps and apps[row.app_id].knowledge_bases]
        rated = [ratings[row.message_id] for row in window if row.message_id in ratings]
        return {
            "runs": len(window),
            "active_users": len({row.user_id for row in window if row.user_id}),
            "satisfaction": _rate(sum(1 for rating in rated if rating > 0), len(rated)),
            "feedback_count": len(rated),
            "hit_rate": _rate(sum(1 for row in knowledge_runs if (row.run_metadata or {}).get("citation_count")), len(knowledge_runs)),
            "handoff_rate": _rate(sum(1 for row in success if (row.run_metadata or {}).get("handoff")), len(success)),
        }

    current = [row for row in rows if _aware(row.started_at) >= since]
    previous = [row for row in rows if _aware(row.started_at) < since]

    today = now.date()
    daily = {(today - timedelta(days=offset)).isoformat(): 0 for offset in range(days - 1, -1, -1)}
    per_app: dict[str, list[Any]] = defaultdict(list)
    gap_items: list[dict[str, Any]] = []
    recent_issues: list[dict[str, Any]] = []
    for row in current:
        day = _aware(row.started_at).date().isoformat()
        if day in daily:
            daily[day] += 1
        if row.app_id:
            per_app[row.app_id].append(row)
        metadata = row.run_metadata or {}
        app = apps.get(row.app_id or "")
        reasons = []
        if ratings.get(row.message_id or "", 0) < 0:
            reasons.append("downvote")
        if row.status == RunStatus.SUCCESS and app and app.knowledge_bases and not metadata.get("citation_count"):
            reasons.append("nohit")
        if metadata.get("handoff"):
            reasons.append("handoff")
        if not reasons:
            continue
        if "downvote" in reasons or "nohit" in reasons:
            gap_items.append({"query": row.query, "reason": "downvote" if "downvote" in reasons else "nohit", "app_id": row.app_id, "at": _aware(row.started_at)})
        if len(recent_issues) < 10:
            recent_issues.append({
                "trace_id": row.trace_id, "query": row.query, "app_id": row.app_id, "app_name": app.name if app else "已删除应用",
                "reasons": reasons, "at": _aware(row.started_at).isoformat(),
            })

    ranking = []
    for app_id, app_rows in per_app.items():
        stats = summarize(app_rows)
        app = apps.get(app_id)
        ranking.append({"app_id": app_id, "name": app.name if app else "已删除应用", "runs": stats["runs"], "satisfaction": stats["satisfaction"], "handoff_rate": stats["handoff_rate"]})
    ranking.sort(key=lambda item: item["runs"], reverse=True)

    gaps = []
    for cluster in cluster_questions(gap_items)[:20]:
        app_id = max(cluster["apps"], key=cluster["apps"].get)
        app = apps.get(app_id or "")
        knowledge_base = app.knowledge_bases[0] if app and app.knowledge_bases else None
        gaps.append({
            "question": cluster["question"], "samples": cluster["samples"], "count": cluster["count"], "reasons": dict(cluster["reasons"]),
            "app_id": app_id, "app_name": app.name if app else "已删除应用",
            "knowledge_base_id": knowledge_base.id if knowledge_base else None, "knowledge_base_name": knowledge_base.name if knowledge_base else None,
            "last_at": cluster["last_at"].isoformat(),
        })

    return {
        "days": days,
        "current": summarize(current),
        "previous": summarize(previous),
        "daily": [{"date": day, "runs": count} for day, count in daily.items()],
        "ranking": ranking[:10],
        "gaps": gaps,
        "recent_issues": recent_issues,
    }
