"""Add persistent counters for public authentication limits."""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0007_auth_rate_limits"
down_revision: Union[str, None] = "0006_comparison_history"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "auth_rate_limit_counters",
        sa.Column("counter_key", sa.String(length=255), primary_key=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "attempt_count >= 0", name="ck_auth_rate_limit_nonnegative"
        ),
    )


def downgrade() -> None:
    op.drop_table("auth_rate_limit_counters")
