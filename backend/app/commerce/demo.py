"""一键写入演示业务数据：商品、库存、历史订单、售后、入库单、会话和客服 Agent。"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..fde import Manifest
from ..fde.manifest import AgentSettings, Guardrails, Tool
from ..models import (
    AppVersion,
    Conversation,
    Customer,
    DocumentChunk,
    InboundLine,
    InboundOrder,
    KnowledgeBase,
    KnowledgeFile,
    Location,
    Membership,
    Message,
    ModelConfig,
    ModelType,
    Product,
    QAApp,
    ServiceConfig,
    ServiceSession,
    Shipment,
    Shop,
    Sku,
    User,
    Warehouse,
)
from ..security import hash_password
from .service import OrderLine, advance_outbound, apply_move, create_after_sale, deliver_order, make_no, now, outbound_for, place_order, track_event

SERVICE_APP_NAME = "电商智能客服"
SYSTEM_PROMPT = (
    "你是知序旗舰店的智能客服。回答要简短、友好。\n"
    "查订单、物流、库存必须调用工具，不要凭空回答；退换货政策先检索知识库。\n"
    "只有买家明确要求时才申请售后，并告诉买家售后单号和需要人工审核。\n"
    "买家要求人工、投诉、要求赔偿，或你无法解决时，调用转人工工具。"
)
POLICY = [
    ("退换货", "签收后 7 天内商品完好可申请无理由退货，买了不想要可以退。质量问题 15 天内可退换，运费由我们承担。"),
    ("退款时效", "退款多久到账：仓库收到退货并审核通过后，1 到 3 个工作日原路退回。"),
    ("发货时效", "付款后 48 小时内发货，默认发顺丰、中通或京东物流，偏远地区可能延迟 1 到 2 天。"),
    ("保修", "电子产品整机保修一年，人为损坏不在保修范围内。"),
    ("发票", "发票怎么开：在订单详情申请电子发票，1 个工作日内发送到预留邮箱。"),
]
CATALOG = [
    ("便携咖啡机", "小家电", [("CM-BLK", "曜石黑", 39900, 10, {"A-01-01": 60}), ("CM-WHT", "奶油白", 39900, 10, {"A-01-02": 35})]),
    ("降噪蓝牙耳机", "数码配件", [("EB-PRO", "Pro", 89900, 15, {"A-02-01": 80}), ("EB-LTE", "Lite", 39900, 15, {"A-02-02": 12})]),
    ("人体工学椅", "家居", [("CH-GRY", "雾灰", 129900, 5, {"B-01-01": 20})]),
    ("智能台灯", "小家电", [("LP-STD", "标准版", 19900, 10, {"A-03-01": 45})]),
    ("收纳箱", "家居", [("BX-30L", "30L", 5900, 20, {"B-02-01": 8})]),
]


async def _service_app(session: AsyncSession, workspace_id: str) -> QAApp:
    from ..api.routes.fde import _save_manifest  # 避免 routes ↔ demo 的循环导入

    llm = await session.scalar(
        select(ModelConfig).where(ModelConfig.workspace_id == workspace_id, ModelConfig.model_type == ModelType.LLM, ModelConfig.is_enabled.is_(True)).order_by((ModelConfig.provider == "mock").asc()).limit(1)
    )
    if llm is None:
        llm = ModelConfig(workspace_id=workspace_id, display_name="测试替身", provider="mock", model_type=ModelType.LLM, model_name="mock-llm", base_url="mock://local", connection_status="mock")
        session.add(llm)
        await session.flush()
    knowledge = KnowledgeBase(workspace_id=workspace_id, name="电商售后政策", description="退换货、退款、发货、保修、发票政策")
    session.add(knowledge)
    await session.flush()
    body = "\n\n".join(f"## {title}\n{content}" for title, content in POLICY)
    document = KnowledgeFile(
        knowledge_base_id=knowledge.id, filename="电商售后政策.md", content_type="text/markdown", extension="md", size_bytes=len(body.encode()),
        storage_key=f"demo/{knowledge.id}/policy.md", checksum_sha256="0" * 64, status="completed", chunk_count=len(POLICY),
    )
    session.add(document)
    await session.flush()
    session.add_all([DocumentChunk(knowledge_base_id=knowledge.id, file_id=document.id, ordinal=index, title=title, content=content, char_count=len(content)) for index, (title, content) in enumerate(POLICY)])
    manifest = Manifest(
        type="agent", name=SERVICE_APP_NAME, description="接待买家咨询：查订单、查物流、查库存、申请售后，必要时转人工。", template_key="customer_service",
        system_prompt=SYSTEM_PROMPT, llm_model_id=llm.id, knowledge_base_ids=[knowledge.id],
        tools=[Tool(name="knowledge_retrieval", config={"mode": "fulltext", "top_k": 3, "rerank_top_n": 3, "score_threshold": 0.05}), Tool(name="human_handoff")],
        guardrails=Guardrails(human_handoff=True), agent=AgentSettings(knowledge_mode="tool"),
    )
    app = QAApp(workspace_id=workspace_id, status="draft", is_enabled=False)
    await _save_manifest(session, app, manifest)
    session.add(app)
    await session.flush()
    version = AppVersion(app_id=app.id, version=1, manifest=manifest.model_dump(mode="json"), release_notes="演示数据初始化")
    session.add(version)
    await session.flush()
    app.published_version_id = version.id
    app.is_enabled = True
    app.status = "published"
    session.add(ServiceConfig(workspace_id=workspace_id, app_id=app.id))
    return app


async def _demo_users(session: AsyncSession, workspace_id: str) -> None:
    for email, name, role in (("cs@fde.local", "客服小敏", "cs_agent"), ("wms@fde.local", "仓管老陈", "warehouse")):
        user = await session.scalar(select(User).where(User.email == email))
        if user is None:
            user = User(email=email, display_name=name, password_hash=hash_password("fde-demo-pass"))
            session.add(user)
            await session.flush()
        if not await session.scalar(select(Membership).where(Membership.workspace_id == workspace_id, Membership.user_id == user.id)):
            session.add(Membership(workspace_id=workspace_id, user_id=user.id, role=role))


async def _session_with(session: AsyncSession, workspace_id: str, app_id: str, customer: Customer, turns: list[tuple[str, str]], **values: Any) -> ServiceSession:
    conversation = Conversation(workspace_id=workspace_id, app_id=app_id, title=f"{customer.name} 的咨询")
    session.add(conversation)
    await session.flush()
    session.add_all([Message(conversation_id=conversation.id, role=role, content=content, simulated=role == "assistant") for role, content in turns])
    record = ServiceSession(workspace_id=workspace_id, customer_id=customer.id, conversation_id=conversation.id, **values)
    session.add(record)
    await session.flush()
    return record


async def seed_demo(session: AsyncSession, workspace_id: str, actor_id: str | None) -> dict[str, int]:
    shop = Shop(workspace_id=workspace_id, name="知序天猫旗舰店", platform="天猫")
    douyin = Shop(workspace_id=workspace_id, name="知序抖音小店", platform="抖音")
    lin = Customer(workspace_id=workspace_id, name="林小雨", phone="138****2041", level="金卡会员", address="上海市徐汇区漕溪北路 88 号")
    zhou = Customer(workspace_id=workspace_id, name="周明", phone="139****7716", level="普通会员", address="杭州市西湖区文三路 121 号")
    chen = Customer(workspace_id=workspace_id, name="陈思", phone="137****5530", level="银卡会员", address="广州市天河区体育西路 66 号")
    session.add_all([shop, douyin, lin, zhou, chen])
    warehouse = Warehouse(workspace_id=workspace_id, code="SH01", name="上海一号仓", address="上海市青浦区华新镇")
    backup = Warehouse(workspace_id=workspace_id, code="GZ02", name="广州二号仓", address="广州市白云区太和镇")
    session.add_all([warehouse, backup])
    await session.flush()

    codes = [("A-01-01", "A"), ("A-01-02", "A"), ("A-02-01", "A"), ("A-02-02", "A"), ("A-03-01", "A"), ("B-01-01", "B"), ("B-02-01", "B")]
    locations = {code: Location(warehouse_id=warehouse.id, code=code, zone=zone) for code, zone in codes}
    damaged = Location(warehouse_id=warehouse.id, code="DMG-01", zone="残次区", kind="damaged")
    backup_shelf = Location(warehouse_id=backup.id, code="A-01-01", zone="A")
    session.add_all([*locations.values(), damaged, backup_shelf, Location(warehouse_id=backup.id, code="DMG-01", zone="残次区", kind="damaged")])
    await session.flush()

    skus: dict[str, Sku] = {}
    for name, category, variants in CATALOG:
        product = Product(workspace_id=workspace_id, name=name, category=category)
        session.add(product)
        await session.flush()
        for code, spec, price, threshold, stock in variants:
            sku = Sku(workspace_id=workspace_id, product_id=product.id, code=code, spec=spec, price_cents=price, low_stock_threshold=threshold)
            session.add(sku)
            await session.flush()
            skus[code] = sku
            for location_code, quantity in stock.items():
                await apply_move(session, workspace_id=workspace_id, sku_id=sku.id, location=locations[location_code], kind="inbound", on_hand=quantity, ref_no="INIT", note="期初库存", actor_id=actor_id)
    await apply_move(session, workspace_id=workspace_id, sku_id=skus["EB-PRO"].id, location=backup_shelf, kind="inbound", on_hand=30, ref_no="INIT", note="期初库存", actor_id=actor_id)

    # (买家, 店铺, SKU, 件数, 几天前下单, 履约进度)
    history = [
        (lin, shop, "CM-BLK", 1, 6, "delivered"), (zhou, shop, "EB-PRO", 1, 5, "delivered"), (chen, douyin, "LP-STD", 2, 5, "delivered"),
        (lin, douyin, "CH-GRY", 1, 4, "delivered"), (zhou, douyin, "BX-30L", 3, 3, "shipped"), (lin, shop, "EB-LTE", 1, 2, "shipped"),
        (chen, shop, "CM-WHT", 1, 1, "shipped"), (lin, shop, "LP-STD", 1, 0, "checked"), (zhou, shop, "CM-BLK", 1, 0, "picked"), (chen, douyin, "EB-PRO", 1, 0, "paid"),
    ]
    orders = []
    for customer, order_shop, code, quantity, days, progress in history:
        order = await place_order(session, workspace_id=workspace_id, shop=order_shop, customer=customer, lines=[OrderLine(skus[code], quantity)], actor_id=actor_id)
        outbound = await outbound_for(session, order.id)
        assert outbound is not None
        steps = {"paid": [], "picked": ["pick"], "checked": ["pick", "check"], "shipped": ["pick", "check", "ship"], "delivered": ["pick", "check", "ship"]}[progress]
        for step in steps:
            await advance_outbound(session, outbound, step, actor_id=actor_id)
        if progress == "delivered":
            await deliver_order(session, order)
        placed = now() - timedelta(days=days, hours=3)
        order.created_at = placed
        if order.shipped_at:
            order.shipped_at = placed + timedelta(hours=6 + days * 3)
        orders.append(order)
        if progress == "shipped":
            shipment = await session.scalar(select(Shipment).where(Shipment.order_id == order.id))
            assert shipment is not None
            shipment.events = [*shipment.events, track_event("快件已到达转运中心，运输中")]
    await session.flush()
    await create_after_sale(session, order=orders[1], kind="return", reason="耳机左耳有杂音", source="manual")

    inbound = InboundOrder(workspace_id=workspace_id, inbound_no=make_no("IB"), warehouse_id=warehouse.id, supplier="宁波鑫源塑料", note="收纳箱紧急补货")
    inbound.lines = [InboundLine(sku_id=skus["BX-30L"].id, expected=100), InboundLine(sku_id=skus["EB-LTE"].id, expected=50)]
    session.add(inbound)

    app = await _service_app(session, workspace_id)
    for customer, question, answer in ((lin, "我的咖啡机发货了吗", "您的订单已签收。"), (zhou, "耳机什么时候到", "已发货，预计明天到达。"), (chen, "台灯有货吗", "智能台灯库存充足。"), (lin, "可以开发票吗", "可以在订单详情申请电子发票。")):
        await _session_with(session, workspace_id, app.id, customer, [("user", question), ("assistant", answer)], status="closed", closed_at=now())
    complaint = "快递盒子破了，台灯有划痕，我要投诉"
    await _session_with(
        session, workspace_id, app.id, chen, [("user", complaint), ("assistant", "非常抱歉给您带来不好的体验，已为您转接人工客服，正在排队，请稍候。")],
        status="queued", was_handed_off=True, handoff_reason=complaint, queued_at=now(), summary=f"买家：陈思（银卡会员）\n诉求：{complaint}\n转接原因：买家投诉",
    )
    await _demo_users(session, workspace_id)
    return {"orders": len(orders), "skus": len(skus)}
