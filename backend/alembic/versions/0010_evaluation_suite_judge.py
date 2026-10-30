from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0010_evaluation_suite_judge"
down_revision = "0009_evaluation_run_manifest_hash"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "evaluation_suites" not in inspector.get_table_names():
        return
    if "judge_config" not in {item["name"] for item in inspector.get_columns("evaluation_suites")}:
        op.add_column("evaluation_suites", sa.Column("judge_config", sa.JSON(), nullable=False, server_default="{}"))


def downgrade() -> None:
    op.drop_column("evaluation_suites", "judge_config")
