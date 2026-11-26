"""Timestamp-bound Stellar Tags webhook verification using only the standard library."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, Literal

WebhookVerificationReason = Literal[
    "MISSING_HEADER",
    "INVALID_SIGNATURE",
    "TIMESTAMP_EXPIRED",
    "TIMESTAMP_TOO_FAR_IN_FUTURE",
    "INVALID_PAYLOAD",
]

_FUTURE_SKEW_SECONDS = 60
_SIGNATURE_PATTERN = re.compile(r"^[a-fA-F0-9]{64}$")


class WebhookVerificationError(Exception):
    """Raised when a webhook signature, timestamp, or payload is invalid."""

    def __init__(self, reason: WebhookVerificationReason) -> None:
        self.reason = reason
        super().__init__(reason)


def _header(headers: Mapping[str, str], name: str) -> str | None:
    lowered_name = name.lower()
    for key, value in headers.items():
        if key.lower() == lowered_name:
            return value
    return None


def _parse_timestamp(value: str) -> datetime:
    normalized = value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value
    try:
        timestamp = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise WebhookVerificationError("TIMESTAMP_EXPIRED") from error
    if timestamp.tzinfo is None or timestamp.utcoffset() is None:
        raise WebhookVerificationError("TIMESTAMP_EXPIRED")
    return timestamp.astimezone(timezone.utc)


def _verify_freshness(
    timestamp_header: str,
    now: datetime,
    tolerance_seconds: int,
) -> None:
    timestamp = _parse_timestamp(timestamp_header)
    age_seconds = (now - timestamp).total_seconds()
    if age_seconds > tolerance_seconds:
        raise WebhookVerificationError("TIMESTAMP_EXPIRED")
    if age_seconds < -_FUTURE_SKEW_SECONDS:
        raise WebhookVerificationError("TIMESTAMP_TOO_FAR_IN_FUTURE")


def _verify_signature(secret: str, message: bytes, signature: str | None) -> None:
    if signature is None:
        raise WebhookVerificationError("MISSING_HEADER")
    if not _SIGNATURE_PATTERN.fullmatch(signature):
        raise WebhookVerificationError("INVALID_SIGNATURE")
    expected = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature.lower()):
        raise WebhookVerificationError("INVALID_SIGNATURE")


def verify_webhook(
    raw_body: bytes,
    headers: Mapping[str, str],
    secret: str,
    tolerance_seconds: int = 300,
    now: datetime | None = None,
    allow_legacy: bool = False,
) -> dict[str, Any]:
    """Verify a raw webhook body and return its JSON object payload.

    The timestamp-bound signature uses the exact timestamp header and body
    bytes. The body-only legacy signature is accepted only when enabled.
    """
    if tolerance_seconds < 0:
        raise ValueError("tolerance_seconds must be non-negative")
    current_time = now or datetime.now(timezone.utc)
    if current_time.tzinfo is None or current_time.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    current_time = current_time.astimezone(timezone.utc)

    signature = _header(headers, "Stellar-Signature")
    timestamp = _header(headers, "Stellar-Timestamp") or _header(
        headers, "X-Webhook-Timestamp"
    )
    if signature is not None and timestamp is not None:
        _verify_freshness(timestamp, current_time, tolerance_seconds)
        _verify_signature(
            secret,
            timestamp.encode("utf-8") + b"." + raw_body,
            signature,
        )
    else:
        if not allow_legacy:
            raise WebhookVerificationError("MISSING_HEADER")
        legacy_signature = _header(headers, "X-Webhook-Signature")
        if legacy_signature is None:
            raise WebhookVerificationError("MISSING_HEADER")
        if timestamp is not None:
            _verify_freshness(timestamp, current_time, tolerance_seconds)
        _verify_signature(secret, raw_body, legacy_signature)

    try:
        payload: Any = json.loads(raw_body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WebhookVerificationError("INVALID_PAYLOAD") from error
    if not isinstance(payload, dict):
        raise WebhookVerificationError("INVALID_PAYLOAD")
    return payload
