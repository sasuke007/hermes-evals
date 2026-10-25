#!/usr/bin/env python3
"""nous-login: connects Nous Portal from the UI (plan 6.1, UI_FLOWS 6).

Nous Portal has no API keys, only an OAuth device login with rotating refresh
tokens, so the login has to live somewhere the platform never copies. This
small HTTP server runs in the pinned trial image with HOME and HERMES_HOME on
the nous-home volume, the same volume nous-proxy serves model calls from. It
runs Hermes's own device login and writes the result where nous-proxy reads
it; nous-proxy re-reads the auth store under Hermes's file lock on every
request, so it serves a new login without a restart.

It calls the functions `hermes auth add nous` and `hermes logout` use (Hermes
4d04303, hermes_cli/auth_nous.py and hermes_cli/auth.py):
- `_nous_device_code_login(open_browser=False, on_verification=...)`: asks the
  portal for a device code, hands the link and user code to on_verification
  before polling starts, then polls until the user approves, declines or the
  code runs out. The portal is HERMES_PORTAL_BASE_URL (or NOUS_PORTAL_BASE_URL)
  when set, which is how the tests point it at a fake portal.
- `_save_active_provider_state`, `_write_shared_nous_state` and
  `_sync_nous_pool_from_auth_store`: what `_login_nous` persists, in that
  order. Each takes Hermes's own file lock. The shared store must be written
  too: Hermes's refresh path merges a "fresher" shared refresh token into the
  login, so a stale one there would overwrite the new login.
- `get_nous_auth_status_local()`: status from the volume, with no network call.
- `logout_command(provider='nous')`: Disconnect, exactly as the CLI does it.
- `_request_device_code` is wrapped only to learn the code's lifetime, which
  on_verification does not pass on.

These are private functions, so the server checks at startup that each exists
with the parameters it calls it with. If one is missing or changed, every
route reports state `unavailable` with the reason (UI_FLOWS 19 #12), and an
image bump reruns the check. The fallback for a future Hermes is to run
`hermes auth add nous --type oauth --no-browser` and read what it prints.

Hermes's poll loop has no cancel hook, so each login runs in a child process
(this script with --login-child) watched by a background thread; Cancel and a
second Connect kill it. A login that has been approved and is being saved is
never killed: it is waited for, so the auth store and the shared store are
never left disagreeing.

What never leaves the volume: access tokens, refresh tokens and the agent key.
Responses carry only a state, the link, the user code, its expiry, the scope
and non-secret messages; the child's stdout and stderr (where Hermes prints)
go to /dev/null, and the request log has method, path and status only.

Reachable only on the internal provider-admin network (the API and the worker)
plus an outbound network to the portal. Standard library only.

Usage: `nous-login.py` serves on NOUS_LOGIN_PORT (8650); `--health` is the
Compose healthcheck; `--login-child` is the login process the server starts.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import importlib
import inspect
import io
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

PORT = int(os.environ.get("NOUS_LOGIN_PORT", "8650"))
HOST = os.environ.get("NOUS_LOGIN_HOST", "0.0.0.0")
DEFAULT_PORTAL_URL = "https://portal.nousresearch.com"
# How long POST /login waits for the portal to issue a code (Hermes's own
# request timeout is 15 s).
START_WAIT_S = 30.0
# A waiting login this long past its expiry is stopped here, in case the child
# is stuck; Hermes itself ends the poll at the expiry.
STUCK_GRACE_S = 30.0
# How long a login that is being saved is waited for before it is replaced.
PERSIST_WAIT_S = 20.0
# Fallback when the portal's device code answer gave no lifetime (Hermes's 15 minutes).
DEFAULT_CODE_TTL_S = 900
MESSAGE_MAX_CHARS = 300

# (module, function, parameters this server passes by name). Every other
# parameter must have a default.
CONTRACT: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("hermes_cli.auth", "_nous_device_code_login", ("open_browser", "on_verification", "timeout_seconds")),
    ("hermes_cli.auth", "_request_device_code", ("client", "portal_base_url", "client_id", "scope")),
    ("hermes_cli.auth", "_save_active_provider_state", ("provider_id", "state")),
    ("hermes_cli.auth", "_write_shared_nous_state", ("state",)),
    ("hermes_cli.auth", "_sync_nous_pool_from_auth_store", ()),
    ("hermes_cli.auth", "get_nous_auth_status_local", ()),
    ("hermes_cli.auth", "get_provider_auth_state", ("provider_id",)),
    ("hermes_cli.auth", "logout_command", ("args",)),
    ("hermes_cli.auth_error_copy", "is_device_code_expired", ("exc",)),
    ("hermes_cli.auth_error_copy", "is_network_error", ("exc",)),
)
# Login states the UI sees (NOUS_LOGIN_STATES in packages/shared), plus two
# internal ones: `starting` (no code yet) and `persisting` (approved, saving).
ACTIVE_STATES = frozenset({"starting", "waiting_for_approval", "persisting"})

log = logging.getLogger("nous-login")


def portal_url() -> str:
    """The portal Hermes logs in against, resolved the way _nous_device_code_login does."""
    url = os.environ.get("HERMES_PORTAL_BASE_URL") or os.environ.get("NOUS_PORTAL_BASE_URL")
    return (url or DEFAULT_PORTAL_URL).rstrip("/")


def iso(epoch: float) -> str:
    moment = dt.datetime.fromtimestamp(epoch, tz=dt.timezone.utc)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def short(text: str) -> str:
    """First line of a message, bounded: enough to act on, never a whole payload."""
    line = (text or "").strip().splitlines()[0] if (text or "").strip() else ""
    return line[:MESSAGE_MAX_CHARS]


def check_contract() -> Optional[str]:
    """None when every Hermes function this server calls is there as expected, else why not."""
    if not os.environ.get("HERMES_HOME"):
        return "HERMES_HOME is not set, so the login would not land in the nous-home volume"
    for module_name, name, params in CONTRACT:
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:  # noqa: BLE001 - any import failure means unavailable
            return f"cannot import {module_name}: {type(exc).__name__}"
        fn = getattr(module, name, None)
        if not callable(fn):
            return f"{module_name}.{name} is missing"
        try:
            signature = inspect.signature(fn)
        except (TypeError, ValueError):
            return f"{module_name}.{name} has no readable signature"
        by_name = signature.parameters
        for param in params:
            p = by_name.get(param)
            if p is None or p.kind not in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY):
                return f"{module_name}.{name} no longer takes {param}"
        for p in by_name.values():
            if p.name in params or p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
                continue
            if p.default is p.empty:
                return f"{module_name}.{name} now requires {p.name}"
    return None


def classify(exc: BaseException) -> tuple[str, Optional[str]]:
    """How a login that raised ends: (NousLoginState, message for `failed`)."""
    from hermes_cli.auth_error_copy import is_device_code_expired, is_network_error

    chain: list[BaseException] = []
    cursor: Optional[BaseException] = exc
    while cursor is not None and cursor not in chain:
        chain.append(cursor)
        cursor = cursor.__cause__ or cursor.__context__
    codes = {str(getattr(e, "code", "") or "") for e in chain}
    codes |= {str(getattr(e, "oauth_error_code", "") or "") for e in chain}
    # Hermes prints the billing link and raises SystemExit(1) from the
    # subscription_required AuthError (auth_nous.py _nous_device_code_login).
    if "subscription_required" in codes:
        return "needs_subscription", None
    if "access_denied" in codes:
        return "denied", None
    if any(is_device_code_expired(e) for e in chain):
        return "expired", None
    if any(is_network_error(e) for e in chain):
        return "failed", f"Could not reach Nous Portal: {short(str(exc)) or type(exc).__name__}."
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if isinstance(status, int):
        return "failed", f"Nous Portal answered HTTP {status} to the login request."
    detail = short(str(exc)) if not isinstance(exc, SystemExit) else ""
    return "failed", f"The Nous Portal login failed: {detail or type(exc).__name__}."


def run_login_child() -> int:
    """One device login, reported as JSON lines on stdout. Hermes's own output goes nowhere."""
    proto = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    sys.stdout = sys.stderr = open(os.devnull, "w", encoding="utf-8")
    logging.disable(logging.CRITICAL)

    def emit(**message: Any) -> None:
        proto.write(json.dumps(message) + "\n")

    persisting = False
    try:
        auth = importlib.import_module("hermes_cli.auth")
        request_device_code = auth._request_device_code

        def capture(*args: Any, **kwargs: Any) -> dict[str, Any]:
            data = request_device_code(*args, **kwargs)
            emit(event="issued", expiresIn=int(data.get("expires_in") or DEFAULT_CODE_TTL_S))
            return data

        auth._request_device_code = capture
        state = auth._nous_device_code_login(
            open_browser=False,
            timeout_seconds=15.0,
            on_verification=lambda url, code: emit(event="verification", verifyUrl=url, userCode=code),
        )
        persisting = True
        emit(event="persisting")
        auth._save_active_provider_state(provider_id="nous", state=state)
        auth._write_shared_nous_state(state=state)
        auth._sync_nous_pool_from_auth_store()
        emit(event="connected")
        return 0
    except BaseException as exc:  # noqa: BLE001 - every ending is reported
        if persisting:
            emit(event="ended", state="failed",
                 error=f"Nous Portal approved the login, but saving it failed: {type(exc).__name__}.")
        else:
            state_name, error = classify(exc)
            emit(event="ended", state=state_name, error=error)
        return 1


