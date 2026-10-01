"""Add private saved jobs."""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0004_saved_jobs"
down_revision: Union[str, None] = "0003_saved_cvs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Integer(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("company_name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("source_url", sa.String(length=2048), nullable=True),
    )
    op.create_index("ix_jobs_user_id_id", "jobs", ["user_id", "id"])


def downgrade() -> None:
    op.drop_index("ix_jobs_user_id_id", table_name="jobs")
    op.drop_table("jobs")
