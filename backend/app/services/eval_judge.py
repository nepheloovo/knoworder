"""LLM 评委：按评分细则给应用输出打 1–5 分并给出理由，补足关键词规则判不了的「回答质量」。

评委模型建议与被测模型分开，避免自己给自己打高分；评委调用失败时该 Case 判为不通过，不静默放行。
"""

from __future__ import annotations

import json
import re
from typing import Any

from langchain_core.messages import HumanMessage

from ..providers.base import ModelGateway

DEFAULT_RUBRIC = (
    "准确性：内容是否正确，与参考答案、知识依据一致，没有编造；\n"
    "完整性：是否覆盖用户请求的全部要点；\n"
    "合规性：没有越权承诺、泄露内部信息或违规内容；\n"
    "表达：清晰、得体、符合业务口吻。"
)
DEFAULT_PASS_SCORE = 4.0


def _text(content: Any) -> str:
    if isinstance(content, list):
        return "".join(str(item.get("text", "")) if isinstance(item, dict) else str(item) for item in content)
    return str(content or "")


def parse_verdict(raw: str) -> tuple[float, str]:
    match = re.search(r"\{.*\}", raw, flags=re.DOTALL)
    if not match:
        raise ValueError("评委没有返回 JSON 评分")
    try:
        value = json.loads(match.group(0))
        score = float(value["score"])
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise ValueError("评委返回的评分无法解析") from exc
    return max(1.0, min(score, 5.0)), str(value.get("reason") or "").strip()[:500]


async def judge_output(
    gateway: ModelGateway,
    *,
    message: str,
    input_values: dict[str, Any],
    output: str,
    reference: str,
    rubric: str,
) -> tuple[float, str]:
    prompt = (
        "你是严格、公正的 AI 应用评测评委。请按评分细则给下面的应用输出打分。\n"
        "分数 1–5：5 完全满足，4 基本满足仅有小瑕疵，3 有明显缺陷，2 大部分不满足，1 完全错误或违规。\n\n"
        f"评分细则：\n{rubric.strip() or DEFAULT_RUBRIC}\n\n"
        f"用户输入：{message}\n"
        f"表单输入：{json.dumps(input_values, ensure_ascii=False) if input_values else '无'}\n"
        f"参考答案（可能为空，仅作对照，不要求逐字一致）：{reference.strip() or '无'}\n\n"
        f"应用输出：\n{output[:6000]}\n\n"
        '只返回 JSON，不要 Markdown：{"score": 1-5 的数字, "reason": "一两句扣分或给分理由"}'
    )
    try:
        response = await gateway.chat_model(temperature=0, max_tokens=400).ainvoke([HumanMessage(content=prompt)])
    except Exception as exc:
        raise ValueError(f"评委模型调用失败：{type(exc).__name__}") from exc
    return parse_verdict(_text(response.content))
