#!/usr/bin/env python3
"""A fake Nous Portal for the nous-login tests. Never contacts anything.

It serves the two device-login endpoints Hermes calls (Hermes 4d04303,
hermes_cli/auth_device_flow.py): POST /api/oauth/device/code issues a code,
and POST /api/oauth/token answers the device-code poll and, for the
subscription scenario, the refresh Hermes makes when the token it got is not
a usable inference JWT (auth_nous.py refresh_nous_oauth_from_state).

The scenario applies to the next code issued; the test sets it with
POST /_control {"scenario": ..., "approveAfterS": ..., "expiresIn": ...}:
- approve: one `authorization_pending`, then a token.
- slow: `authorization_pending` until approveAfterS (default 8) have passed,
  then a token. Used for cancel and for a second Connect replacing the first.
- deny: one `authorization_pending`, then `access_denied`.
- expire: the code lives expiresIn seconds (default 3) and is never approved,
  so Hermes's own deadline ends the poll.
- subscription_required: the device poll returns an opaque access token, so
  Hermes refreshes it, and the refresh answers 403 `subscription_required`.

The approved access token is an unsigned JWT with scope `inference:invoke`
and an hour to live, which Hermes accepts without a further network call.
GET /_requests lists what was asked (path, grant type, client id, scope and
device code), never a token. Standard library only, so it runs in the trial image.
"""
from __future__ import annotations

import base64
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs

PORT = int(os.environ.get("FAKE_PORTAL_PORT", "8700"))
BASE_URL = os.environ.get("FAKE_PORTAL_BASE_URL", f"http://portal:{PORT}").rstrip("/")
DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
SCOPE = "inference:invoke"

lock = threading.Lock()
control: dict[str, Any] = {"scenario": "approve", "approveAfterS": 8.0, "expiresIn": 3}
devices: dict[str, dict[str, Any]] = {}
refresh_owner: dict[str, str] = {}
requests_seen: list[dict[str, Any]] = []
counter = 0


def b64(data: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")


def invoke_jwt(n: int) -> str:
    claims = {"sub": f"fake-user-{n}", "scope": SCOPE, "exp": int(time.time()) + 3600}
    return f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64(claims)}.fake-signature"


def token_body(device: dict[str, Any], access_token: str) -> dict[str, Any]:
    refresh = f"fake-refresh-{device['n']}"
    refresh_owner[refresh] = device["code"]
    return {"access_token": access_token, "refresh_token": refresh, "token_type": "Bearer",
            "scope": SCOPE, "expires_in": 3600}


def issue(form: dict[str, str]) -> tuple[int, dict[str, Any]]:
    global counter
    counter += 1
    scenario = str(control["scenario"])
    expires_in = int(control["expiresIn"]) if scenario == "expire" else 600
    code = f"dc-{counter}"
    user_code = f"FAKE-{counter:04d}"
    devices[code] = {"n": counter, "code": code, "scenario": scenario, "issued": time.monotonic(),
                     "approveAfterS": float(control["approveAfterS"]), "polls": 0}
    return 200, {"device_code": code, "user_code": user_code, "verification_uri": f"{BASE_URL}/device",
                 "verification_uri_complete": f"{BASE_URL}/device?user_code={user_code}",
                 "expires_in": expires_in, "interval": 1}


def poll(form: dict[str, str]) -> tuple[int, dict[str, Any]]:
    device = devices.get(form.get("device_code", ""))
    if device is None:
        return 400, {"error": "invalid_grant", "error_description": "unknown device code"}
    device["polls"] += 1
    scenario = device["scenario"]
    pending = (400, {"error": "authorization_pending"})
    if scenario == "expire":
        return pending
    if scenario == "slow":
        if time.monotonic() - device["issued"] < device["approveAfterS"]:
            return pending
        return 200, token_body(device, invoke_jwt(device["n"]))
    if device["polls"] < 2:
        return pending
    if scenario == "deny":
        return 400, {"error": "access_denied", "error_description": "The user declined."}
    if scenario == "subscription_required":
        return 200, token_body(device, f"opaque-{device['n']}")
    return 200, token_body(device, invoke_jwt(device["n"]))


def refresh(refresh_token: str) -> tuple[int, dict[str, Any]]:
    device = devices.get(refresh_owner.get(refresh_token, ""))
    if device is None:
        return 400, {"error": "invalid_grant", "error_description": "unknown refresh token"}
    if device["scenario"] == "subscription_required":
        return 403, {"error": "subscription_required",
                     "error_description": "No active paid subscription found."}
    return 200, token_body(device, invoke_jwt(device["n"]))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        if self.path == "/health":
            return self.send(200, {"ok": True})
        if self.path == "/_requests":
            with lock:
                return self.send(200, {"requests": list(requests_seen)})
        self.send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        with lock:
            if self.path == "/_control":
                control.update(json.loads(raw or "{}"))
                return self.send(200, dict(control))
            form = {k: v[0] for k, v in parse_qs(raw).items()}
            requests_seen.append({"path": self.path, "grantType": form.get("grant_type"),
                                  "clientId": form.get("client_id"), "scope": form.get("scope"),
                                  "deviceCode": form.get("device_code"), "at": time.time()})
            if self.path == "/api/oauth/device/code":
                return self.send(*issue(form))
            if self.path == "/api/oauth/token" and form.get("grant_type") == DEVICE_GRANT:
                return self.send(*poll(form))
            if self.path == "/api/oauth/token" and form.get("grant_type") == "refresh_token":
                return self.send(*refresh(self.headers.get("x-nous-refresh-token") or ""))
        self.send(404, {"error": "not found"})

    def send(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()
