"""订单、库存、出入库与售后的业务规则。所有函数只 flush，由接口层统一提交。"""

from __future__ import annotations

import random
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..models import (
    AfterSale,
    Customer,
    InboundOrder,
    InventoryBalance,
    InventoryMove,
    Location,
    OrderItem,
    OutboundLine,
    OutboundOrder,
    SalesOrder,
    Shipment,
    Shop,
    Sku,
    Warehouse,
)


class BusinessError(ValueError):
    """违反业务规则（库存不足、状态不允许等），接口层返回 409。"""


ORDER_STATUS_LABEL = {"paid": "待发货", "picking": "拣货中", "shipped": "已发货", "delivered": "已签收", "refunded": "已退款", "cancelled": "已取消"}
AFTER_SALE_KIND_LABEL = {"refund": "仅退款", "return": "退货退款", "exchange": "换货"}
AFTER_SALE_STATUS_LABEL = {"requested": "待审核", "approved": "待买家寄回", "returning": "退回中", "completed": "已完成", "rejected": "已驳回"}
ACTIVE_AFTER_SALE = ("requested", "approved", "returning")
CARRIERS = (("顺丰速运", "SF"), ("中通快递", "ZT"), ("京东物流", "JD"))


def now() -> datetime:
    return datetime.now(UTC)


def make_no(prefix: str) -> str:
    return f"{prefix}{now():%y%m%d}{random.randint(0, 999_999):06d}"


def yuan(cents: int) -> float:
    return round(cents / 100, 2)


def track_event(text: str) -> dict[str, str]:
    return {"at": now().isoformat(), "text": text}


async def apply_move(
    session: AsyncSession,
    *,
    workspace_id: str,
    sku_id: str,
    location: Location,
    kind: str,
    on_hand: int = 0,
    locked: int = 0,
    damaged: int = 0,
    ref_no: str = "",
    note: str = "",
    actor_id: str | None = None,
) -> InventoryBalance:
    """库存变化的唯一入口：同时更新余额并写流水，任何一项减到负数都拒绝。"""
    balance = await session.scalar(select(InventoryBalance).where(InventoryBalance.sku_id == sku_id, InventoryBalance.location_id == location.id))
    if balance is None:
        balance = InventoryBalance(workspace_id=workspace_id, sku_id=sku_id, warehouse_id=location.warehouse_id, location_id=location.id, on_hand=0, locked=0, damaged=0)
        session.add(balance)
    balance.on_hand += on_hand
    balance.locked += locked
    balance.damaged += damaged
    if balance.on_hand < 0 or balance.locked < 0 or balance.damaged < 0 or balance.locked > balance.on_hand:
        raise BusinessError(f"货位 {location.code} 库存不足，无法完成操作")
    session.add(InventoryMove(
        workspace_id=workspace_id, sku_id=sku_id, warehouse_id=location.warehouse_id, location_id=location.id, kind=kind,
        on_hand_delta=on_hand, locked_delta=locked, damaged_delta=damaged, on_hand_after=balance.on_hand, ref_no=ref_no, note=note, actor_id=actor_id,
    ))
    await session.flush()
    return balance


@dataclass(slots=True)
class OrderLine:
    sku: Sku
    quantity: int


async def _allocate(session: AsyncSession, workspace_id: str, lines: list[OrderLine]) -> tuple[Warehouse, list[tuple[OrderLine, Location, int]]]:
    """找到第一个能发齐整单的仓库，按货位编码顺序分配（不拆仓）。"""
    needed: dict[str, int] = defaultdict(int)
    for line in lines:
        needed[line.sku.id] += line.quantity
    warehouses = list(await session.scalars(select(Warehouse).where(Warehouse.workspace_id == workspace_id).order_by(Warehouse.code)))
    for warehouse in warehouses:
        rows = (await session.execute(
            select(InventoryBalance, Location)
            .join(Location, Location.id == InventoryBalance.location_id)
            .where(InventoryBalance.warehouse_id == warehouse.id, InventoryBalance.sku_id.in_(needed), Location.kind == "storage")
            .order_by(Location.code)
        )).all()
        available: dict[str, int] = defaultdict(int)
        for balance, _location in rows:
            available[balance.sku_id] += balance.on_hand - balance.locked
        if any(available[sku_id] < quantity for sku_id, quantity in needed.items()):
            continue
        remaining = {balance.id: balance.on_hand - balance.locked for balance, _location in rows}
        picks: list[tuple[OrderLine, Location, int]] = []
        for line in lines:
            left = line.quantity
            for balance, location in rows:
                if balance.sku_id != line.sku.id or left == 0:
                    continue
                take = min(left, remaining[balance.id])
                if take > 0:
                    picks.append((line, location, take))
                    remaining[balance.id] -= take
                    left -= take
        return warehouse, picks
    names = "、".join(line.sku.code for line in lines)
    raise BusinessError(f"库存不足，没有仓库能发齐这笔订单：{names}")


