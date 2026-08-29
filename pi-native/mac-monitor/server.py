#!/usr/bin/env python3
"""AP127 Pi Monitor — a localhost dashboard for the Orange Pi Zero 2W that runs
the flight-schedule fetch pipeline.

Read-only monitoring plus three convenience actions (run fetch now, SSH shell,
Screen Sharing). Single file, Python 3 stdlib only. Binds 127.0.0.1 only.

    python3 server.py            # start the dashboard server
    python3 server.py --selftest # run every collector once, print JSON, exit

See docs/superpowers/specs/2026-08-29-mac-pi-monitor-design.md
"""
from __future__ import annotations

import base64
import json
import shutil
import subprocess
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONFIG_PATH = Path(__file__).with_name("config.json")


def load_config() -> dict:
    cfg = json.loads(CONFIG_PATH.read_text())
    cfg.setdefault("port", 8766)
    return cfg


CFG = load_config()

# ---------------------------------------------------------------------------
# small caches so a 30 s poll doesn't hammer GitHub / the Pages sites
# ---------------------------------------------------------------------------
_cache: dict[str, tuple[float, object]] = {}


def cached(key: str, ttl: float, producer):
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    value = producer()
    _cache[key] = (now, value)
    return value


def run(cmd: list[str], timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout, check=False
    )


# ---------------------------------------------------------------------------
# collector 1 — the Pi, over one SSH round trip
# ---------------------------------------------------------------------------
REMOTE_SCRIPT = r"""
echo "UPTIME=$(uptime -p 2>/dev/null | sed 's/^up //')"
echo "LOADAVG=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
echo "MEM=$(free -m 2>/dev/null | awk '/^Mem:/{print $2, $3, $7}')"
echo "ZRAM=$(awk '/zram/{print $3, $4}' /proc/swaps 2>/dev/null)"
echo "DISK=$(df -P -h / 2>/dev/null | awk 'END{print $4, $5}')"
for z in /sys/class/thermal/thermal_zone*/temp; do
  t=$(cat "$z" 2>/dev/null); [ -n "$t" ] && { echo "CPU_TEMP=$t"; break; }
done
WL=$(iw dev wlan0 link 2>/dev/null)
echo "WIFI_SSID=$(printf '%s\n' "$WL" | awk -F': ' '/SSID/{print $2; exit}')"
echo "WIFI_SIGNAL=$(printf '%s\n' "$WL" | awk '/signal/{print $2; exit}')"
echo "SVC_CHROMIUM=$(systemctl is-active ap127-chromium.service 2>/dev/null)"
echo "SVC_TIMER=$(systemctl is-active ap127-fetch.timer 2>/dev/null)"
echo "TIMER_LAST=$(systemctl show ap127-fetch.timer -p LastTriggerUSec --value 2>/dev/null)"
echo "FETCH_EXITCODE=$(systemctl show ap127-fetch.service -p ExecMainStatus --value 2>/dev/null)"
echo "FETCH_WHEN=$(systemctl show ap127-fetch.service -p InactiveEnterTimestamp --value 2>/dev/null)"
echo "FETCH_ACTIVE=$(systemctl show ap127-fetch.service -p ActiveState --value 2>/dev/null)"
echo "CDP=$(curl -sf --max-time 3 http://127.0.0.1:9222/json/version 2>/dev/null | tr -d '\n')"
echo "JOURNAL_B64=$(journalctl -u ap127-fetch -n 60 --no-pager -o cat 2>/dev/null | base64 | tr -d '\n')"
"""


def ssh_base() -> list[str]:
    return [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=5",
        "-o", "StrictHostKeyChecking=accept-new",
        CFG["pi_host"],
    ]


