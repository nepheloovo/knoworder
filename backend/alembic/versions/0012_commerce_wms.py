from __future__ import annotations

from alembic import op

from app.db import Base
from app import models  # noqa: F401  注册全部表


revision = "0012_commerce_wms"
down_revision = "0011_message_flow_state"
branch_labels = None
depends_on = None

TABLES = [
    "shops", "customers", "products", "skus", "warehouses", "warehouse_locations", "inventory_balances", "inventory_moves",
    "sales_orders", "sales_order_items", "shipments", "after_sales", "inbound_orders", "inbound_lines",
    "outbound_orders", "outbound_lines", "service_configs", "service_sessions",
]


def upgrade() -> None:
    # 与 0001 相同：表结构以 models.py 为准；已存在的表（全新库由 0001 建好）会被跳过
    Base.metadata.create_all(op.get_bind(), tables=[Base.metadata.tables[name] for name in TABLES], checkfirst=True)


def downgrade() -> None:
    Base.metadata.drop_all(op.get_bind(), tables=[Base.metadata.tables[name] for name in TABLES], checkfirst=True)