async def place_order(
    session: AsyncSession,
    *,
    workspace_id: str,
    shop: Shop,
    customer: Customer,
    lines: list[OrderLine],
    address: str = "",
    note: str = "",
    actor_id: str | None = None,
    free: bool = False,
) -> SalesOrder:
    """下单：锁定库存并生成出库单，二者在同一事务内完成。"""
    if not lines or any(line.quantity <= 0 for line in lines):
        raise BusinessError("订单至少要有一件商品")
    warehouse, picks = await _allocate(session, workspace_id, lines)
    order = SalesOrder(
        workspace_id=workspace_id, order_no=make_no("SO"), shop_id=shop.id, customer_id=customer.id, warehouse_id=warehouse.id, status="paid",
        total_cents=0 if free else sum(line.sku.price_cents * line.quantity for line in lines), address=address or customer.address, note=note,
    )
    order.items = [OrderItem(sku_id=line.sku.id, quantity=line.quantity, price_cents=0 if free else line.sku.price_cents) for line in lines]
    session.add(order)
    await session.flush()
    outbound = OutboundOrder(workspace_id=workspace_id, outbound_no=make_no("OB"), order_id=order.id, warehouse_id=warehouse.id, status="pending")
    outbound.lines = [OutboundLine(sku_id=line.sku.id, location_id=location.id, quantity=quantity) for line, location, quantity in picks]
    session.add(outbound)
    for line, location, quantity in picks:
        await apply_move(session, workspace_id=workspace_id, sku_id=line.sku.id, location=location, kind="lock", locked=quantity, ref_no=order.order_no, note="下单锁定", actor_id=actor_id)
    return order


async def outbound_for(session: AsyncSession, order_id: str) -> OutboundOrder | None:
    return await session.scalar(
        select(OutboundOrder).where(OutboundOrder.order_id == order_id).options(selectinload(OutboundOrder.lines).selectinload(OutboundLine.location)).order_by(OutboundOrder.created_at.desc()).limit(1)
    )


async def cancel_order(session: AsyncSession, order: SalesOrder, *, actor_id: str | None = None, note: str = "取消订单") -> None:
    if order.status not in {"paid", "picking"}:
        raise BusinessError("只有未发货的订单可以取消")
    outbound = await outbound_for(session, order.id)
    if outbound:
        for line in outbound.lines:
            await apply_move(session, workspace_id=order.workspace_id, sku_id=line.sku_id, location=line.location, kind="release", locked=-line.quantity, ref_no=order.order_no, note=note, actor_id=actor_id)
        outbound.status = "cancelled"
    order.status = "cancelled"
    await session.flush()


async def advance_outbound(session: AsyncSession, outbound: OutboundOrder, action: str, *, actor_id: str | None = None) -> None:
    """出库作业按 拣货 → 复核 → 发货 推进；每一步只能从上一步进入，重复点击不会重复扣库存。"""
    expected = {"pick": "pending", "check": "picked", "ship": "checked"}[action]
    if outbound.status != expected:
        raise BusinessError(f"出库单当前状态为 {outbound.status}，不能执行此操作")
    order = await session.get(SalesOrder, outbound.order_id)
    if order is None:
        raise BusinessError("关联订单不存在")
    if action == "pick":
        outbound.status = "picked"
        order.status = "picking"
    elif action == "check":
        outbound.status = "checked"
    else:
        for line in outbound.lines:
            await apply_move(session, workspace_id=order.workspace_id, sku_id=line.sku_id, location=line.location, kind="ship", on_hand=-line.quantity, locked=-line.quantity, ref_no=order.order_no, note="发货出库", actor_id=actor_id)
        carrier, prefix = random.choice(CARRIERS)
        session.add(Shipment(order_id=order.id, carrier=carrier, tracking_no=f"{prefix}{random.randint(10**11, 10**12 - 1)}", status="in_transit", events=[track_event("仓库已发货，快递已揽收")]))
        outbound.status = "shipped"
        order.status = "shipped"
        order.shipped_at = now()
    await session.flush()


async def deliver_order(session: AsyncSession, order: SalesOrder) -> None:
    if order.status != "shipped":
        raise BusinessError("只有已发货的订单可以签收")
    order.status = "delivered"
    order.delivered_at = now()
    shipment = await session.scalar(select(Shipment).where(Shipment.order_id == order.id))
    if shipment:
        shipment.status = "delivered"
        shipment.events = [*shipment.events, track_event("快件已由本人签收")]
    await session.flush()


async def create_after_sale(session: AsyncSession, *, order: SalesOrder, kind: str, reason: str, source: str) -> AfterSale:
    """金额由服务端按订单计算，不接受调用方（包括模型）传入。"""
    if kind not in AFTER_SALE_KIND_LABEL:
        raise BusinessError("不支持的售后类型")
    if order.status in {"cancelled", "refunded"}:
        raise BusinessError(f"订单{ORDER_STATUS_LABEL[order.status]}，不能申请售后")
    if kind in {"return", "exchange"} and order.status not in {"shipped", "delivered"}:
        raise BusinessError("订单还没有发货，退货或换货请改为取消订单或仅退款")
    existing = await session.scalar(select(AfterSale).where(AfterSale.order_id == order.id, AfterSale.status.in_(ACTIVE_AFTER_SALE)).limit(1))
    if existing:
        raise BusinessError(f"这笔订单已有处理中的售后单 {existing.after_sale_no}")
    record = AfterSale(
        workspace_id=order.workspace_id, after_sale_no=make_no("AS"), order_id=order.id, customer_id=order.customer_id, kind=kind, status="requested",
        reason=reason[:500], amount_cents=0 if kind == "exchange" else order.total_cents - order.refunded_cents, source=source,
    )
    session.add(record)
    await session.flush()
    return record