def collect_pi() -> dict:
    # feed the script on stdin so it never lands in `ps` / argv
    try:
        proc = subprocess.run(
            ssh_base() + ["bash -s"],
            input=REMOTE_SCRIPT,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"reachable": False, "error": "ssh timeout"}
    if proc.returncode != 0:
        return {
            "reachable": False,
            "error": (proc.stderr or "ssh failed").strip().splitlines()[-1][:200],
        }

    kv: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            kv[k] = v.strip()

    def num(x, cast=int, default=None):
        try:
            return cast(x)
        except (TypeError, ValueError):
            return default

    mem = kv.get("MEM", "").split()
    zram = kv.get("ZRAM", "").split()
    disk = kv.get("DISK", "").split()
    journal = ""
    if kv.get("JOURNAL_B64"):
        try:
            journal = base64.b64decode(kv["JOURNAL_B64"]).decode("utf-8", "replace")
        except Exception:
            journal = ""

    out = {
        "reachable": True,
        "uptime": kv.get("UPTIME") or None,
        "loadavg": kv.get("LOADAVG") or None,
        "mem_total_mib": num(mem[0]) if len(mem) > 0 else None,
        "mem_used_mib": num(mem[1]) if len(mem) > 1 else None,
        "mem_avail_mib": num(mem[2]) if len(mem) > 2 else None,
        "zram_size_mib": round(num(zram[0], int, 0) / 1024) if len(zram) > 0 else None,
        "zram_used_mib": round(num(zram[1], int, 0) / 1024) if len(zram) > 1 else None,
        "disk_avail": disk[0] if len(disk) > 0 else None,
        "disk_used_pct": num((disk[1] if len(disk) > 1 else "").rstrip("%")),
        "cpu_temp_c": round(num(kv.get("CPU_TEMP"), int, 0) / 1000, 1)
        if kv.get("CPU_TEMP")
        else None,
        "wifi_ssid": kv.get("WIFI_SSID") or None,
        "wifi_signal_dbm": num(kv.get("WIFI_SIGNAL"), float),
        "svc_chromium": kv.get("SVC_CHROMIUM") or "unknown",
        "svc_timer": kv.get("SVC_TIMER") or "unknown",
        "timer_last": kv.get("TIMER_LAST") or None,
        "fetch_exitcode": num(kv.get("FETCH_EXITCODE")),
        "fetch_when": kv.get("FETCH_WHEN") or None,
        "fetch_active": kv.get("FETCH_ACTIVE") or None,
        "cdp": None,
        "journal_tail": [],
        "last_run": {},
    }

    if kv.get("CDP"):
        try:
            out["cdp"] = json.loads(kv["CDP"]).get("Browser")
        except Exception:
            out["cdp"] = kv["CDP"][:80]

    if journal:
        lines = [ln for ln in journal.splitlines() if ln.strip()]
        out["journal_tail"] = lines[-15:]
        out["last_run"] = parse_last_run(lines)

    return out


def parse_last_run(lines: list[str]) -> dict:
    """Most recent *completed* fetch cycle's outcome + counts, scanning the
    whole journal window. A cycle that has only just started (no outcome line
    yet) does not overwrite the previous cycle's result."""
    info: dict = {"outcome": "unknown", "flights": None, "dates": None, "running": False}
    for ln in lines:
        if "Fetched" in ln and "flight" in ln:
            parts = ln.replace("(s)", "").split()
            try:
                info["flights"] = int(parts[parts.index("Fetched") + 1])
                info["dates"] = int(parts[parts.index("across") + 1])
            except (ValueError, IndexError):
                pass
        if "Fetch failed" in ln or "FATAL" in ln or "git pull failed" in ln:
            info["outcome"] = "failed"
        elif "No data changes" in ln or "nothing to commit" in ln:
            info["outcome"] = "no-change"
        elif "Pushed on attempt" in ln:
            info["outcome"] = "pushed"
        elif "Saved →" in ln:
            info["outcome"] = "fetched"
    # is a cycle in flight right now (started after the last outcome line)?
    last_outcome_idx = max(
        (i for i, ln in enumerate(lines)
         if any(m in ln for m in ("Pushed on attempt", "No data changes",
                                  "Fetch failed", "nothing to commit", "Deactivated successfully"))),
        default=-1,
    )
    last_start_idx = max(
        (i for i, ln in enumerate(lines) if "starting fetch" in ln), default=-1
    )
    info["running"] = last_start_idx > last_outcome_idx
    return info


# ---------------------------------------------------------------------------
# collector 2 — GitHub, via the Mac's authenticated `gh`
# ---------------------------------------------------------------------------
def gh_json(path: str):
    gh = shutil.which("gh")
    if not gh:
        raise RuntimeError("gh not found")
    proc = run([gh, "api", path], timeout=15)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "gh api failed").strip()[:200])
    return json.loads(proc.stdout)