class LoginSupervisor:
    """The one login at a time: its state, its child process, and the lock around both."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)
        self.generation = 0
        self.proc: Optional[subprocess.Popen[str]] = None
        # {state, userCode, verifyUrl, expiresAt (epoch), error} or None.
        self.login: Optional[dict[str, Any]] = None

    # -- views -------------------------------------------------------------

    def login_view(self, volume_state: str) -> dict[str, Any]:
        """The NousLogin contract: the pending or last failed login, else what the volume holds."""
        with self.lock:
            self._expire_stuck_locked()
            login = dict(self.login) if self.login else None
        if login is None or login["state"] == "starting":
            state = "connected" if volume_state == "connected" else "not_connected"
            return ended_view(state)
        if login["state"] in ("waiting_for_approval", "persisting"):
            return {
                "state": "waiting_for_approval",
                "userCode": login["userCode"],
                "verifyUrl": login["verifyUrl"],
                "expiresAt": iso(login["expiresAt"]),
                "error": None,
                "billingUrl": None,
            }
        return ended_view(login["state"], login.get("error"))

    def has_login(self) -> bool:
        with self.lock:
            return self.login is not None

    # -- actions -----------------------------------------------------------

    def start(self) -> None:
        """Replace any pending login with a new one; return once the portal issued a code or it ended."""
        with self.lock:
            self._stop_locked()
            self.generation += 1
            generation = self.generation
            self.login = {"state": "starting", "userCode": None, "verifyUrl": None,
                          "expiresAt": None, "error": None, "issuedTtl": None}
            self.proc = subprocess.Popen(
                [sys.executable, os.path.abspath(__file__), "--login-child"],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, encoding="utf-8", start_new_session=True,
            )
            threading.Thread(target=self._follow, args=(generation, self.proc), daemon=True).start()
            deadline = time.monotonic() + START_WAIT_S
            while self.generation == generation and self.login and self.login["state"] == "starting":
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._kill_locked()
                    self.login = {"state": "failed", "error": "Nous Portal did not issue a code within 30 s."}
                    break
                self.changed.wait(remaining)

    def cancel(self) -> None:
        """Stop a pending login. An approved login that is being saved finishes first."""
        with self.lock:
            self._stop_locked()
            self.generation += 1
            self.login = None

    def logout(self) -> None:
        """Disconnect, as `hermes logout --provider nous` does, after stopping any login."""
        with self.lock:
            self._stop_locked()
            self.generation += 1
            self.login = None
            auth = importlib.import_module("hermes_cli.auth")
            try:
                # It prints what it did; nothing of it is needed here.
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    auth.logout_command(args=argparse.Namespace(provider="nous"))
            except SystemExit as exc:
                raise RuntimeError(f"hermes logout exited with {exc.code}") from None

    def shutdown(self) -> None:
        with self.lock:
            self._stop_locked()

    # -- internals (call with the lock held) -------------------------------

    def _stop_locked(self) -> None:
        if self.login and self.login["state"] == "persisting":
            deadline = time.monotonic() + PERSIST_WAIT_S
            while self.login and self.login["state"] == "persisting" and time.monotonic() < deadline:
                self.changed.wait(deadline - time.monotonic())
        self._kill_locked()

    def _kill_locked(self) -> None:
        proc, self.proc = self.proc, None
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(2)

    def _expire_stuck_locked(self) -> None:
        login = self.login
        if login and login["state"] == "waiting_for_approval" and time.time() > login["expiresAt"] + STUCK_GRACE_S:
            self._kill_locked()
            self.generation += 1
            self.login = {"state": "expired", "error": None}

    def _follow(self, generation: int, proc: subprocess.Popen[str]) -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            with self.lock:
                if generation == self.generation and self.login is not None:
                    self._apply_locked(message)
                    self.changed.notify_all()
        code = proc.wait()
        with self.lock:
            if generation == self.generation and self.login and self.login["state"] in ACTIVE_STATES:
                self.login = {"state": "failed",
                              "error": f"The login process stopped unexpectedly (exit code {code})."}
            self.changed.notify_all()

    def _apply_locked(self, message: dict[str, Any]) -> None:
        event = message.get("event")
        login = self.login
        assert login is not None
        if event == "issued":
            login["issuedTtl"] = int(message.get("expiresIn") or DEFAULT_CODE_TTL_S)
        elif event == "verification":
            ttl = login.get("issuedTtl") or DEFAULT_CODE_TTL_S
            login.update(state="waiting_for_approval", userCode=str(message.get("userCode")),
                         verifyUrl=str(message.get("verifyUrl")), expiresAt=time.time() + ttl)
        elif event == "persisting":
            login["state"] = "persisting"
        elif event == "connected":
            # From here the volume speaks for the login (GET /login answers `connected`
            # while it holds one), so a later disconnect or quarantine is never hidden.
            self.login = None
            log.info("login connected")
        elif event == "ended":
            state = str(message.get("state") or "failed")
            self.login = {"state": state, "error": message.get("error") if state == "failed" else None}
            log.info("login ended: %s", state)


def ended_view(state: str, error: Optional[str] = None) -> dict[str, Any]:
    return {
        "state": state,
        "userCode": None,
        "verifyUrl": None,
        "expiresAt": None,
        "error": error if state == "failed" else None,
        "billingUrl": f"{portal_url()}/billing" if state == "needs_subscription" else None,
    }


def volume_status() -> dict[str, Any]:
    """What the nous-home volume holds, read without a network call. Never a token."""
    auth = importlib.import_module("hermes_cli.auth")
    status = auth.get_nous_auth_status_local()
    free_tier = bool(status.get("free_tier"))
    if status.get("relogin_required"):
        return {"state": "relogin_required", "scope": None, "relogin_required": True}
    if status.get("logged_in") and not free_tier:
        state = auth.get_provider_auth_state(provider_id="nous") or {}
        scope = state.get("scope") if isinstance(state.get("scope"), str) else None
        return {"state": "connected", "scope": scope, "relogin_required": False}
    if not free_tier and (status.get("has_refresh_token") or status.get("inference_credential_present")):
        # A login is stored but cannot be used or refreshed: only a new login helps.
        return {"state": "relogin_required", "scope": None, "relogin_required": True}
    return {"state": "not_connected", "scope": None, "relogin_required": False}


class Handler(BaseHTTPRequestHandler):
    server_version = "nous-login"
    supervisor: LoginSupervisor
    unavailable: Optional[str] = None

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        self._route("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._route("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._route("DELETE")

    def _route(self, method: str) -> None:
        self._discard_body()
        path = self.path.split("?", 1)[0]
        if (method, path) == ("GET", "/health"):
            return self._send(200, {"ok": True, "state": "unavailable" if self.unavailable else "ready"})
        if (method, path) == ("GET", "/status"):
            return self._send(200, self._status())
        routes = {("GET", "/login"), ("POST", "/login"), ("DELETE", "/login"), ("POST", "/logout")}
        if (method, path) not in routes:
            return self._send(404, {"error": "not found"})
        if self.unavailable:
            return self._send(503, {"state": "unavailable", "reason": self.unavailable})
        try:
            if (method, path) == ("POST", "/login"):
                self.supervisor.start()
            elif (method, path) == ("DELETE", "/login"):
                self.supervisor.cancel()
            elif (method, path) == ("POST", "/logout"):
                self.supervisor.logout()
            volume = volume_status()
        except Exception as exc:  # noqa: BLE001 - answered, never a traceback with state in it
            log.warning("%s %s failed: %s", method, path, type(exc).__name__)
            return self._send(500, {"error": f"{type(exc).__name__}: {short(str(exc))}"})
        self._send(200, self.supervisor.login_view(volume["state"]))

    def _status(self) -> dict[str, Any]:
        base = {"source": "volume", "portalUrl": portal_url(), "billingUrl": f"{portal_url()}/billing"}
        if self.unavailable:
            return {**base, "state": "unavailable", "scope": None, "relogin_required": False,
                    "reason": self.unavailable, "login": None}
        try:
            volume = volume_status()
        except Exception as exc:  # noqa: BLE001
            reason = f"could not read the login in the nous-home volume: {type(exc).__name__}"
            return {**base, "state": "unavailable", "scope": None, "relogin_required": False,
                    "reason": reason, "login": None}
        login = self.supervisor.login_view(volume["state"]) if self.supervisor.has_login() else None
        return {**base, **volume, "reason": None, "login": login}

    def _discard_body(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if 0 < length <= 65536:
            self.rfile.read(length)

    def _send(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - http.server signature
        # Method, path and status only; bodies are never logged.
        log.info("%s %s", self.address_string(), format % args)


def health_check() -> int:
    """The Compose healthcheck: 0 when this server answers /health. Ignores proxy variables."""
    import http.client

    try:
        connection = http.client.HTTPConnection("127.0.0.1", PORT, timeout=3)
        connection.request("GET", "/health")
        return 0 if connection.getresponse().status == 200 else 1
    except OSError:
        return 1


def main() -> int:
    if "--login-child" in sys.argv[1:]:
        return run_login_child()
    if "--health" in sys.argv[1:]:
        return health_check()
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="nous-login: %(message)s")
    unavailable = check_contract()
    if unavailable:
        log.warning("unavailable: %s", unavailable)
    else:
        log.info("Hermes login functions present; portal %s", portal_url())
    supervisor = LoginSupervisor()
    Handler.supervisor = supervisor
    Handler.unavailable = unavailable
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True

    def stop(_signum: int, _frame: Any) -> None:
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    log.info("listening on %s:%d", HOST, PORT)
    try:
        server.serve_forever(poll_interval=0.5)
    except (SystemExit, KeyboardInterrupt):
        pass
    finally:
        supervisor.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
