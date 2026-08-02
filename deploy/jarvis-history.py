#!/usr/bin/env python3
"""
Jarvis chat history API — deploy to /opt/jarvis-history.py on VPS.
Stores full message objects: id, role, content, createdAt (ISO).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

HISTORY_PATH = os.environ.get("JARVIS_HISTORY_PATH", "/var/lib/jarvis/history.json")
MAX_MESSAGES = 200
LISTEN_HOST = os.environ.get("JARVIS_HISTORY_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("JARVIS_HISTORY_PORT", "8799"))


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_iso_timestamp(value: str) -> bool:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def migrate_message(message: dict[str, Any], index: int, total: int) -> dict[str, Any] | None:
    role = message.get("role")
    content = message.get("content")
    if role not in ("user", "assistant") or not isinstance(content, str):
        return None

    created_at = message.get("createdAt") or message.get("created_at")
    if isinstance(created_at, str) and created_at and is_iso_timestamp(created_at):
        normalized_created_at = created_at
    elif isinstance(message.get("updatedAt"), (int, float)):
        normalized_created_at = datetime.fromtimestamp(
            float(message["updatedAt"]), tz=timezone.utc
        ).isoformat()
    elif isinstance(message.get("time"), str) and is_iso_timestamp(str(message["time"])):
        normalized_created_at = datetime.fromisoformat(
            str(message["time"]).replace("Z", "+00:00")
        ).isoformat()
    else:
        normalized_created_at = datetime.fromtimestamp(
            datetime.now(timezone.utc).timestamp() - (total - index),
            tz=timezone.utc,
        ).isoformat()

    message_id = message.get("id")
    if not isinstance(message_id, str) or not message_id:
        message_id = f"legacy-{index}-{hash(content) & 0xfffffff}"

    return {
        "id": message_id,
        "role": role,
        "content": content,
        "createdAt": normalized_created_at,
    }


def load_messages() -> list[dict[str, Any]]:
    if not os.path.exists(HISTORY_PATH):
        return []
    with open(HISTORY_PATH, encoding="utf-8") as file:
        payload = json.load(file)
    raw = payload.get("messages", payload if isinstance(payload, list) else [])
    if not isinstance(raw, list):
        return []
    total = len(raw)
    migrated = []
    for index, raw_item in enumerate(raw):
        migrated_item = migrate_message(raw_item if isinstance(raw_item, dict) else {}, index, total)
        if migrated_item:
            migrated.append(migrated_item)
    needs_persist = any(
        isinstance(item, dict) and not item.get("createdAt") and not item.get("created_at")
        for item in raw
    )
    if needs_persist and migrated:
        save_messages(migrated)
    return migrated


def dedupe_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen_ids: set[str] = set()
    seen_fallback: set[tuple[str, str, str]] = set()
    result: list[dict[str, Any]] = []
    for message in messages:
        message_id = message.get("id")
        if isinstance(message_id, str) and message_id:
            if message_id in seen_ids:
                continue
            seen_ids.add(message_id)
            result.append(message)
            continue
        key = (
            str(message.get("role", "")),
            str(message.get("content", "")),
            str(message.get("createdAt", "")),
        )
        if key in seen_fallback:
            continue
        seen_fallback.add(key)
        result.append(message)
    return result


def save_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    total = len(messages)
    for index, item in enumerate(messages):
        if not isinstance(item, dict):
            continue
        migrated = migrate_message(item, index, total)
        if migrated:
            normalized.append(migrated)
    deduped = dedupe_messages(normalized)
    trimmed = deduped[-MAX_MESSAGES:]
    os.makedirs(os.path.dirname(HISTORY_PATH), exist_ok=True)
    with open(HISTORY_PATH, "w", encoding="utf-8") as file:
        json.dump({"messages": trimmed}, file, ensure_ascii=False, indent=2)
    return trimmed


class JarvisHistoryHandler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path not in ("/history", "/p/jarvis/history"):
            self._send_json(404, {"error": "not found"})
            return
        query = parse_qs(parsed.query)
        limit = int(query.get("limit", ["50"])[0])
        messages = load_messages()
        if limit > 0:
            messages = messages[-limit:]
        self._send_json(200, {"messages": messages})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path not in ("/history", "/p/jarvis/history"):
            self._send_json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid json"})
            return
        incoming = payload.get("messages", [])
        if not isinstance(incoming, list):
            self._send_json(400, {"error": "messages must be an array"})
            return
        saved = save_messages(incoming)
        self._send_json(200, {"messages": saved, "count": len(saved)})

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path not in ("/history", "/p/jarvis/history"):
            self._send_json(404, {"error": "not found"})
            return
        save_messages([])
        self._send_json(200, {"ok": True})


def main() -> None:
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), JarvisHistoryHandler)
    print(f"jarvis-history listening on {LISTEN_HOST}:{LISTEN_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
