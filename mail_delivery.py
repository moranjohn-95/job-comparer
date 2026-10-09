"""Small reusable SMTP transport. Never log messages or SMTP exceptions."""

import os
import smtplib
import ssl
from email.message import EmailMessage

from pydantic import EmailStr, TypeAdapter, ValidationError


class MailDeliveryError(Exception):
    pass


def send_email(recipient: str, subject: str, body: str) -> None:
    """Send via implicit TLS or mandatory STARTTLS with verified certificates.

    The socket timeout bounds connection, TLS and individual SMTP operations.
    There is no plaintext fallback and no automatic resend after uncertainty.
    """
    host = os.getenv("SMTP_HOST", "").strip()
    username = os.getenv("SMTP_USERNAME", "")
    password = os.getenv("SMTP_PASSWORD", "")
    sender = os.getenv("SMTP_FROM", "")
    mode = os.getenv("SMTP_TLS_MODE", "implicit")
    try:
        port = int(os.getenv("SMTP_PORT", "465"))
        timeout = int(os.getenv("SMTP_TIMEOUT_SECONDS", "10"))
        TypeAdapter(EmailStr).validate_python(sender)
        if (
            not host or not username or not password
            or any(c.isspace() for c in host)
            or not 1 <= port <= 65535 or not 1 <= timeout <= 30
            or mode not in {"implicit", "starttls"}
            or "\r" in sender or "\n" in sender
        ):
            raise ValueError
        message = EmailMessage()
        message["From"] = sender
        message["To"] = recipient
        message["Subject"] = subject
        message.set_content(body)
        context = ssl.create_default_context()
        if mode == "implicit":
            connection = smtplib.SMTP_SSL(
                host, port, timeout=timeout, context=context
            )
        else:
            connection = smtplib.SMTP(host, port, timeout=timeout)
        with connection as smtp:
            smtp.ehlo()
            if mode == "starttls":
                smtp.starttls(context=context)
                smtp.ehlo()
            smtp.login(username, password)
            smtp.send_message(message)
    except (ValueError, ValidationError, OSError, smtplib.SMTPException):
        raise MailDeliveryError("Email delivery is unavailable") from None
