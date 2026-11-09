from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ...commerce import service as biz
from ...commerce.assistant import CommerceToolset
from ...commerce.demo import seed_demo
from ...config import get_settings
from ...db import get_session
from ...fde import Manifest
from ...models import (
    AfterSale,
    AppVersion,
    AuditEvent,
    Conversation,
    Customer,
    InboundLine,
    InboundOrder,
    InventoryBalance,
    InventoryMove,
    Location,
    Message,
    ModelConfig,
    OrderItem,
    OutboundLine,
    OutboundOrder,
    Product,
    QAApp,
    SalesOrder,
    ServiceConfig,
    ServiceSession,
    Shipment,
    Shop,
    Sku,
    User,
    Warehouse,
)
from ...providers import build_gateway
from ...security import AuthContext, require_roles
from .fde import RunRequest, _app, _execute

router = APIRouter()
Session = Depends(get_session)
Anyone = Depends(require_roles("admin", "manager", "cs_agent", "warehouse"))
Service = Depends(require_roles("admin", "manager", "cs_agent"))
Storehouse = Depends(require_roles("admin", "manager", "warehouse"))
Manager = Depends(require_roles("admin", "manager"))


class SkuInput(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    spec: str = Field(default="", max_length=120)
    price: float = Field(ge=0, le=1_000_000)
    low_stock_threshold: int = Field(default=10, ge=0, le=1_000_000)


class ProductInput(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    category: str = Field(default="", max_length=80)
    description: str = Field(default="", max_length=4000)
    skus: list[SkuInput] = Field(min_length=1, max_length=50)


class ProductUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    category: str = Field(default="", max_length=80)
    is_active: bool = True


class SkuUpdate(BaseModel):
    spec: str = Field(default="", max_length=120)
    price: float = Field(ge=0, le=1_000_000)
    low_stock_threshold: int = Field(ge=0, le=1_000_000)


class OrderLineInput(BaseModel):
    sku_id: str
    quantity: int = Field(ge=1, le=10_000)


class OrderInput(BaseModel):
    shop_id: str
    customer_id: str
    items: list[OrderLineInput] = Field(min_length=1, max_length=50)
    note: str = Field(default="", max_length=300)


class AfterSaleInput(BaseModel):
    order_id: str
    kind: Literal["refund", "return", "exchange"]
    reason: str = Field(default="", max_length=500)


class ReviewInput(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=300)


class ReturnInput(BaseModel):
    condition: Literal["good", "damaged"]


class WarehouseInput(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=120)
    address: str = Field(default="", max_length=300)


class LocationInput(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    zone: str = Field(default="", max_length=32)
    kind: Literal["storage", "damaged"] = "storage"


class AdjustInput(BaseModel):
    sku_id: str
    location_id: str
    delta: int = Field(ge=-1_000_000, le=1_000_000)
    note: str = Field(min_length=1, max_length=300)


class InboundLineInput(BaseModel):
    sku_id: str
    expected: int = Field(ge=1, le=1_000_000)


class InboundInput(BaseModel):
    warehouse_id: str
    supplier: str = Field(default="", max_length=120)
    note: str = Field(default="", max_length=300)
    lines: list[InboundLineInput] = Field(min_length=1, max_length=100)


class ReceiveInput(BaseModel):
    received: dict[str, int] = Field(default_factory=dict)


class PutawayInput(BaseModel):
    locations: dict[str, str]


class ChatInput(BaseModel):
    customer_id: str
    message: str = Field(min_length=1, max_length=4000)


class ReplyInput(BaseModel):
    content: str = Field(min_length=1, max_length=4000)


ORDER_LOAD = (
    selectinload(SalesOrder.items).selectinload(OrderItem.sku).selectinload(Sku.product),
    selectinload(SalesOrder.shop),
    selectinload(SalesOrder.customer),
    selectinload(SalesOrder.shipment),
)


def _sku_label(sku: Sku) -> str:
    return f"{sku.product.name} {sku.spec}".strip()


def _order(order: SalesOrder) -> dict[str, Any]:
    shipment = order.shipment
    return {
        "id": order.id, "order_no": order.order_no, "status": order.status, "status_label": biz.ORDER_STATUS_LABEL.get(order.status, order.status),
        "total": biz.yuan(order.total_cents), "refunded": biz.yuan(order.refunded_cents), "address": order.address, "note": order.note,
        "shop": order.shop.name, "platform": order.shop.platform, "customer_id": order.customer_id, "customer": order.customer.name, "customer_level": order.customer.level,
        "created_at": order.created_at, "shipped_at": order.shipped_at, "delivered_at": order.delivered_at,
        "items": [{"sku_id": item.sku_id, "code": item.sku.code, "name": _sku_label(item.sku), "quantity": item.quantity, "price": biz.yuan(item.price_cents)} for item in order.items],
        "shipment": {"carrier": shipment.carrier, "tracking_no": shipment.tracking_no, "status": shipment.status, "events": shipment.events} if shipment else None,
    }


async def _one(session: AsyncSession, model: Any, item_id: str, workspace_id: str, label: str, *options: Any) -> Any:
    item = await session.scalar(select(model).where(model.id == item_id, model.workspace_id == workspace_id).options(*options))
    if item is None:
        raise HTTPException(status_code=404, detail=f"{label}不存在")
    return item


async def _location(session: AsyncSession, location_id: str, workspace_id: str) -> Location:
    location = await session.scalar(select(Location).join(Warehouse, Warehouse.id == Location.warehouse_id).where(Location.id == location_id, Warehouse.workspace_id == workspace_id))
    if location is None:
        raise HTTPException(status_code=404, detail="货位不存在")
    return location


async def _finish(session: AsyncSession, operation: Any) -> Any:
    """把业务规则错误转成 409，失败时整笔回滚，不留下半截的库存变动。"""
    try:
        result = await operation
    except biz.BusinessError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await session.commit()
    return result


def _audit(session: AsyncSession, context: AuthContext, action: str, resource_type: str, resource_id: str, detail: dict[str, Any]) -> None:
    session.add(AuditEvent(workspace_id=context.workspace_id, actor_id=context.user_id, action=action, resource_type=resource_type, resource_id=resource_id, detail=detail))


# ---------- 总览 ----------


@router.get("/overview")
async def overview(context: AuthContext = Anyone, session: AsyncSession = Session) -> dict[str, Any]:
    ws = context.workspace_id
    today = biz.now().replace(hour=0, minute=0, second=0, microsecond=0)
    month_ago = biz.now() - timedelta(days=30)
    has_data = bool(await session.scalar(select(func.count(Warehouse.id)).where(Warehouse.workspace_id == ws)))
    orders_today, gmv_today = (await session.execute(select(func.count(SalesOrder.id), func.coalesce(func.sum(SalesOrder.total_cents), 0)).where(SalesOrder.workspace_id == ws, SalesOrder.created_at >= today, SalesOrder.status != "cancelled"))).one()
    to_ship = await session.scalar(select(func.count(SalesOrder.id)).where(SalesOrder.workspace_id == ws, SalesOrder.status.in_(("paid", "picking")))) or 0
    after_sales = await session.scalar(select(func.count(AfterSale.id)).where(AfterSale.workspace_id == ws, AfterSale.status.in_(biz.ACTIVE_AFTER_SALE))) or 0
    queued = await session.scalar(select(func.count(ServiceSession.id)).where(ServiceSession.workspace_id == ws, ServiceSession.status == "queued")) or 0
    sessions = await session.scalar(select(func.count(ServiceSession.id)).where(ServiceSession.workspace_id == ws)) or 0
    handed = await session.scalar(select(func.count(ServiceSession.id)).where(ServiceSession.workspace_id == ws, ServiceSession.was_handed_off.is_(True))) or 0
    shipped_rows = (await session.execute(select(SalesOrder.created_at, SalesOrder.shipped_at).where(SalesOrder.workspace_id == ws, SalesOrder.shipped_at.is_not(None), SalesOrder.created_at >= month_ago))).all()
    ship_hours = [(row.shipped_at - row.created_at).total_seconds() / 3600 for row in shipped_rows]
    shipped_units = -(await session.scalar(select(func.coalesce(func.sum(InventoryMove.on_hand_delta), 0)).where(InventoryMove.workspace_id == ws, InventoryMove.kind == "ship", InventoryMove.created_at >= month_ago)) or 0)
    on_hand_total = await session.scalar(select(func.coalesce(func.sum(InventoryBalance.on_hand), 0)).where(InventoryBalance.workspace_id == ws)) or 0
    rows = await _inventory_rows(session, ws)
    low = [item for item in rows if item["low"]]
    status_rows = (await session.execute(select(SalesOrder.status, func.count(SalesOrder.id)).where(SalesOrder.workspace_id == ws).group_by(SalesOrder.status))).all()
    return {
        "has_data": has_data,
        "orders_today": orders_today, "gmv_today": biz.yuan(int(gmv_today)), "to_ship": to_ship, "after_sales": after_sales, "queued": queued,
        "ai_resolved_rate": round((sessions - handed) / sessions, 4) if sessions else None,
        "handoff_rate": round(handed / sessions, 4) if sessions else None,
        "avg_ship_hours": round(sum(ship_hours) / len(ship_hours), 1) if ship_hours else None,
        "stock_turnover": round(shipped_units / on_hand_total, 3) if on_hand_total else None,
        "low_stock": low[:6], "low_stock_count": len(low),
        "order_status": [{"status": status, "label": biz.ORDER_STATUS_LABEL.get(status, status), "count": count} for status, count in status_rows],
    }


@router.post("/demo/seed", status_code=201)
async def demo_seed(context: AuthContext = Depends(require_roles("admin")), session: AsyncSession = Session) -> dict[str, Any]:
    if get_settings().env == "production":
        raise HTTPException(status_code=403, detail="生产环境不能写入演示数据")
    if await session.scalar(select(func.count(Warehouse.id)).where(Warehouse.workspace_id == context.workspace_id)):
        raise HTTPException(status_code=409, detail="当前业务空间已有业务数据")
    result = await _finish(session, seed_demo(session, context.workspace_id, context.user_id))
    return result


# ---------- 基础资料 ----------


@router.get("/shops")
async def shops(context: AuthContext = Anyone, session: AsyncSession = Session) -> list[dict[str, Any]]:
    return [{"id": item.id, "name": item.name, "platform": item.platform} for item in await session.scalars(select(Shop).where(Shop.workspace_id == context.workspace_id).order_by(Shop.created_at))]


@router.get("/customers")
async def customers(context: AuthContext = Anyone, session: AsyncSession = Session) -> list[dict[str, Any]]:
    return [{"id": item.id, "name": item.name, "phone": item.phone, "level": item.level, "address": item.address} for item in await session.scalars(select(Customer).where(Customer.workspace_id == context.workspace_id).order_by(Customer.created_at))]


def _product(product: Product) -> dict[str, Any]:
    return {
        "id": product.id, "name": product.name, "category": product.category, "description": product.description, "is_active": product.is_active,
        "skus": [{"id": sku.id, "code": sku.code, "spec": sku.spec, "price": biz.yuan(sku.price_cents), "low_stock_threshold": sku.low_stock_threshold} for sku in product.skus],
    }


@router.get("/products")
async def products(q: str = "", context: AuthContext = Anyone, session: AsyncSession = Session) -> list[dict[str, Any]]:
    query = select(Product).where(Product.workspace_id == context.workspace_id).options(selectinload(Product.skus)).order_by(Product.created_at)
    if q.strip():
        query = query.where(Product.name.like(f"%{q.strip()}%"))
    return [_product(item) for item in await session.scalars(query)]


@router.post("/products", status_code=201)
async def create_product(payload: ProductInput, context: AuthContext = Manager, session: AsyncSession = Session) -> dict[str, Any]:
    codes = [item.code for item in payload.skus]
    if len(set(codes)) != len(codes):
        raise HTTPException(status_code=422, detail="SKU 编码不能重复")
    if await session.scalar(select(Sku.id).where(Sku.workspace_id == context.workspace_id, Sku.code.in_(codes)).limit(1)):
        raise HTTPException(status_code=409, detail="SKU 编码已存在")
    product = Product(workspace_id=context.workspace_id, name=payload.name, category=payload.category, description=payload.description)
    product.skus = [Sku(workspace_id=context.workspace_id, code=item.code, spec=item.spec, price_cents=round(item.price * 100), low_stock_threshold=item.low_stock_threshold) for item in payload.skus]
    session.add(product)
    await session.commit()
    return _product(await _one(session, Product, product.id, context.workspace_id, "商品", selectinload(Product.skus)))


@router.patch("/products/{product_id}")
async def update_product(product_id: str, payload: ProductUpdate, context: AuthContext = Manager, session: AsyncSession = Session) -> dict[str, Any]:
    product = await _one(session, Product, product_id, context.workspace_id, "商品", selectinload(Product.skus))
    product.name, product.category, product.is_active = payload.name, payload.category, payload.is_active
    await session.commit()
    return _product(product)


@router.patch("/skus/{sku_id}")
async def update_sku(sku_id: str, payload: SkuUpdate, context: AuthContext = Manager, session: AsyncSession = Session) -> dict[str, Any]:
    sku = await _one(session, Sku, sku_id, context.workspace_id, "SKU")
    sku.spec, sku.price_cents, sku.low_stock_threshold = payload.spec, round(payload.price * 100), payload.low_stock_threshold
    await session.commit()
    return {"id": sku.id, "code": sku.code, "spec": sku.spec, "price": biz.yuan(sku.price_cents), "low_stock_threshold": sku.low_stock_threshold}


# ---------- 订单 ----------


@router.get("/orders")
async def orders(status: str = "", q: str = "", context: AuthContext = Anyone, session: AsyncSession = Session) -> list[dict[str, Any]]:
    query = select(SalesOrder).join(Customer, Customer.id == SalesOrder.customer_id).where(SalesOrder.workspace_id == context.workspace_id).options(*ORDER_LOAD).order_by(SalesOrder.created_at.desc()).limit(200)
    if status:
        query = query.where(SalesOrder.status == status)
    if q.strip():
        query = query.where(or_(SalesOrder.order_no.like(f"%{q.strip()}%"), Customer.name.like(f"%{q.strip()}%")))
    return [_order(item) for item in await session.scalars(query)]


@router.post("/orders", status_code=201)
async def create_order(payload: OrderInput, context: AuthContext = Service, session: AsyncSession = Session) -> dict[str, Any]:
    shop = await _one(session, Shop, payload.shop_id, context.workspace_id, "店铺")
    customer = await _one(session, Customer, payload.customer_id, context.workspace_id, "买家")
    lines = [biz.OrderLine(await _one(session, Sku, item.sku_id, context.workspace_id, "SKU"), item.quantity) for item in payload.items]
    order = await _finish(session, biz.place_order(session, workspace_id=context.workspace_id, shop=shop, customer=customer, lines=lines, note=payload.note, actor_id=context.user_id))
    return _order(await _one(session, SalesOrder, order.id, context.workspace_id, "订单", *ORDER_LOAD))


@router.post("/orders/{order_id}/cancel")
async def cancel_order(order_id: str, context: AuthContext = Service, session: AsyncSession = Session) -> dict[str, Any]:
    order = await _one(session, SalesOrder, order_id, context.workspace_id, "订单")
    await _finish(session, biz.cancel_order(session, order, actor_id=context.user_id))
    return {"ok": True, "status": "cancelled"}


@router.post("/orders/{order_id}/deliver")
async def deliver(order_id: str, context: AuthContext = Anyone, session: AsyncSession = Session) -> dict[str, Any]:
    order = await _one(session, SalesOrder, order_id, context.workspace_id, "订单")
    await _finish(session, biz.deliver_order(session, order))
    return {"ok": True, "status": "delivered"}


# ---------- 售后 ----------


AFTER_SALE_LOAD = (selectinload(AfterSale.order), selectinload(AfterSale.customer))


def _after_sale(record: AfterSale) -> dict[str, Any]:
    return {
        "id": record.id, "after_sale_no": record.after_sale_no, "order_id": record.order_id, "order_no": record.order.order_no, "customer": record.customer.name,
        "kind": record.kind, "kind_label": biz.AFTER_SALE_KIND_LABEL[record.kind], "status": record.status, "status_label": biz.AFTER_SALE_STATUS_LABEL[record.status],
        "reason": record.reason, "amount": biz.yuan(record.amount_cents), "source": record.source, "result_note": record.result_note, "created_at": record.created_at,
    }


@router.get("/after-sales")
async def after_sales(status: str = "", context: AuthContext = Anyone, session: AsyncSession = Session) -> list[dict[str, Any]]:
    query = select(AfterSale).where(AfterSale.workspace_id == context.workspace_id).options(*AFTER_SALE_LOAD).order_by(AfterSale.created_at.desc()).limit(200)
    if status:
        query = query.where(AfterSale.status == status)
    return [_after_sale(item) for item in await session.scalars(query)]


@router.post("/after-sales", status_code=201)
async def create_after_sale(payload: AfterSaleInput, context: AuthContext = Service, session: AsyncSession = Session) -> dict[str, Any]:
    order = await _one(session, SalesOrder, payload.order_id, context.workspace_id, "订单")
    record = await _finish(session, biz.create_after_sale(session, order=order, kind=payload.kind, reason=payload.reason, source="agent"))
    return _after_sale(await _one(session, AfterSale, record.id, context.workspace_id, "售后单", *AFTER_SALE_LOAD))


async def _after_sale_done(session: AsyncSession, context: AuthContext, record_id: str) -> dict[str, Any]:
    return _after_sale(await session.scalar(select(AfterSale).where(AfterSale.id == record_id, AfterSale.workspace_id == context.workspace_id).options(*AFTER_SALE_LOAD).execution_options(populate_existing=True)))


@router.post("/after-sales/{record_id}/review")
async def review_after_sale(record_id: str, payload: ReviewInput, context: AuthContext = Service, session: AsyncSession = Session) -> dict[str, Any]:
    record = await _one(session, AfterSale, record_id, context.workspace_id, "售后单")
    _audit(session, context, "after_sale.reviewed", "after_sale", record.id, {"approve": payload.approve, "amount_cents": record.amount_cents})
    await _finish(session, biz.review_after_sale(session, record, approve=payload.approve, note=payload.note, actor_id=context.user_id))
    return await _after_sale_done(session, context, record_id)


@router.post("/after-sales/{record_id}/returning")
async def mark_returning(record_id: str, context: AuthContext = Service, session: AsyncSession = Session) -> dict[str, Any]:
    record = await _one(session, AfterSale, record_id, context.workspace_id, "售后单")
    await _finish(session, biz.mark_returning(session, record))
    return await _after_sale_done(session, context, record_id)


@router.post("/after-sales/{record_id}/receive")
async def receive_return(record_id: str, payload: ReturnInput, context: AuthContext = Storehouse, session: AsyncSession = Session) -> dict[str, Any]:
    record = await _one(session, AfterSale, record_id, context.workspace_id, "售后单")
    _audit(session, context, "after_sale.received", "after_sale", record.id, {"condition": payload.condition})
    await _finish(session, biz.receive_return(session, record, condition=payload.condition, actor_id=context.user_id))
    return await _after_sale_done(session, context, record_id)


# ---------- 仓库与库存 ----------


def _warehouse(item: Warehouse) -> dict[str, Any]:
    return {"id": item.id, "code": item.code, "name": item.name, "address": item.address, "locations": [{"id": place.id, "code": place.code, "zone": place.zone, "kind": place.kind} for place in sorted(item.locations, key=lambda place: place.code)]}


@router.get("/warehouses")
async def warehouses(context: AuthContext = Anyone, session: AsyncSession = Session) -> list[dict[str, Any]]:
    return [_warehouse(item) for item in await session.scalars(select(Warehouse).where(Warehouse.workspace_id == context.workspace_id).options(selectinload(Warehouse.locations)).order_by(Warehouse.code))]


@router.post("/warehouses", status_code=201)
async def create_warehouse(payload: WarehouseInput, context: AuthContext = Storehouse, session: AsyncSession = Session) -> dict[str, Any]:
    warehouse = Warehouse(workspace_id=context.workspace_id, code=payload.code, name=payload.name, address=payload.address)
    warehouse.locations = [Location(code="DMG-01", zone="残次区", kind="damaged")]
    session.add(warehouse)
    await session.commit()
    return _warehouse(await _one(session, Warehouse, warehouse.id, context.workspace_id, "仓库", selectinload(Warehouse.locations)))


@router.post("/warehouses/{warehouse_id}/locations", status_code=201)
async def create_location(warehouse_id: str, payload: LocationInput, context: AuthContext = Storehouse, session: AsyncSession = Session) -> dict[str, Any]:
    warehouse = await _one(session, Warehouse, warehouse_id, context.workspace_id, "仓库")
    if await session.scalar(select(Location.id).where(Location.warehouse_id == warehouse.id, Location.code == payload.code)):
        raise HTTPException(status_code=409, detail="货位编码已存在")
    location = Location(warehouse_id=warehouse.id, code=payload.code, zone=payload.zone, kind=payload.kind)
    session.add(location)
    await session.commit()
    return {"id": location.id, "code": location.code, "zone": location.zone, "kind": location.kind}


async def _inventory_rows(session: AsyncSession, workspace_id: str, q: str = "", warehouse_id: str = "") -> list[dict[str, Any]]:
    skus_query = select(Sku).join(Product, Product.id == Sku.product_id).where(Sku.workspace_id == workspace_id).options(selectinload(Sku.product)).order_by(Sku.code)
    if q.strip():
        skus_query = skus_query.where(or_(Sku.code.like(f"%{q.strip()}%"), Product.name.like(f"%{q.strip()}%")))
    skus_list = list(await session.scalars(skus_query))
    balance_query = select(InventoryBalance, Location, Warehouse).join(Location, Location.id == InventoryBalance.location_id).join(Warehouse, Warehouse.id == InventoryBalance.warehouse_id).where(InventoryBalance.workspace_id == workspace_id).order_by(Location.code)
    if warehouse_id:
        balance_query = balance_query.where(InventoryBalance.warehouse_id == warehouse_id)
    by_sku: dict[str, list[Any]] = defaultdict(list)
    for balance, location, warehouse in (await session.execute(balance_query)).all():
        by_sku[balance.sku_id].append((balance, location, warehouse))
    rows = []
    for sku in skus_list:
        details = by_sku.get(sku.id, [])
        on_hand = sum(item[0].on_hand for item in details)
        locked = sum(item[0].locked for item in details)
        available = on_hand - locked
        rows.append({
            "sku_id": sku.id, "code": sku.code, "name": _sku_label(sku), "on_hand": on_hand, "locked": locked, "available": available,
            "damaged": sum(item[0].damaged for item in details), "threshold": sku.low_stock_threshold, "low": available <= sku.low_stock_threshold,
            "locations": [{"location_id": item[1].id, "location": item[1].code, "kind": item[1].kind, "warehouse": item[2].name, "on_hand": item[0].on_hand, "locked": item[0].locked, "damaged": item[0].damaged} for item in details],
        })
    return rows


@router.get("/inventory")
async def inventory(q: str = "", warehouse_id: str = "", low_only: bool = False, context: AuthContext = Anyone, session: AsyncSession = Session) -> list[dict[str, Any]]:
    rows = await _inventory_rows(session, context.workspace_id, q, warehouse_id)
    return [item for item in rows if item["low"]] if low_only else rows


MOVE_LABEL = {"inbound": "采购入库", "lock": "下单锁定", "release": "取消释放", "ship": "发货出库", "return_good": "退货良品", "return_damaged": "退货残次", "adjust": "库存调整"}


@router.get("/inventory/moves")
async def inventory_moves(sku_id: str = "", limit: int = Query(default=100, ge=1, le=500), context: AuthContext = Anyone, session: AsyncSession = Session) -> list[dict[str, Any]]:
    query = (
        select(InventoryMove, Sku, Location).join(Sku, Sku.id == InventoryMove.sku_id).join(Location, Location.id == InventoryMove.location_id)
        .where(InventoryMove.workspace_id == context.workspace_id).options(selectinload(Sku.product)).order_by(InventoryMove.created_at.desc()).limit(limit)
    )
    if sku_id:
        query = query.where(InventoryMove.sku_id == sku_id)
    return [
        {"id": move.id, "code": sku.code, "name": _sku_label(sku), "location": location.code, "kind": move.kind, "kind_label": MOVE_LABEL.get(move.kind, move.kind), "on_hand_delta": move.on_hand_delta, "locked_delta": move.locked_delta, "damaged_delta": move.damaged_delta, "on_hand_after": move.on_hand_after, "ref_no": move.ref_no, "note": move.note, "created_at": move.created_at}
        for move, sku, location in (await session.execute(query)).all()
    ]


@router.post("/inventory/adjust")
async def adjust_inventory(payload: AdjustInput, context: AuthContext = Storehouse, session: AsyncSession = Session) -> dict[str, Any]:
    await _one(session, Sku, payload.sku_id, context.workspace_id, "SKU")
    location = await _location(session, payload.location_id, context.workspace_id)
    _audit(session, context, "inventory.adjusted", "sku", payload.sku_id, {"location": location.code, "delta": payload.delta, "note": payload.note})
    balance = await _finish(session, biz.apply_move(session, workspace_id=context.workspace_id, sku_id=payload.sku_id, location=location, kind="adjust", on_hand=payload.delta, ref_no="ADJ", note=payload.note, actor_id=context.user_id))
    return {"on_hand": balance.on_hand, "locked": balance.locked}


# ---------- 入库 ----------


INBOUND_LOAD = (selectinload(InboundOrder.warehouse), selectinload(InboundOrder.lines).selectinload(InboundLine.sku).selectinload(Sku.product), selectinload(InboundOrder.lines).selectinload(InboundLine.location))


def _inbound(item: InboundOrder) -> dict[str, Any]:
    return {
        "id": item.id, "inbound_no": item.inbound_no, "warehouse_id": item.warehouse_id, "warehouse": item.warehouse.name, "supplier": item.supplier, "status": item.status, "note": item.note, "created_at": item.created_at,
        "lines": [{"id": line.id, "code": line.sku.code, "name": _sku_label(line.sku), "expected": line.expected, "received": line.received, "location": line.location.code if line.location else None} for line in item.lines],
    }


async def _inbound_done(session: AsyncSession, context: AuthContext, inbound_id: str) -> dict[str, Any]:
    return _inbound(await session.scalar(select(InboundOrder).where(InboundOrder.id == inbound_id, InboundOrder.workspace_id == context.workspace_id).options(*INBOUND_LOAD).execution_options(populate_existing=True)))


@router.get("/inbound")
async def inbound_orders(context: AuthContext = Anyone, session: AsyncSession = Session) -> list[dict[str, Any]]:
    return [_inbound(item) for item in await session.scalars(select(InboundOrder).where(InboundOrder.workspace_id == context.workspace_id).options(*INBOUND_LOAD).order_by(InboundOrder.created_at.desc()).limit(200))]


@router.post("/inbound", status_code=201)
async def create_inbound(payload: InboundInput, context: AuthContext = Storehouse, session: AsyncSession = Session) -> dict[str, Any]:
    await _one(session, Warehouse, payload.warehouse_id, context.workspace_id, "仓库")
    for line in payload.lines:
        await _one(session, Sku, line.sku_id, context.workspace_id, "SKU")
    inbound = InboundOrder(workspace_id=context.workspace_id, inbound_no=biz.make_no("IB"), warehouse_id=payload.warehouse_id, supplier=payload.supplier, note=payload.note)
    inbound.lines = [InboundLine(sku_id=line.sku_id, expected=line.expected) for line in payload.lines]
    session.add(inbound)
    await session.commit()
    return await _inbound_done(session, context, inbound.id)


@router.post("/inbound/{inbound_id}/receive")
async def receive_inbound(inbound_id: str, payload: ReceiveInput, context: AuthContext = Storehouse, session: AsyncSession = Session) -> dict[str, Any]:
    inbound = await _one(session, InboundOrder, inbound_id, context.workspace_id, "入库单", selectinload(InboundOrder.lines))
    await _finish(session, biz.receive_inbound(session, inbound, payload.received))
    return await _inbound_done(session, context, inbound_id)


@router.post("/inbound/{inbound_id}/putaway")
async def putaway_inbound(inbound_id: str, payload: PutawayInput, context: AuthContext = Storehouse, session: AsyncSession = Session) -> dict[str, Any]:
    inbound = await _one(session, InboundOrder, inbound_id, context.workspace_id, "入库单", selectinload(InboundOrder.lines))
    locations = {line_id: await _location(session, location_id, context.workspace_id) for line_id, location_id in payload.locations.items()}
    await _finish(session, biz.putaway_inbound(session, inbound, locations, actor_id=context.user_id))
    return await _inbound_done(session, context, inbound_id)


# ---------- 出库 ----------


OUTBOUND_LOAD = (selectinload(OutboundOrder.warehouse), selectinload(OutboundOrder.order).selectinload(SalesOrder.customer), selectinload(OutboundOrder.lines).selectinload(OutboundLine.sku).selectinload(Sku.product), selectinload(OutboundOrder.lines).selectinload(OutboundLine.location))


def _outbound(item: OutboundOrder) -> dict[str, Any]:
    return {
        "id": item.id, "outbound_no": item.outbound_no, "order_no": item.order.order_no, "customer": item.order.customer.name, "warehouse": item.warehouse.name, "status": item.status, "created_at": item.created_at,
        "lines": [{"code": line.sku.code, "name": _sku_label(line.sku), "location": line.location.code, "quantity": line.quantity} for line in item.lines],
    }


@router.get("/outbound")
async def outbound_orders(status: str = "", context: AuthContext = Anyone, session: AsyncSession = Session) -> list[dict[str, Any]]:
    query = select(OutboundOrder).where(OutboundOrder.workspace_id == context.workspace_id).options(*OUTBOUND_LOAD).order_by(OutboundOrder.created_at.desc()).limit(200)
    if status:
        query = query.where(OutboundOrder.status == status)
    return [_outbound(item) for item in await session.scalars(query)]


@router.post("/outbound/{outbound_id}/{action}")
async def advance_outbound(outbound_id: str, action: Literal["pick", "check", "ship"], context: AuthContext = Storehouse, session: AsyncSession = Session) -> dict[str, Any]:
    outbound = await _one(session, OutboundOrder, outbound_id, context.workspace_id, "出库单", *OUTBOUND_LOAD)
    await _finish(session, biz.advance_outbound(session, outbound, action, actor_id=context.user_id))
    return _outbound(outbound)


# ---------- 客服 ----------


def _session_summary(item: ServiceSession, last: Message | None) -> dict[str, Any]:
    return {
        "id": item.id, "customer_id": item.customer_id, "customer": item.customer.name, "level": item.customer.level, "status": item.status, "assignee": item.assignee_name, "handoff_reason": item.handoff_reason,
        "summary": item.summary, "was_handed_off": item.was_handed_off, "queued_at": item.queued_at, "accepted_at": item.accepted_at, "updated_at": item.updated_at,
        "last_message": last.content[:80] if last else "",
    }


async def _messages(session: AsyncSession, conversation_id: str) -> list[Message]:
    return list(await session.scalars(select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at)))


def _message(item: Message) -> dict[str, Any]:
    return {"id": item.id, "role": item.role, "content": item.content, "citations": item.citations, "simulated": item.simulated, "created_at": item.created_at}


def _session_detail(item: ServiceSession, messages: list[Message]) -> dict[str, Any]:
    return {**_session_summary(item, messages[-1] if messages else None), "messages": [_message(message) for message in messages]}


async def _service_session(session: AsyncSession, session_id: str, workspace_id: str) -> ServiceSession:
    return await _one(session, ServiceSession, session_id, workspace_id, "会话", selectinload(ServiceSession.customer))


async def _configured_app(session: AsyncSession, workspace_id: str) -> QAApp | None:
    config = await session.get(ServiceConfig, workspace_id)
    if config is None:
        return None
    app = await session.get(QAApp, config.app_id)
    return app if app and app.is_enabled and app.published_version_id else None


@router.get("/service/status")
async def service_status(context: AuthContext = Anyone, session: AsyncSession = Session) -> dict[str, Any]:
    app = await _configured_app(session, context.workspace_id)
    if app is None:
        return {"app": None, "simulated": True}
    version = await session.get(AppVersion, app.published_version_id)
    model = await session.get(ModelConfig, Manifest.model_validate(version.manifest).llm_model_id) if version else None
    return {"app": {"id": app.id, "name": app.name}, "simulated": bool(build_gateway(model).is_simulated) if model else True, "model": model.display_name if model else None}


@router.get("/service/customers/{customer_id}/session")
async def customer_session(customer_id: str, context: AuthContext = Service, session: AsyncSession = Session) -> dict[str, Any] | None:
    await _one(session, Customer, customer_id, context.workspace_id, "买家")
    record = await session.scalar(select(ServiceSession).where(ServiceSession.workspace_id == context.workspace_id, ServiceSession.customer_id == customer_id, ServiceSession.status != "closed").options(selectinload(ServiceSession.customer)).order_by(ServiceSession.created_at.desc()).limit(1))
    return _session_detail(record, await _messages(session, record.conversation_id)) if record else None


async def _hand_off(session: AsyncSession, record: ServiceSession, customer: Customer, question: str, reason: str) -> None:
    orders = list(await session.scalars(select(SalesOrder.order_no).where(SalesOrder.customer_id == customer.id).order_by(SalesOrder.created_at.desc()).limit(3)))
    record.status = "queued"
    record.was_handed_off = True
    record.handoff_reason = (reason or question)[:500]
    record.queued_at = biz.now()
    record.summary = f"买家：{customer.name}（{customer.level}）\n诉求：{question[:200]}\n转接原因：{record.handoff_reason}\n最近订单：{'、'.join(orders) or '无'}"


@router.post("/service/chat")
async def buyer_chat(payload: ChatInput, context: AuthContext = Service, session: AsyncSession = Session) -> dict[str, Any]:
    """买家发消息。人工接待期间消息只转给坐席，机器人不再回复。"""
    customer = await _one(session, Customer, payload.customer_id, context.workspace_id, "买家")
    record = await session.scalar(select(ServiceSession).where(ServiceSession.workspace_id == context.workspace_id, ServiceSession.customer_id == customer.id, ServiceSession.status != "closed").options(selectinload(ServiceSession.customer)).order_by(ServiceSession.created_at.desc()).limit(1))
    if record and record.status in {"queued", "serving"}:
        session.add(Message(conversation_id=record.conversation_id, role="user", content=payload.message))
        record.updated_at = biz.now()
        await session.commit()
        return _session_detail(record, await _messages(session, record.conversation_id))

    config_app = await _configured_app(session, context.workspace_id)
    if config_app is None:
        raise HTTPException(status_code=409, detail="还没有可用的客服应用，请先在业务总览载入演示数据")
    app = await _app(session, config_app.id, context.workspace_id)
    version = await session.get(AppVersion, app.published_version_id)
    if version is None:
        raise HTTPException(status_code=409, detail="客服应用的发布版本不可用")
    if record is None:
        conversation = Conversation(workspace_id=context.workspace_id, app_id=app.id, title=f"{customer.name} 的咨询")
        session.add(conversation)
        await session.flush()
        record = ServiceSession(workspace_id=context.workspace_id, customer_id=customer.id, conversation_id=conversation.id)
        record.customer = customer
        session.add(record)
        await session.commit()
    toolset = CommerceToolset(session, context.workspace_id, customer)
    run = RunRequest(message=payload.message, conversation_id=record.conversation_id)
    result = await _execute(app, Manifest.model_validate(version.manifest), version.id, run, context, session, channel="service", business_tools=toolset)
    if result["handoff"]:
        await _hand_off(session, record, customer, payload.message, result.get("handoff_reason", ""))
    record.updated_at = biz.now()
    await session.commit()
    return _session_detail(record, await _messages(session, record.conversation_id))


@router.get("/service/sessions")
async def service_sessions(status: str = "", context: AuthContext = Service, session: AsyncSession = Session) -> list[dict[str, Any]]:
    query = select(ServiceSession).where(ServiceSession.workspace_id == context.workspace_id).options(selectinload(ServiceSession.customer)).order_by(ServiceSession.updated_at.desc()).limit(100)
    if status:
        query = query.where(ServiceSession.status.in_(status.split(",")))
    records = list(await session.scalars(query))
    result = []
    for item in records:
        last = await session.scalar(select(Message).where(Message.conversation_id == item.conversation_id).order_by(Message.created_at.desc()).limit(1))
        result.append(_session_summary(item, last))
    return result


@router.get("/service/sessions/{session_id}")
async def service_session(session_id: str, context: AuthContext = Service, session: AsyncSession = Session) -> dict[str, Any]:
    record = await _service_session(session, session_id, context.workspace_id)
    orders_list = list(await session.scalars(select(SalesOrder).where(SalesOrder.customer_id == record.customer_id).options(*ORDER_LOAD).order_by(SalesOrder.created_at.desc()).limit(5)))
    return {**_session_detail(record, await _messages(session, record.conversation_id)), "orders": [_order(item) for item in orders_list]}


async def _detail_after(session: AsyncSession, record: ServiceSession) -> dict[str, Any]:
    await session.commit()
    return _session_detail(record, await _messages(session, record.conversation_id))


@router.post("/service/sessions/{session_id}/accept")
async def accept_session(session_id: str, context: AuthContext = Service, session: AsyncSession = Session) -> dict[str, Any]:
    record = await _service_session(session, session_id, context.workspace_id)
    if record.status != "queued":
        raise HTTPException(status_code=409, detail="这个会话已被接入或已结束")
    user = await session.get(User, context.user_id) if context.user_id else None
    record.status, record.assignee_id, record.assignee_name, record.accepted_at = "serving", context.user_id, user.display_name if user else "人工客服", biz.now()
    session.add(Message(conversation_id=record.conversation_id, role="system", content=f"人工客服 {record.assignee_name} 已接入"))
    return await _detail_after(session, record)


@router.post("/service/sessions/{session_id}/reply")
async def reply_session(session_id: str, payload: ReplyInput, context: AuthContext = Service, session: AsyncSession = Session) -> dict[str, Any]:
    record = await _service_session(session, session_id, context.workspace_id)
    if record.status != "serving":
        raise HTTPException(status_code=409, detail="请先接入会话")
    session.add(Message(conversation_id=record.conversation_id, role="agent", content=payload.content))
    record.updated_at = biz.now()
    return await _detail_after(session, record)


@router.post("/service/sessions/{session_id}/release")
async def release_session(session_id: str, context: AuthContext = Service, session: AsyncSession = Session) -> dict[str, Any]:
    record = await _service_session(session, session_id, context.workspace_id)
    if record.status != "serving":
        raise HTTPException(status_code=409, detail="只有接待中的会话可以交还机器人")
    record.status, record.assignee_id, record.assignee_name = "ai", None, ""
    session.add(Message(conversation_id=record.conversation_id, role="system", content="已交还智能客服继续接待"))
    return await _detail_after(session, record)


@router.post("/service/sessions/{session_id}/close")
async def close_session(session_id: str, context: AuthContext = Service, session: AsyncSession = Session) -> dict[str, Any]:
    record = await _service_session(session, session_id, context.workspace_id)
    if record.status == "closed":
        raise HTTPException(status_code=409, detail="会话已结束")
    record.status, record.closed_at = "closed", biz.now()
    session.add(Message(conversation_id=record.conversation_id, role="system", content="会话已结束"))
    return await _detail_after(session, record)