def collect_github() -> dict:
    def producer():
        out: dict = {"available": True}
        commits = gh_json(f"repos/{CFG['repo']}/commits?per_page=25")
        head = commits[0]
        out["head_sha"] = head["sha"][:9]
        out["head_when"] = head["commit"]["committer"]["date"]
        out["head_msg"] = head["commit"]["message"].splitlines()[0]
        pi_commit = next(
            (c for c in commits if "(orangepi-zero2w)" in c["commit"]["message"]), None
        )
        if pi_commit:
            out["pi_push_sha"] = pi_commit["sha"][:9]
            out["pi_push_when"] = pi_commit["commit"]["committer"]["date"]
        runs = gh_json(
            f"repos/{CFG['cmdv2_repo']}/actions/workflows/refresh-data.yml/runs?per_page=1"
        )
        wr = (runs.get("workflow_runs") or [None])[0]
        if wr:
            out["cmdv2_status"] = wr["status"]
            out["cmdv2_conclusion"] = wr["conclusion"]
            out["cmdv2_when"] = wr["created_at"]
            out["cmdv2_url"] = wr["html_url"]
        return out

    try:
        return cached("github", 120, producer)
    except Exception as e:
        return {"available": False, "error": str(e)}


# ---------------------------------------------------------------------------
# collector 3 — the two live Pages sites
# ---------------------------------------------------------------------------
def collect_sites() -> dict:
    def producer():
        result: dict = {}
        for site in CFG["sites"]:
            key = site.split("//", 1)[-1]
            try:
                url = f"{site}/flight-data.js?_={int(time.time())}"
                req = urllib.request.Request(
                    url,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Macintosh) AP127PiMonitor",
                        "Accept": "*/*",
                    },
                )
                with urllib.request.urlopen(req, timeout=5) as r:
                    blob = r.read(200_000).decode("utf-8", "replace")
                idx = blob.find('"fetchedAt"')
                if idx == -1:
                    result[key] = {"ok": False, "error": "no fetchedAt"}
                    continue
                start = blob.find('"', idx + 11) + 1
                end = blob.find('"', start)
                result[key] = {"ok": True, "fetchedAt": blob[start:end]}
            except Exception as e:
                result[key] = {"ok": False, "error": str(e)[:120]}
        return result

    return cached("sites", 60, producer)


# ---------------------------------------------------------------------------
# assembly + headline
# ---------------------------------------------------------------------------
def iso_age_seconds(iso: str | None) -> float | None:
    if not iso:
        return None
    from datetime import datetime, timezone

    s = iso.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        try:
            dt = datetime.fromisoformat(s[:19]).replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - dt).total_seconds()


def build_status() -> dict:
    pi = collect_pi()
    gh = collect_github()
    sites = collect_sites()

    reasons: list[str] = []
    level = "green"

    if not pi.get("reachable"):
        level = "red"
        reasons.append(f"Pi unreachable ({pi.get('error', 'ssh failed')})")
    else:
        if pi.get("svc_chromium") != "active":
            level = "red"
            reasons.append(f"ap127-chromium.service {pi.get('svc_chromium')}")
        if pi.get("fetch_exitcode") not in (0, None):
            level = "red"
            reasons.append(f"last fetch exit {pi.get('fetch_exitcode')}")

    push_age = iso_age_seconds(gh.get("pi_push_when"))
    if level != "red":
        if push_age is not None and push_age > 20 * 60:
            level = "yellow"
            reasons.append(f"last data push {int(push_age // 60)} min ago")
        if pi.get("reachable"):
            if not pi.get("cdp"):
                level = "yellow"
                reasons.append("CDP not responding")
            if pi.get("svc_timer") != "active":
                level = "yellow"
                reasons.append(f"ap127-fetch.timer {pi.get('svc_timer')}")
            if (pi.get("mem_avail_mib") or 999) < 60:
                level = "yellow"
                reasons.append(f"low RAM ({pi.get('mem_avail_mib')} MiB avail)")
            if (pi.get("disk_used_pct") or 0) > 90:
                level = "yellow"
                reasons.append(f"disk {pi.get('disk_used_pct')}% full")
        for key, s in sites.items():
            if s.get("ok") and push_age is not None:
                site_age = iso_age_seconds(s["fetchedAt"])
                if site_age is not None and site_age - push_age > 15 * 60:
                    level = "yellow"
                    reasons.append(f"{key} lags push")

    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "level": level,
        "reasons": reasons,
        "last_push_age_sec": push_age,
        "pi": pi,
        "github": gh,
        "sites": sites,
    }


