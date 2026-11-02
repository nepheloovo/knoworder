from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0011_message_flow_state"
down_revision = "0010_evaluation_suite_judge"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "messages" not in inspector.get_table_names():
        return
    if "flow_state" not in {item["name"] for item in inspector.get_columns("messages")}:
        op.add_column("messages", sa.Column("flow_state", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "flow_state")
