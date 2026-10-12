"""Add stable account identities for future backup reconciliation."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0010_account_uuid"
down_revision = "0009_email_verification"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # PostgreSQL evaluates this volatile default for each existing row.
    # Retain the default for new accounts; updates do not regenerate it.
    op.add_column(
        "users",
        sa.Column(
            "account_uuid",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
    )
    op.create_unique_constraint(
        "uq_users_account_uuid", "users", ["account_uuid"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_users_account_uuid", "users", type_="unique")
    op.drop_column("users", "account_uuid")
