"""HTTP calls to the ap127-readiness Worker (Plan 1). stdlib only."""
from __future__ import annotations

import json
import urllib.request

UA = "ap127-readiness/1"


def _req(method: str, url: str, key: str, body: dict | None = None, timeout: int = 20):
    data = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"X-Key": key, "Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def publish(payload: dict, url: str, key: str) -> int:
    return _req("PUT", url.rstrip("/") + "/plan", key, payload)[0]


def get_pending(url: str, key: str) -> list[dict]:
    _, body = _req("GET", url.rstrip("/") + "/apply/pending", key)
    return json.loads(body or b"{}").get("pending", [])


def post_result(url: str, key: str, id: str, st: str, why: str) -> int:
    return _req("POST", url.rstrip("/") + "/apply/result", key, {"id": id, "st": st, "why": why})[0]
