import io
import json

from readiness import publisher as PB


class Resp(io.BytesIO):
    def __init__(self, status, body=b""):
        super().__init__(body)
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_publish_puts_compact_json_with_key(monkeypatch):
    seen = {}

    def fake(req, timeout):
        seen.update(url=req.full_url, method=req.get_method(), key=req.get_header("X-key"), body=req.data,
                    ua=req.get_header("User-agent"))
        return Resp(204)

    monkeypatch.setattr(PB.urllib.request, "urlopen", fake)
    assert PB.publish({"v": 1, "a": "b"}, "https://w.example/", "pk") == 204
    assert seen["url"] == "https://w.example/plan" and seen["method"] == "PUT" and seen["key"] == "pk"
    assert seen["body"] == b'{"v":1,"a":"b"}' and seen["ua"].startswith("ap127-readiness/")


def test_get_pending_and_post_result(monkeypatch):
    calls = []

    def fake(req, timeout):
        calls.append((req.get_method(), req.full_url, req.data))
        if req.full_url.endswith("/apply/pending"):
            return Resp(200, json.dumps({"pending": [{"id": "m-1", "st": "pending"}]}).encode())
        return Resp(200, b'{"id":"m-1","st":"dryrun"}')

    monkeypatch.setattr(PB.urllib.request, "urlopen", fake)
    assert PB.get_pending("https://w", "pk") == [{"id": "m-1", "st": "pending"}]
    assert PB.post_result("https://w", "pk", "m-1", "dryrun", "would move") == 200
    assert calls[1] == ("POST", "https://w/apply/result", b'{"id":"m-1","st":"dryrun","why":"would move"}')
