"""Save private comparison results with CV revision markers."""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0006_comparison_history"
down_revision: Union[str, None] = "0005_ai_usage_counters"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "cvs",
        sa.Column(
            "revision",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
    )
    op.create_table(
        "comparison_history",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "job_id",
            sa.Integer(),
            sa.ForeignKey("jobs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "cv_revision", postgresql.UUID(as_uuid=True), nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("result", postgresql.JSONB(), nullable=False),
    )
    op.create_index(
        "ix_comparison_history_owner_job_created",
        "comparison_history",
        ["user_id", "job_id", "created_at", "id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_comparison_history_owner_job_created",
        table_name="comparison_history",
    )
    op.drop_table("comparison_history")
    op.drop_column("cvs", "revision")
