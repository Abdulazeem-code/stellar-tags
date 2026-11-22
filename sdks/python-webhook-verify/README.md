# stellar-tags-webhook

A Python 3.9+ package for verifying Stellar Tags webhook requests with the standard library only.

## Install

```sh
python -m pip install stellar-tags-webhook
```

For local development and tests:

```sh
python -m pip install -e ".[dev]"
pytest
mypy --strict
ruff check .
```

Always provide the original request body bytes. Parsing and re-serializing JSON changes the signed bytes.

## Flask

Read raw bytes before parsing the JSON, then verify the headers and body:

```python
import os

from flask import Flask, abort, request
from stellar_tags_webhook import WebhookVerificationError, verify_webhook

app = Flask(__name__)
secret = os.environ["WEBHOOK_SECRET"]


@app.post("/webhooks/stellar-tags")
def receive_webhook():
    raw_body = request.get_data(cache=True, as_text=False)
    try:
        payload = verify_webhook(raw_body, request.headers, secret)
    except WebhookVerificationError as error:
        abort(401, description=error.reason)
    print("Verified event:", payload.get("event"))
    return "", 200
```

`request.get_data(as_text=False)` returns the original body bytes; do not call `request.get_json()` before verification.

## FastAPI

Read the request body once as bytes and pass the request headers through:

```python
import os

from fastapi import FastAPI, HTTPException, Request
from stellar_tags_webhook import WebhookVerificationError, verify_webhook

app = FastAPI()
secret = os.environ["WEBHOOK_SECRET"]


@app.post("/webhooks/stellar-tags")
async def receive_webhook(request: Request) -> dict[str, str]:
    raw_body = await request.body()
    try:
        payload = verify_webhook(raw_body, request.headers, secret)
    except WebhookVerificationError as error:
        raise HTTPException(status_code=401, detail=error.reason) from error
    return {"event": str(payload.get("event", ""))}
```

## API and errors

`verify_webhook(raw_body, headers, secret, tolerance_seconds=300, now=None, allow_legacy=False)` returns the parsed JSON object. `headers` is any case-insensitive mapping such as Flask's or Starlette's headers. `now` is an optional timezone-aware `datetime`, useful for deterministic validation.

`WebhookVerificationError.reason` is one of `MISSING_HEADER`, `INVALID_SIGNATURE`, `TIMESTAMP_EXPIRED`, `TIMESTAMP_TOO_FAR_IN_FUTURE`, or `INVALID_PAYLOAD`. `ValueError` is raised for a negative tolerance or a naive `now` value.

The timestamp-bound signature is `HMAC-SHA256(secret, Stellar-Timestamp + "." + raw_body)`, encoded as hexadecimal. Timestamps older than `tolerance_seconds` (300 seconds by default) or more than 60 seconds in the future are rejected. Set `allow_legacy=True` only to accept the body-only `X-Webhook-Signature` fallback; any provided legacy timestamp is still checked.
