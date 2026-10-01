"""Add atomic counters for AI comparison attempts."""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0005_ai_usage_counters"
down_revision: Union[str, None] = "0004_saved_jobs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    counters = op.create_table(
        "ai_usage_counters",
        sa.Column("counter_key", sa.String(length=80), primary_key=True),
        sa.Column("call_count", sa.Integer(), nullable=False),
        sa.CheckConstraint("call_count >= 0", name="ck_ai_usage_nonnegative"),
    )
    op.bulk_insert(counters, [{"counter_key": "__lock__", "call_count": 0}])


def downgrade() -> None:
    op.drop_table("ai_usage_counters")
