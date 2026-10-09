"""Add email verification and a reusable authentication cooldown timestamp."""

from alembic import op
import sqlalchemy as sa

revision = "0009_email_verification"
down_revision = "0008_auth_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column(
        "email_verified_at", sa.DateTime(timezone=True), nullable=True
    ))
    op.add_column("auth_rate_limit_counters", sa.Column(
        "last_attempt_at", sa.DateTime(timezone=True), nullable=True
    ))
    op.create_table(
        "verification_tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(),
                  sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False),
        sa.Column("purpose", sa.String(32), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("token_hash", name="uq_verification_token_hash"),
    )
    op.create_index("ix_verification_tokens_user_purpose",
                    "verification_tokens", ["user_id", "purpose"])
    op.create_index("ix_verification_tokens_expires_at",
                    "verification_tokens", ["expires_at"])


def downgrade() -> None:
    op.drop_table("verification_tokens")
    op.drop_column("auth_rate_limit_counters", "last_attempt_at")
    op.drop_column("users", "email_verified_at")
