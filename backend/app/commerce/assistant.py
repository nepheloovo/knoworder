"""智能客服的业务工具。

买家身份在构造时由服务端传入，工具参数里没有 customer_id，模型无法查询其他买家的数据。
未接真实模型时，scripted_reply 用关键词识别意图，走同一套工具函数。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from langchain_core.tools import StructuredTool
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..models import Customer, InventoryBalance, Location, OrderItem, Product, SalesOrder, Sku
from .service import AFTER_SALE_KIND_LABEL, ORDER_STATUS_LABEL, BusinessError, create_after_sale, yuan

ORDER_NO = re.compile(r"SO\d{6,}", re.IGNORECASE)
HANDOFF = re.compile(r"人工|转接|投诉|赔偿|客服经理|12315")
APPLY_AFTER_SALE = re.compile(r"(我要|我想|想要|帮我|申请|给我).{0,8}(退货|退款|换货)")
LOGISTICS = re.compile(r"物流|快递|到哪|发货了吗|发货没|什么时候到|单号")
STOCK = re.compile(r"库存|有货|有现货|还有吗|缺货|补货")
ORDERS = re.compile(r"订单|买了什么|下的单")


@dataclass(slots=True)
class ToolCall:
    name: str
    label: str
    arguments: dict[str, Any]
    result: str


@dataclass(slots=True)
class ScriptedReply:
    answer: str
    calls: list[ToolCall] = field(default_factory=list)
    handoff: bool = False
    handoff_reason: str = ""
    used_knowledge: bool = False


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


class CommerceToolset:
    def __init__(self, session: AsyncSession, workspace_id: str, customer: Customer) -> None:
        self.session = session
        self.workspace_id = workspace_id
        self.customer = customer

    async def _orders(self, order_no: str = "") -> list[SalesOrder]:
        query = (
            select(SalesOrder)
            .where(SalesOrder.workspace_id == self.workspace_id, SalesOrder.customer_id == self.customer.id)
            .options(selectinload(SalesOrder.items).selectinload(OrderItem.sku).selectinload(Sku.product), selectinload(SalesOrder.shipment))
            .order_by(SalesOrder.created_at.desc())
        )
        if order_no:
            query = query.where(SalesOrder.order_no == order_no.strip().upper())
        return list(await self.session.scalars(query.limit(10)))

    @staticmethod
    def _order_view(order: SalesOrder) -> dict[str, Any]:
        return {
            "order_no": order.order_no,
            "status": ORDER_STATUS_LABEL.get(order.status, order.status),
            "amount": yuan(order.total_cents),
            "items": [f"{item.sku.product.name} {item.sku.spec} ×{item.quantity}".replace("  ", " ") for item in order.items],
        }

    async def query_orders(self, order_no: str = "") -> str:
        orders = await self._orders(order_no)
        return _dump([self._order_view(item) for item in orders]) if orders else "没有查到这位买家名下的相关订单。"

    async def query_logistics(self, order_no: str = "") -> str:
        orders = await self._orders(order_no)
        if not orders:
            return "没有查到这位买家名下的相关订单。"
        target = orders if order_no else orders[:3]
        views = []
        for order in target:
            shipment = order.shipment
            views.append({
                "order_no": order.order_no,
                "status": ORDER_STATUS_LABEL.get(order.status, order.status),
                "carrier": shipment.carrier if shipment else None,
                "tracking_no": shipment.tracking_no if shipment else None,
                "latest": shipment.events[-1]["text"] if shipment and shipment.events else "仓库尚未发货",
            })
        return _dump(views)

    async def query_stock(self, keyword: str) -> str:
        term = f"%{keyword.strip()}%"
        skus = list(await self.session.scalars(
            select(Sku).join(Product, Product.id == Sku.product_id).where(Sku.workspace_id == self.workspace_id, or_(Product.name.like(term), Sku.code.like(term), Sku.spec.like(term))).options(selectinload(Sku.product)).limit(8)
        ))
        if not skus:
            return "没有找到相关商品。"
        views = []
        for sku in skus:
            rows = (await self.session.execute(
                select(InventoryBalance.on_hand, InventoryBalance.locked).join(Location, Location.id == InventoryBalance.location_id).where(InventoryBalance.sku_id == sku.id, Location.kind == "storage")
            )).all()
            available = sum(row.on_hand - row.locked for row in rows)
            # 对买家只说有无货，不暴露精确库存
            views.append({"product": f"{sku.product.name} {sku.spec}".strip(), "code": sku.code, "price": yuan(sku.price_cents), "in_stock": available > 0, "stock_tip": "库存充足" if available > sku.low_stock_threshold else "库存紧张" if available > 0 else "暂时缺货"})
        return _dump(views)

    async def request_after_sale(self, order_no: str, kind: str, reason: str = "") -> str:
        orders = await self._orders(order_no)
        if not orders:
            return "没有查到这位买家名下的这笔订单，不能创建售后。"
        try:
            record = await create_after_sale(self.session, order=orders[0], kind=kind, reason=reason or "买家通过智能客服申请", source="ai")
        except BusinessError as exc:
            return f"创建失败：{exc}"
        return _dump({"after_sale_no": record.after_sale_no, "kind": AFTER_SALE_KIND_LABEL[record.kind], "status": "待审核", "amount": yuan(record.amount_cents)})

    def structured_tools(self) -> list[tuple[str, StructuredTool]]:
        order_no = {"type": "string", "description": "订单号，例如 SO1109120000123；不知道就留空"}
        return [
            ("查询订单", StructuredTool(name="query_orders", description="查询当前买家的订单、状态和商品。", args_schema={"type": "object", "properties": {"order_no": order_no}}, coroutine=self.query_orders)),
            ("查询物流", StructuredTool(name="query_logistics", description="查询当前买家订单的快递公司、运单号和最新物流。", args_schema={"type": "object", "properties": {"order_no": order_no}}, coroutine=self.query_logistics)),
            ("查询库存", StructuredTool(name="query_stock", description="按商品名或规格查询是否有货。", args_schema={"type": "object", "required": ["keyword"], "properties": {"keyword": {"type": "string", "description": "商品名、规格或编码"}}}, coroutine=self.query_stock)),
            ("申请售后", StructuredTool(
                name="request_after_sale",
                description="在买家明确要求后创建售后申请，创建后由人工审核，退款金额由系统按订单计算。",
                args_schema={"type": "object", "required": ["order_no", "kind"], "properties": {"order_no": order_no, "kind": {"type": "string", "enum": ["refund", "return", "exchange"], "description": "refund 仅退款，return 退货退款，exchange 换货"}, "reason": {"type": "string", "description": "买家说明的原因"}}},
                coroutine=self.request_after_sale,
            )),
        ]

    async def scripted_reply(self, query: str, context: str) -> ScriptedReply:
        text = query.strip()
        mentioned = ORDER_NO.search(text)
        order_no = mentioned.group(0).upper() if mentioned else ""

        if HANDOFF.search(text):
            return ScriptedReply("已为您转接人工客服，正在排队，请稍候。", handoff=True, handoff_reason=text[:200])

        if APPLY_AFTER_SALE.search(text):
            return await self._apply_after_sale(text, order_no)

        if LOGISTICS.search(text):
            result = await self.query_logistics(order_no)
            call = ToolCall("query_logistics", "查询物流", {"order_no": order_no}, result)
            if result.startswith("没有"):
                return ScriptedReply("没有查到您名下的这笔订单，请核对订单号。", [call])
            lines = [f"订单 {item['order_no']}（{item['status']}）：" + (f"{item['carrier']} {item['tracking_no']}，{item['latest']}" if item["carrier"] else item["latest"]) for item in json.loads(result)]
            return ScriptedReply("\n".join(lines), [call])

        if STOCK.search(text):
            keyword = self._stock_keyword(text)
            result = await self.query_stock(keyword)
            call = ToolCall("query_stock", "查询库存", {"keyword": keyword}, result)
            if result.startswith("没有"):
                return ScriptedReply("没有找到相关商品，可以告诉我完整的商品名称吗？", [call])
            return ScriptedReply("\n".join(f"{item['product']}（¥{item['price']:.2f}）：{item['stock_tip']}" for item in json.loads(result)), [call])

        if ORDERS.search(text) or order_no:
            result = await self.query_orders(order_no)
            call = ToolCall("query_orders", "查询订单", {"order_no": order_no}, result)
            if result.startswith("没有"):
                return ScriptedReply("没有查到您名下的相关订单，请核对订单号。", [call])
            return ScriptedReply("\n".join(f"订单 {item['order_no']}：{item['status']}，¥{item['amount']:.2f}，{'、'.join(item['items'])}" for item in json.loads(result)), [call])

        if context:
            # 上下文按相关度排序，每段第一行是「[资料 n] 文件名」，规则模式只取最相关的一段正文
            best = context.split("\n\n", 1)[0].split("\n", 1)[-1]
            return ScriptedReply(f"根据我们的服务资料：{best}", used_knowledge=True)
        return ScriptedReply("这个问题我暂时无法确定。您可以问我订单、物流、库存或退换货，也可以说「转人工」。")

    async def _apply_after_sale(self, text: str, order_no: str) -> ScriptedReply:
        kind = "exchange" if "换货" in text else "refund" if "退款" in text and "退货" not in text else "return"
        orders = await self._orders(order_no)
        eligible = [item for item in orders if item.status in {"shipped", "delivered"}] if not order_no else orders
        if not eligible:
            return ScriptedReply("没有查到可以申请售后的订单，请提供订单号。")
        target = eligible[0].order_no
        arguments = {"order_no": target, "kind": kind, "reason": text[:200]}
        result = await self.request_after_sale(**arguments)
        call = ToolCall("request_after_sale", "申请售后", arguments, result)
        if not result.startswith("{"):
            return ScriptedReply(result.replace("创建失败：", "暂时无法提交："), [call])
        data = json.loads(result)
        return ScriptedReply(f"已为订单 {target} 提交{data['kind']}申请，售后单号 {data['after_sale_no']}，涉及金额 ¥{data['amount']:.2f}。工作人员审核后会尽快处理。", [call])

    @staticmethod
    def _stock_keyword(text: str) -> str:
        stripped = re.sub(r"还有货|有现货|有货|还有|库存|吗|呢|么|请问|查一下|帮我|查|多少|的|？|\?|。|，|,|缺货|补货", "", text).strip()
        return stripped or text[:20]
