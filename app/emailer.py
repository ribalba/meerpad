"""Email delivery (meerato's, rebranded).

If ``smtp_host`` is configured the message is sent via SMTP; otherwise it is printed
to the console so the app is fully usable in development without an email provider.
"""

import smtplib
import textwrap
from email.message import EmailMessage
from email.utils import formataddr

from .config import get_settings

settings = get_settings()

APP_NAME = "meerpad"
SIGNATURE = f"-- \n{APP_NAME} · https://meerpad.com"


def _compose(subject: str, body: str) -> tuple[str, str]:
    full_subject = f"{APP_NAME} · {subject}"
    full_body = f"{textwrap.dedent(body).strip()}\n\n{SIGNATURE}"
    return full_subject, full_body


def send_email(to: str, subject: str, body: str) -> None:
    subject, body = _compose(subject, body)

    if not settings.smtp_host:
        _print_to_console(to, subject, body)
        return

    msg = EmailMessage()
    msg["From"] = formataddr((APP_NAME, settings.email_from))
    msg["To"] = to
    msg["Subject"] = subject
    # Disable Brevo/Sendinblue (Mailin) open and click tracking on a per-email basis.
    msg["X-Mailin-Track"] = "false"
    msg["X-Mailin-Track-Clicks"] = "false"
    msg["X-Mailin-Track-Opens"] = "false"
    msg.set_content(body)

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as smtp:
            if settings.smtp_use_tls:
                smtp.starttls()
            if settings.smtp_user:
                smtp.login(settings.smtp_user, settings.smtp_password)
            smtp.send_message(msg)
    except Exception as exc:  # noqa: BLE001 - never let email failure break a request
        print(f"[emailer] SMTP send failed ({exc!r}); falling back to console:")
        _print_to_console(to, subject, body)


def _print_to_console(to: str, subject: str, body: str) -> None:
    banner = "=" * 70
    print(
        f"\n{banner}\n[EMAIL] From: {APP_NAME} <{settings.email_from}>\nTo: {to}\n"
        f"Subject: {subject}\n{'-' * 70}\n{body}\n{banner}\n",
        flush=True,
    )


def send_login_link(to: str, link: str, code: str) -> None:
    """Both ways to sign in: the magic link, and the code to type in by hand (for the
    desktop app on Linux, where nothing may have claimed the ``meerpad://`` scheme)."""
    send_email(
        to,
        "Your sign-in link",
        f"""
        Hi,

        Click the link below to sign in to {APP_NAME}:

        {link}

        Or enter this code on the sign-in screen:

            {code}

        Both expire in {settings.login_token_ttl_minutes} minutes.

        If you didn't request this, you can ignore this email.
        """,
    )