# ---------------------------------------------------------------------------
# actions
# ---------------------------------------------------------------------------
def action_fetch_now() -> dict:
    proc = run(
        ssh_base() + ["systemctl start --no-block ap127-fetch.service"], timeout=15
    )
    ok = proc.returncode == 0
    return {
        "ok": ok,
        "message": "Fetch cycle started on the Pi."
        if ok
        else (proc.stderr.strip() or "ssh failed")[:200],
    }


def action_ssh_shell() -> dict:
    host = CFG["pi_host"]
    script = f'tell application "Terminal" to do script "ssh {host}"'
    proc = run(
        ["osascript", "-e", script, "-e", 'tell application "Terminal" to activate'],
        timeout=10,
    )
    ok = proc.returncode == 0
    return {
        "ok": ok,
        "message": f"Opened Terminal → ssh {host}"
        if ok
        else (proc.stderr.strip() or "osascript failed")[:200],
    }


def action_vnc() -> dict:
    pw = CFG.get("vnc_password", "ap127vnc")
    remote = (
        f"export DISPLAY=:99; pkill -u dietpi x11vnc 2>/dev/null; sleep 1; "
        f"x11vnc -storepasswd '{pw}' /tmp/.vncpw-mon >/dev/null 2>&1; "
        f"nohup x11vnc -display :99 -rfbauth /tmp/.vncpw-mon -once -timeout 60 "
        f"-rfbversion 3.7 -rfbport 5900 -bg -o /tmp/x11vnc-mon.log >/dev/null 2>&1; "
        f"sleep 1; ss -tlnp | grep -q ':5900 ' && echo STARTED"
    )
    proc = run(ssh_base() + [f"sudo -u dietpi -H bash -c {shell_quote(remote)}"], timeout=20)
    if proc.returncode != 0 or "STARTED" not in proc.stdout:
        return {
            "ok": False,
            "message": (proc.stderr.strip() or "failed to start x11vnc")[:200],
        }
    run(["open", f"vnc://{CFG['pi_ip']}"], timeout=10)
    return {
        "ok": True,
        "message": f"Screen Sharing opening — password: {pw} (x11vnc self-stops on disconnect / 60 s).",
    }


def shell_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "AP127PiMonitor"

    def log_message(self, *a):  # quiet
        pass

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index"):
            self._send(200, PAGE.encode(), "text/html; charset=utf-8")
        elif self.path.startswith("/api/status"):
            try:
                self._json(build_status())
            except Exception as e:
                self._json({"level": "red", "reasons": [f"monitor error: {e}"]}, 500)
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        actions = {
            "/api/fetch-now": action_fetch_now,
            "/api/ssh": action_ssh_shell,
            "/api/vnc": action_vnc,
            "/api/refresh": lambda: {"ok": True, "message": "ok"},
        }
        fn = actions.get(self.path)
        if not fn:
            self._send(404, b"not found", "text/plain")
            return
        try:
            self._json(fn())
        except Exception as e:
            self._json({"ok": False, "message": str(e)[:200]}, 500)