def _refund(order: SalesOrder, record: AfterSale) -> None:
    order.refunded_cents += record.amount_cents
    if order.refunded_cents >= order.total_cents:
        order.status = "refunded"


async def review_after_sale(session: AsyncSession, record: AfterSale, *, approve: bool, note: str = "", actor_id: str | None = None) -> None:
    if record.status != "requested":
        raise BusinessError("这张售后单已经审核过")
    record.result_note = note[:300]
    if not approve:
        record.status = "rejected"
        await session.flush()
        return
    if record.kind != "refund":
        record.status = "approved"
        await session.flush()
        return
    order = await session.get(SalesOrder, record.order_id)
    if order is None:
        raise BusinessError("关联订单不存在")
    if order.status in {"paid", "picking"}:
        await cancel_order(session, order, actor_id=actor_id, note=f"售后 {record.after_sale_no} 仅退款")
    _refund(order, record)
    record.status = "completed"
    await session.flush()


async def mark_returning(session: AsyncSession, record: AfterSale) -> None:
    if record.status != "approved":
        raise BusinessError("只有审核通过、待寄回的售后单可以标记寄回")
    record.status = "returning"
    await session.flush()


async def receive_return(session: AsyncSession, record: AfterSale, *, condition: str, actor_id: str | None = None) -> SalesOrder | None:
    """仓库收到退货：良品回到原货位可再售，残次品进残次区。换货时补发一单。"""
    if record.status != "returning":
        raise BusinessError("只有退回中的售后单可以收货")
    if condition not in {"good", "damaged"}:
        raise BusinessError("收货状态只能是良品或残次")
    order = await session.scalar(select(SalesOrder).where(SalesOrder.id == record.order_id).options(selectinload(SalesOrder.items).selectinload(OrderItem.sku)))
    outbound = await outbound_for(session, record.order_id)
    if order is None or outbound is None:
        raise BusinessError("找不到原出库记录，无法入库")
    damaged_area = await session.scalar(select(Location).where(Location.warehouse_id == outbound.warehouse_id, Location.kind == "damaged").limit(1))
    for line in outbound.lines:
        if condition == "good":
            await apply_move(session, workspace_id=order.workspace_id, sku_id=line.sku_id, location=line.location, kind="return_good", on_hand=line.quantity, ref_no=record.after_sale_no, note="退货良品入库", actor_id=actor_id)
        else:
            await apply_move(session, workspace_id=order.workspace_id, sku_id=line.sku_id, location=damaged_area or line.location, kind="return_damaged", damaged=line.quantity, ref_no=record.after_sale_no, note="退货残次入库", actor_id=actor_id)
    replacement = None
    if record.kind == "exchange":
        customer = await session.get(Customer, order.customer_id)
        shop = await session.get(Shop, order.shop_id)
        if customer is None or shop is None:
            raise BusinessError("订单资料不完整，无法补发")
        replacement = await place_order(
            session, workspace_id=order.workspace_id, shop=shop, customer=customer, lines=[OrderLine(item.sku, item.quantity) for item in order.items],
            address=order.address, note=f"换货补发（{record.after_sale_no}）", actor_id=actor_id, free=True,
        )
        record.result_note = f"已补发订单 {replacement.order_no}"
    else:
        _refund(order, record)
    record.status = "completed"
    await session.flush()
    return replacement


async def receive_inbound(session: AsyncSession, inbound: InboundOrder, received: dict[str, int]) -> None:
    if inbound.status != "pending":
        raise BusinessError("这张入库单已经收过货")
    for line in inbound.lines:
        quantity = received.get(line.id, line.expected)
        if quantity < 0:
            raise BusinessError("实收数量不能为负数")
        line.received = quantity
    inbound.status = "received"
    await session.flush()


async def putaway_inbound(session: AsyncSession, inbound: InboundOrder, locations: dict[str, Location], *, actor_id: str | None = None) -> None:
    if inbound.status != "received":
        raise BusinessError("请先完成到货确认，再上架")
    for line in inbound.lines:
        if line.received == 0:
            continue
        location = locations.get(line.id)
        if location is None:
            raise BusinessError("每个到货的 SKU 都要选择上架货位")
        if location.warehouse_id != inbound.warehouse_id:
            raise BusinessError("上架货位必须属于入库单的仓库")
        line.location_id = location.id
        await apply_move(session, workspace_id=inbound.workspace_id, sku_id=line.sku_id, location=location, kind="inbound", on_hand=line.received, ref_no=inbound.inbound_no, note=f"采购入库 {inbound.supplier}".strip(), actor_id=actor_id)
    inbound.status = "completed"
    await session.flush()
