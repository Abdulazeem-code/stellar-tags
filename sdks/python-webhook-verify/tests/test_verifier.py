from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timedelta, timezone

import pytest

from stellar_tags_webhook import WebhookVerificationError, verify_webhook

SECRET = "local-test-secret"
NOW = datetime(2026, 11, 21, 10, 0, 0, tzinfo=timezone.utc)
RAW_BODY = b'{"event":"payment.received","id":"evt_123"}'
TIMESTAMP = NOW.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sign(message: bytes, secret: str = SECRET) -> str:
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def signed_headers(
    raw_body: bytes = RAW_BODY,
    timestamp: str = TIMESTAMP,
    secret: str = SECRET,
) -> dict[str, str]:
    return {
        "Stellar-Timestamp": timestamp,
        "Stellar-Signature": sign(timestamp.encode() + b"." + raw_body, secret),
    }


def test_accepts_timestamp_bound_signature_over_exact_body() -> None:
    assert verify_webhook(RAW_BODY, signed_headers(), SECRET, now=NOW) == {
        "event": "payment.received",
        "id": "evt_123",
    }


def test_rejects_wrong_secret_and_modified_body() -> None:
    with pytest.raises(WebhookVerificationError, match="INVALID_SIGNATURE"):
        verify_webhook(RAW_BODY, signed_headers(secret="wrong"), SECRET, now=NOW)

    with pytest.raises(WebhookVerificationError, match="INVALID_SIGNATURE"):
        verify_webhook(
            b'{"event":"changed"}',
            signed_headers(),
            SECRET,
            now=NOW,
        )


def test_header_lookup_is_case_insensitive_and_missing_headers_fail() -> None:
    headers = signed_headers()
    lowercase_headers = {key.lower(): value for key, value in headers.items()}
    assert verify_webhook(RAW_BODY, lowercase_headers, SECRET, now=NOW)["event"] == (
        "payment.received"
    )

    with pytest.raises(WebhookVerificationError, match="MISSING_HEADER"):
        verify_webhook(RAW_BODY, {}, SECRET, now=NOW)


def test_rejects_expired_and_future_timestamps() -> None:
    expired = (NOW - timedelta(seconds=301)).isoformat()
    future = (NOW + timedelta(seconds=61)).isoformat()

    with pytest.raises(WebhookVerificationError, match="TIMESTAMP_EXPIRED"):
        verify_webhook(RAW_BODY, signed_headers(timestamp=expired), SECRET, now=NOW)
    with pytest.raises(WebhookVerificationError, match="TIMESTAMP_TOO_FAR_IN_FUTURE"):
        verify_webhook(RAW_BODY, signed_headers(timestamp=future), SECRET, now=NOW)


def test_legacy_signature_requires_explicit_opt_in() -> None:
    headers = {"X-Webhook-Signature": sign(RAW_BODY)}
    with pytest.raises(WebhookVerificationError, match="MISSING_HEADER"):
        verify_webhook(RAW_BODY, headers, SECRET, now=NOW)
    assert verify_webhook(RAW_BODY, headers, SECRET, now=NOW, allow_legacy=True)[
        "id"
    ] == "evt_123"