# ---------------------------------------------------------------------------
# the page (inline)
# ---------------------------------------------------------------------------
PAGE = r"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AP127 Pi Monitor</title>
<style>
:root{
  --bg:#0f1216; --card:#171c22; --line:#262e37; --fg:#e6edf3; --dim:#8b96a2;
  --green:#2ea043; --yellow:#d29922; --red:#f85149; --accent:#3b82f6;
}
*{box-sizing:border-box} html,body{margin:0}
body{background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;padding:18px 16px 40px}
h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.02em}
.wrap{max-width:1080px;margin:0 auto}
.top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:16px}
.dot{width:16px;height:16px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 4px rgba(255,255,255,.04)}
.dot.green{background:var(--green)} .dot.yellow{background:var(--yellow)} .dot.red{background:var(--red)}
.hl{font-size:18px;font-weight:600}
.sub{color:var(--dim);font-size:12px}
.reasons{color:var(--yellow);font-size:12px;margin-top:2px}
.reasons.red{color:var(--red)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:0 0 8px}
.row{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row .k{color:var(--dim)} .row .v{text-align:right;font-variant-numeric:tabular-nums}
.v.ok{color:var(--green)} .v.warn{color:var(--yellow)} .v.bad{color:var(--red)}
.btns{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}
button{background:#20262e;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}
button:hover{background:#2a323c} button:active{transform:translateY(1px)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
#toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#20262e;border:1px solid var(--line);border-radius:8px;padding:10px 16px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none;max-width:80vw}
#toast.show{opacity:1}
details{margin-top:14px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 14px}
details summary{cursor:pointer;color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
pre{white-space:pre-wrap;word-break:break-word;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);margin:8px 0 2px;max-height:320px;overflow:auto}
.count{color:var(--dim);font-size:12px;margin-left:auto}
a{color:var(--accent)}
</style></head><body><div class="wrap">
<div class="top">
  <div id="dot" class="dot red"></div>
  <div>
    <div class="hl" id="hl">Loading…</div>
    <div class="sub" id="sub"></div>
    <div class="reasons" id="reasons"></div>
  </div>
  <div class="count" id="count"></div>
</div>

<div class="btns">
  <button class="primary" onclick="act('/api/fetch-now','Run fetch now')">Run fetch now</button>
  <button onclick="act('/api/ssh','SSH shell')">SSH shell</button>
  <button onclick="act('/api/vnc','Screen Sharing')">Screen Sharing</button>
  <button onclick="load()">Refresh now</button>
</div>

<div class="grid">
  <div class="card"><h2>Fetch pipeline</h2><div id="c-fetch"></div></div>
  <div class="card"><h2>Pi health</h2><div id="c-pi"></div></div>
  <div class="card"><h2>Live sites</h2><div id="c-sites"></div></div>
  <div class="card"><h2>CMDV2 trigger</h2><div id="c-cmdv2"></div></div>
</div>

<details><summary>journalctl -u ap127-fetch (last 15 lines)</summary><pre id="journal"></pre></details>
</div>
<div id="toast"></div>
<script>
const $=s=>document.querySelector(s);
let hover=false, secs=30;
document.body.addEventListener('mouseenter',()=>hover=true);
document.body.addEventListener('mouseleave',()=>hover=false);

function ago(iso){ if(!iso) return "—";
  const s=(Date.now()-Date.parse(iso))/1000;
  if(isNaN(s)) return iso;
  if(s<90) return Math.round(s)+"s ago";
  if(s<5400) return Math.round(s/60)+" min ago";
  if(s<172800) return Math.round(s/3600)+" h ago";
  return Math.round(s/86400)+" d ago";
}
function row(k,v,cls){ return `<div class="row"><span class="k">${k}</span><span class="v ${cls||''}">${v==null?'—':v}</span></div>`; }
function svc(s){ return s==='active'?['active','ok']:[s||'?','bad']; }

async function load(){
  try{
    const r=await fetch('/api/status'); const d=await r.json();
    render(d); secs=30;
  }catch(e){ $('#hl').textContent='monitor unreachable'; }
}
function toast(m){ const t=$('#toast'); t.textContent=m; t.classList.add('show');
  clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'),4200); }

async function act(url,label){
  toast(label+'…');
  try{ const r=await fetch(url,{method:'POST'}); const d=await r.json();
    toast((d.ok?'✓ ':'✗ ')+(d.message||label));
    if(url==='/api/fetch-now') setTimeout(load,9000);
  }catch(e){ toast('✗ '+label+' failed'); }
}

function render(d){
  const dot=$('#dot'); dot.className='dot '+(d.level||'red');
  $('#hl').textContent = d.level==='green'?'Healthy':d.level==='yellow'?'Degraded':'Problem';
  const push = d.github && d.github.pi_push_when;
  $('#sub').textContent = 'Last data push: '+ago(push)+'  ·  updated '+new Date().toLocaleTimeString();
  const rz=$('#reasons'); rz.className='reasons '+(d.level==='red'?'red':'');
  rz.textContent=(d.reasons||[]).join('  ·  ');

  const pi=d.pi||{}, g=d.github||{}, lr=pi.last_run||{};
  // fetch pipeline
  let out={green:'ok',yellow:'warn',red:'bad'}[d.level]||'';
  const oc={pushed:['pushed ✓','ok'],fetched:['fetched (no push yet)','ok'],
            'no-change':['no data change','ok'],failed:['FAILED','bad'],unknown:['—','']}[lr.outcome||'unknown'];
  const lastRun = lr.running ? [oc[0]+'  ·  (cycle running now)', oc[1]] : oc;
  $('#c-fetch').innerHTML =
    row('Last run', lastRun[0], lastRun[1]) +
    row('Counts', lr.flights!=null?`${lr.flights} flights / ${lr.dates} dates`:'—') +
    row('Fetch service', ...(pi.fetch_active?[pi.fetch_active+' (exit '+(pi.fetch_exitcode)+')', pi.fetch_exitcode===0?'ok':'bad']:['—',''])) +
    row('Timer last fired', pi.timer_last||'—') +
    row('Head commit', g.head_sha?`${g.head_sha} · ${ago(g.head_when)}`:'—') +
    row('Pi push commit', g.pi_push_sha?`${g.pi_push_sha} · ${ago(g.pi_push_when)}`:'—');

  // pi health
  if(!pi.reachable){
    $('#c-pi').innerHTML = row('Reachable','NO — '+(pi.error||''),'bad');
  } else {
    const mem = pi.mem_avail_mib, memCls = mem==null?'':mem<60?'bad':mem<120?'warn':'ok';
    const dfp = pi.disk_used_pct||0;
    $('#c-pi').innerHTML =
      row('Reachable','yes','ok') +
      row('Uptime', pi.uptime) +
      row('RAM available', mem!=null?mem+' MiB':'—', memCls) +
      row('zram used', pi.zram_used_mib!=null?`${pi.zram_used_mib} / ${pi.zram_size_mib} MiB`:'—') +
      row('Disk free', pi.disk_avail?`${pi.disk_avail} (${dfp}% used)`:'—', dfp>90?'bad':dfp>80?'warn':'') +
      row('CPU temp', pi.cpu_temp_c!=null?pi.cpu_temp_c+' °C':'—', pi.cpu_temp_c>75?'warn':'') +
      row('WiFi', pi.wifi_ssid?`${pi.wifi_ssid} ${pi.wifi_signal_dbm!=null?pi.wifi_signal_dbm+' dBm':''}`:'—', pi.wifi_signal_dbm<-75?'warn':'') +
      row('ap127-chromium', ...svc(pi.svc_chromium)) +
      row('CDP', pi.cdp?pi.cdp:'not responding', pi.cdp?'ok':'warn') +
      row('ap127-fetch.timer', ...svc(pi.svc_timer));
  }

  // sites
  const sc=d.sites||{}; let sh='';
  for(const k of Object.keys(sc)){ const s=sc[k];
    sh += row(k.replace('.pages.dev',''), s.ok?ago(s.fetchedAt):('err: '+(s.error||'')), s.ok?'':'bad'); }
  $('#c-sites').innerHTML = sh || row('—','no sites');

  // cmdv2
  if(g.available===false){ $('#c-cmdv2').innerHTML=row('GitHub','unavailable: '+(g.error||''),'warn'); }
  else if(g.cmdv2_status){
    const good = g.cmdv2_conclusion==='success';
    $('#c-cmdv2').innerHTML =
      row('Last run', (g.cmdv2_status==='completed'?g.cmdv2_conclusion:g.cmdv2_status), good?'ok':(g.cmdv2_status==='completed'?'bad':'warn')) +
      row('When', ago(g.cmdv2_when)) +
      row('Link', g.cmdv2_url?`<a href="${g.cmdv2_url}" target="_blank">open ↗</a>`:'—');
  } else { $('#c-cmdv2').innerHTML=row('—','no runs found'); }

  $('#journal').textContent = (pi.journal_tail||[]).join('\n') || '(no journal)';
}

setInterval(()=>{
  if(hover){ $('#count').textContent='paused'; return; }
  secs--; $('#count').textContent='refresh in '+secs+'s';
  if(secs<=0){ secs=30; load(); }
},1000);
load();
</script></body></html>"""


# ---------------------------------------------------------------------------
# entry
# ---------------------------------------------------------------------------
def main():
    if "--selftest" in sys.argv:
        print(json.dumps(build_status(), indent=2, default=str))
        return
    port = int(CFG["port"])
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"AP127 Pi Monitor → http://127.0.0.1:{port}  (Ctrl-C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
