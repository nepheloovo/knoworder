from __future__ import annotations

from httpx import AsyncClient

ADMIN = {"X-Demo-Role": "admin"}
API = "/api/v1/commerce"


async def _seed(client: AsyncClient) -> None:
    response = await client.post(f"{API}/demo/seed", headers=ADMIN)
    assert response.status_code == 201, response.text


async def _get(client: AsyncClient, path: str):
    response = await client.get(f"{API}{path}", headers=ADMIN)
    assert response.status_code == 200, response.text
    return response.json()


async def _post(client: AsyncClient, path: str, body: dict | None = None, expect: int = 200):
    response = await client.post(f"{API}{path}", headers=ADMIN, json=body or {})
    assert response.status_code == expect, response.text
    return response.json()


async def _stock(client: AsyncClient, code: str) -> dict:
    rows = await _get(client, "/inventory")
    return next(item for item in rows if item["code"] == code)


async def _order_setup(client: AsyncClient, code: str, quantity: int = 1) -> dict:
    shops = await _get(client, "/shops")
    customers = await _get(client, "/customers")
    stock = await _stock(client, code)
    return await _post(client, "/orders", {"shop_id": shops[0]["id"], "customer_id": customers[0]["id"], "items": [{"sku_id": stock["sku_id"], "quantity": quantity}]}, 201)


async def _outbound_of(client: AsyncClient, order_no: str) -> dict:
    return next(item for item in await _get(client, "/outbound") if item["order_no"] == order_no)


async def _ship(client: AsyncClient, order_no: str) -> None:
    outbound = await _outbound_of(client, order_no)
    for action in ("pick", "check", "ship"):
        await _post(client, f"/outbound/{outbound['id']}/{action}")


async def test_order_locks_ships_and_return_restocks(client: AsyncClient) -> None:
    await _seed(client)
    before = await _stock(client, "CH-GRY")
    order = await _order_setup(client, "CH-GRY", 2)
    locked = await _stock(client, "CH-GRY")
    assert locked["locked"] == before["locked"] + 2
    assert locked["available"] == before["available"] - 2
    assert locked["on_hand"] == before["on_hand"]

    await _ship(client, order["order_no"])
    shipped = await _stock(client, "CH-GRY")
    assert shipped["on_hand"] == before["on_hand"] - 2
    assert shipped["locked"] == before["locked"]

    record = await _post(client, "/after-sales", {"order_id": order["id"], "kind": "return", "reason": "不合适"}, 201)
    assert record["amount"] == order["total"]
    await _post(client, f"/after-sales/{record['id']}/review", {"approve": True})
    await _post(client, f"/after-sales/{record['id']}/returning")
    done = await _post(client, f"/after-sales/{record['id']}/receive", {"condition": "good"})
    assert done["status"] == "completed"
    assert (await _stock(client, "CH-GRY"))["on_hand"] == before["on_hand"]
    refunded = next(item for item in await _get(client, "/orders") if item["id"] == order["id"])
    assert refunded["status"] == "refunded"


async def test_damaged_return_is_not_sellable(client: AsyncClient) -> None:
    await _seed(client)
    order = await _order_setup(client, "LP-STD")
    await _ship(client, order["order_no"])
    after_ship = await _stock(client, "LP-STD")
    record = await _post(client, "/after-sales", {"order_id": order["id"], "kind": "return"}, 201)
    await _post(client, f"/after-sales/{record['id']}/review", {"approve": True})
    await _post(client, f"/after-sales/{record['id']}/returning")
    await _post(client, f"/after-sales/{record['id']}/receive", {"condition": "damaged"})
    stock = await _stock(client, "LP-STD")
    assert stock["available"] == after_ship["available"]
    assert stock["damaged"] == after_ship["damaged"] + 1


async def test_overselling_rejected_and_leaves_no_trace(client: AsyncClient) -> None:
    await _seed(client)
    before = await _stock(client, "BX-30L")
    shops = await _get(client, "/shops")
    customers = await _get(client, "/customers")
    orders_before = len(await _get(client, "/orders"))
    response = await client.post(f"{API}/orders", headers=ADMIN, json={"shop_id": shops[0]["id"], "customer_id": customers[0]["id"], "items": [{"sku_id": before["sku_id"], "quantity": before["available"] + 1}]})
    assert response.status_code == 409
    assert "库存不足" in response.json()["detail"]
    assert len(await _get(client, "/orders")) == orders_before
    assert await _stock(client, "BX-30L") == before


async def test_repeated_ship_does_not_deduct_twice(client: AsyncClient) -> None:
    await _seed(client)
    order = await _order_setup(client, "CM-WHT")
    await _ship(client, order["order_no"])
    after = await _stock(client, "CM-WHT")
    outbound = await _outbound_of(client, order["order_no"])
    await _post(client, f"/outbound/{outbound['id']}/ship", expect=409)
    assert await _stock(client, "CM-WHT") == after


async def test_cancel_releases_stock(client: AsyncClient) -> None:
    await _seed(client)
    before = await _stock(client, "CM-BLK")
    order = await _order_setup(client, "CM-BLK", 3)
    await _post(client, f"/orders/{order['id']}/cancel")
    assert await _stock(client, "CM-BLK") == before


async def test_inbound_receive_and_putaway(client: AsyncClient) -> None:
    await _seed(client)
    before = await _stock(client, "BX-30L")
    inbound = (await _get(client, "/inbound"))[0]
    line = next(item for item in inbound["lines"] if item["code"] == "BX-30L")
    await _post(client, f"/inbound/{inbound['id']}/receive", {"received": {line["id"]: 90}})
    warehouses = await _get(client, "/warehouses")
    place = next(item for item in warehouses[1]["locations"] if item["code"] == "B-02-01") if warehouses[1]["code"] == "SH01" else next(item for item in next(w for w in warehouses if w["code"] == "SH01")["locations"] if item["code"] == "B-02-01")
    locations = {item["id"]: place["id"] for item in inbound["lines"]}
    await _post(client, f"/inbound/{inbound['id']}/putaway", {"locations": locations})
    assert (await _stock(client, "BX-30L"))["on_hand"] == before["on_hand"] + 90
    moves = await _get(client, f"/inventory/moves?sku_id={before['sku_id']}")
    assert moves[0]["kind"] == "inbound"


async def _chat(client: AsyncClient, customer_id: str, message: str) -> dict:
    return await _post(client, "/service/chat", {"customer_id": customer_id, "message": message})


async def test_buyer_cannot_see_another_buyers_order(client: AsyncClient) -> None:
    await _seed(client)
    customers = await _get(client, "/customers")
    orders = await _get(client, "/orders")
    theirs = next(item for item in orders if item["customer_id"] == customers[1]["id"])
    reply = await _chat(client, customers[0]["id"], f"查一下订单 {theirs['order_no']}")
    answer = reply["messages"][-1]["content"]
    assert "没有查到" in answer
    assert theirs["customer"] not in answer


async def test_assistant_answers_from_real_data(client: AsyncClient) -> None:
    await _seed(client)
    customers = await _get(client, "/customers")
    lin = customers[0]
    shipped = next(item for item in await _get(client, "/orders") if item["customer_id"] == lin["id"] and item["status"] == "shipped")
    logistics = await _chat(client, lin["id"], f"订单 {shipped['order_no']} 的物流到哪了")
    assert shipped["shipment"]["tracking_no"] in logistics["messages"][-1]["content"]
    assert not logistics["messages"][-1]["citations"]
    stock = await _chat(client, lin["id"], "咖啡机还有货吗")
    assert "便携咖啡机" in stock["messages"][-1]["content"]
    policy = await _chat(client, lin["id"], "买了不想要能退吗")
    assert "7 天" in policy["messages"][-1]["content"]
    assert policy["messages"][-1]["citations"]
    assert "[资料" not in policy["messages"][-1]["content"]


async def test_assistant_creates_after_sale_for_review(client: AsyncClient) -> None:
    await _seed(client)
    customers = await _get(client, "/customers")
    lin = customers[0]
    before = len(await _get(client, "/after-sales"))
    reply = await _chat(client, lin["id"], "我要退货")
    assert "售后单号" in reply["messages"][-1]["content"]
    records = await _get(client, "/after-sales")
    assert len(records) == before + 1
    assert records[0]["source"] == "ai"
    assert records[0]["status"] == "requested"


async def test_handoff_routes_to_agent_and_silences_bot(client: AsyncClient) -> None:
    await _seed(client)
    customers = await _get(client, "/customers")
    zhou = customers[1]
    queued = await _chat(client, zhou["id"], "我要转人工")
    assert queued["status"] == "queued"
    assert "转接原因" in queued["summary"]
    waiting = await _get(client, "/service/sessions?status=queued")
    assert queued["id"] in {item["id"] for item in waiting}

    await _post(client, f"/service/sessions/{queued['id']}/accept")
    count = len((await _chat(client, zhou["id"], "在吗"))["messages"])
    current = await _get(client, f"/service/customers/{zhou['id']}/session")
    assert len(current["messages"]) == count
    assert current["messages"][-1]["role"] == "user"

    replied = await _post(client, f"/service/sessions/{queued['id']}/reply", {"content": "您好，我来帮您"})
    assert replied["messages"][-1]["role"] == "agent"
    await _post(client, f"/service/sessions/{queued['id']}/release")
    back = await _chat(client, zhou["id"], "我的订单呢")
    assert back["status"] == "ai"
    assert back["messages"][-1]["role"] == "assistant"


async def test_roles_limit_operations(client: AsyncClient) -> None:
    await _seed(client)
    response = await client.get(f"{API}/orders", headers={"X-Demo-Role": "user"})
    assert response.status_code == 403
    second = await client.post(f"{API}/demo/seed", headers=ADMIN)
    assert second.status_code == 409
