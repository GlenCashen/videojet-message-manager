#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import signal
import sys
import time
from dataclasses import dataclass, field
from typing import Dict, List, Tuple
from urllib.parse import urlparse

STX = b"\x02"
ETX = b"\x03"
ACK = b"$8D"
NAK = b"!51"

WSI_LIGHT = {
    "green": "0000002",
    "amber": "0000004",
    "yellow": "0000004",
    "blue": "0000004",
    "red": "0000006",
    "off": "0000000",
}

# Markem status states captured during real testing.
NGPCL_DS = {
    "green": "{~DS0|0|1|0|0|0|2|0|000000000|06|1|}",   # printing
    "off": "{~DS0|0|0|0|0|0|2|0|000000000|11|1|}",     # idle/no light
    "yellow": "{~DS0|0|0|0|1|0|2|0|000000000|05|1|}",  # interlock/attention
    "amber": "{~DS0|0|0|0|1|0|2|0|000000000|05|1|}",
    "blue": "{~DS0|0|0|1|1|0|2|0|000000000|09|1|}",    # beam stop
    "red": "{~DS0|0|0|0|0|0|2|0|000000000|04|1|}",     # stopped/not ready
}


@dataclass
class State:
    printer_id: str
    protocol: str
    host: str
    port: int
    messages: List[dict]
    fields_by_message: Dict[str, List[dict]]
    current_message_id: str
    current_message_name: str
    light: str = "green"
    error_code: str = ""
    error_text: str = ""
    user_fields: Dict[str, Dict[str, str]] = field(default_factory=dict)

    def active_fields(self):
        return self.fields_by_message.get(self.current_message_id, [])

    def valid_message_names(self):
        return [m["printer_message_name"] for m in self.messages]

    def msg_by_name_or_id(self, value: str):
        v = value.strip()
        vu = v.upper()

        for m in self.messages:
            if v == m["message_id"] or vu == m["printer_message_name"].upper():
                return m

        return None

    def field_actual_name(self, name: str):
        n = name.strip()
        nu = n.upper()

        for f in self.active_fields():
            if nu in (
                str(f.get("field_key", "")).upper(),
                str(f["printer_field_name"]).upper(),
            ):
                return f["printer_field_name"]

        return None

    def get_field(self, name: str):
        actual = self.field_actual_name(name)
        if not actual:
            return None

        return self.user_fields.setdefault(self.current_message_id, {}).get(actual, "")

    def set_field(self, name: str, value: str, allow_unknown: bool = False):
        actual = self.field_actual_name(name)

        if not actual:
            if not allow_unknown:
                return False
            actual = name.strip()

        self.user_fields.setdefault(self.current_message_id, {})[actual] = value
        return True


def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    by_printer = {}
    fields_by_msg = {}

    for m in cfg["messages"]:
        by_printer.setdefault(m["printer_id"], []).append(m)

    for fld in cfg.get("fields", []):
        fields_by_msg.setdefault(fld["message_id"], []).append(fld)

    states = []

    for p in cfg["printers"]:
        msgs = by_printer.get(p["printer_id"], [])
        if not msgs:
            continue

        init = cfg.get("initial_state", {}).get(p["printer_id"], {})
        cur_id = init.get("current_message_id", msgs[0]["message_id"])
        cur = next((m for m in msgs if m["message_id"] == cur_id), msgs[0])

        st = State(
            printer_id=p["printer_id"],
            protocol=p["protocol"],
            host=p.get("host", "0.0.0.0"),
            port=int(p["port"]),
            messages=msgs,
            fields_by_message=fields_by_msg,
            current_message_id=cur["message_id"],
            current_message_name=cur["printer_message_name"],
            light=init.get("light", "green"),
        )

        # Initialise defaults for every field in every configured message.
        for mid, flds in fields_by_msg.items():
            for fld in flds:
                if any(m["message_id"] == mid for m in msgs):
                    st.user_fields.setdefault(mid, {})[fld["printer_field_name"]] = fld.get("default_value", "")

        # Allow explicit overrides.
        for mid, vals in init.get("user_fields", {}).items():
            st.user_fields.setdefault(mid, {}).update(vals)

        states.append(st)

    return cfg, states


def clean(data: bytes) -> Tuple[str, bool]:
    raw = data.strip(b"\x00\r\n")
    framed = raw.startswith(STX) and raw.endswith(ETX)

    if framed:
        raw = raw[1:-1]

    raw = (
        raw
        .replace(b"\x01", b"")
        .replace(b"\x12", b"")
        .replace(b"\x13", b"")
    )

    return raw.decode("ascii", errors="replace").strip(), framed


def wsi_frame(text):
    return STX + text.encode("ascii", errors="replace") + ETX


def ngpcl_parts(text: str):
    t = text.strip()

    if t.startswith("{") and t.endswith("}"):
        t = t[1:-1]

    return t.split("|")


def handle_ngpcl(st: State, text: str) -> bytes:
    parts = ngpcl_parts(text)
    head = parts[0].upper() if parts else ""

    # Markem confirmed command set.
    if head == "~JR":
        return f"{{~JN0|{st.current_message_name}|}}\r\n".encode()

    if head == "~DR":
        return (NGPCL_DS.get(st.light, NGPCL_DS["red"]) + "\r\n").encode()

    if head == "~FR":
        field = parts[1] if len(parts) > 1 else ""
        val = st.get_field(field)

        if val is None:
            return b"{~FC1|}\r\n"

        actual = st.field_actual_name(field) or field
        return f"{{~FC0|{actual}|{val}|}}\r\n".encode()

    if head == "~JS0":
        # {~JS0|<JobName.job>|0|}
        job = parts[1] if len(parts) > 1 else ""
        msg = st.msg_by_name_or_id(job)

        if not msg:
            return b"{~JS1|}\r\n"

        st.current_message_id = msg["message_id"]
        st.current_message_name = msg["printer_message_name"]
        return b"{~JS0|}\r\n"

    if head == "~JU0":
        # {~JU0||0|Field|Value|Field|Value|}
        # Markem accepts unknown fields, but readback will fail.
        start = 3 if len(parts) >= 3 else 1
        kv = parts[start:]

        if kv and kv[-1] == "":
            kv = kv[:-1]

        for i in range(0, len(kv) - 1, 2):
            st.set_field(kv[i], kv[i + 1], allow_unknown=False)

        return b"{~JU0|}\r\n"

    if head in ("~PV", "~VR", "~OR") or head.startswith("~SR"):
        return b"{~NK1|}\r\n"

    return b"{~NK1|}\r\n"


def handle_wsi(st: State, text: str, framed: bool) -> bytes:
    up = text.upper().strip()

    if up in ("Q", "GETMSG"):
        return wsi_frame(st.current_message_name) if framed else (st.current_message_name + "\n").encode()

    if up in ("E", "S", "STATUS"):
        status = WSI_LIGHT.get(st.light, "0000000")
        return wsi_frame(status) if framed else (status + "\n").encode()

    if up in ("F", "FAULT", "ERROR"):
        out = (st.error_code + (" " if st.error_code and st.error_text else "") + st.error_text).strip()
        return (out + "\n").encode()

    if up.startswith("M") and len(text) > 1:
        msg = st.msg_by_name_or_id(text[1:].strip())

        if not msg:
            return NAK

        st.current_message_id = msg["message_id"]
        st.current_message_name = msg["printer_message_name"]
        return ACK

    if up.startswith("G") and len(text) > 1:
        val = st.get_field(text[1:].strip())
        return ((val if val is not None else "") + "\n").encode()

    # App WSI format:
    #   UFIELD\nVALUE
    #
    # Manual/admin-friendly format also supported:
    #   UFIELD=VALUE
    if up.startswith("U") and len(text) > 1:
        payload = text[1:]

        if "\n" in payload:
            k, v = payload.split("\n", 1)
        elif "=" in payload:
            k, v = payload.split("=", 1)
        else:
            return NAK

        k = k.strip()
        v = v.strip()

        if not k or not v:
            return NAK

        return ACK if st.set_field(k, v, allow_unknown=False) else NAK

    return handle_admin(st, text)


def state_dict(st: State):
    return {
        "printer_id": st.printer_id,
        "protocol": st.protocol,
        "host": st.host,
        "port": st.port,
        "current_message_id": st.current_message_id,
        "current_message_name": st.current_message_name,
        "light": st.light,
        "error_code": st.error_code,
        "error_text": st.error_text,
        "fields": st.user_fields.get(st.current_message_id, {}),
        "active_fields": [f["printer_field_name"] for f in st.active_fields()],
        "valid_messages": st.valid_message_names(),
    }


def handle_admin(st: State, text: str) -> bytes:
    bits = text.strip().split(maxsplit=1)
    cmd = bits[0].lower() if bits else ""
    arg = bits[1] if len(bits) > 1 else ""

    if cmd == "json":
        return (json.dumps(state_dict(st), indent=2) + "\n").encode()

    if cmd == "list":
        return ("\n".join(st.valid_message_names()) + "\n").encode()

    if cmd == "light":
        st.light = arg.lower().strip()
        return b"OK\n"

    if cmd == "error":
        st.error_text = arg
        st.light = "red"
        return b"OK\n"

    if cmd == "clear":
        st.error_code = ""
        st.error_text = ""
        st.light = "green"
        return b"OK\n"

    if cmd == "setmsg":
        msg = st.msg_by_name_or_id(arg)

        if not msg:
            return b"Message not found\n"

        st.current_message_id = msg["message_id"]
        st.current_message_name = msg["printer_message_name"]
        return b"OK\n"

    return b"?\n"


async def read_command(reader: asyncio.StreamReader) -> bytes:
    """
    Robust reader for:
    - WSI framed packets: STX ... ETX
      Important: WSI field updates contain an internal newline:
          STX UFIELD \\n VALUE ETX
      So newline must NOT terminate a framed WSI packet.
    - NGPCL packets: {...}
    - Plain admin/nc commands ending in CR/LF
    """
    buf = b""
    deadline = time.time() + 2.0
    framed_wsi = False
    ngpcl = False

    while time.time() < deadline:
        try:
            chunk = await asyncio.wait_for(reader.read(1), timeout=0.25)
        except asyncio.TimeoutError:
            if buf:
                break
            continue

        if not chunk:
            break

        buf += chunk

        if len(buf) == 1 and buf == STX:
            framed_wsi = True

        if buf.lstrip().startswith(b"{"):
            ngpcl = True

        # WSI framed packets may contain newlines inside the payload.
        # Only ETX ends them.
        if framed_wsi:
            if buf.endswith(ETX):
                break
            continue

        # NGPCL commands normally complete when the closing brace is visible.
        if ngpcl:
            if b"}" in buf:
                break
            continue

        # Plain admin/nc commands can end on newline.
        if buf.endswith(b"\n") or buf.endswith(b"\r"):
            break

        if len(buf) > 4096:
            break

    return buf


async def client(st: State, reader, writer):
    peer = writer.get_extra_info("peername")
    response = b""
    text = ""

    try:
        data = await read_command(reader)

        if data:
            text, framed = clean(data)

            if st.protocol.lower() == "ngpcl" or text.startswith("{"):
                response = handle_ngpcl(st, text)
            else:
                response = handle_wsi(st, text, framed)

            writer.write(response)
            await writer.drain()

            print(
                f"{time.strftime('%H:%M:%S')} "
                f"{st.printer_id}({st.protocol}):{st.port} {peer} "
                f"<= {data.hex(' ')} / {text!r} => {response.hex(' ')}",
                flush=True,
            )

    except Exception as e:
        print(f"Client error {st.printer_id}:{st.port}: {e}", file=sys.stderr, flush=True)

    finally:
        writer.close()

        try:
            await writer.wait_closed()
        except Exception:
            pass


HTML = '''<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Printer Emulator</title>
<style>
body{font-family:Arial,sans-serif;background:#111;color:#eee;margin:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
.card{background:#1d1d1d;border:1px solid #333;border-radius:10px;padding:14px}
.dot{display:inline-block;width:16px;height:16px;border-radius:50%;vertical-align:middle;margin-right:8px}
.green{background:#20c261}
.red{background:#e33}
.amber,.yellow{background:#e5b927}
.blue{background:#3182ff}
.off{background:#777}
button,input,select{margin:3px;padding:6px}
pre{background:#000;padding:8px;border-radius:8px;overflow:auto}
.small{color:#aaa;font-size:12px}
</style>
</head>
<body>
<h1>Printer Emulator</h1>
<div class="small" id="status">Loading...</div>
<div id="app" class="grid"></div>

<script>
let editing = false;
let lastLoad = 0;

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function setv(id, k, v) {
  editing = false;

  await api('/api/set', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({printer_id: id, [k]: v})
  });

  await load(true);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function messageOptions(p) {
  return p.valid_messages.map(m => {
    const selected = m === p.current_message_name ? 'selected' : '';
    return `<option ${selected}>${esc(m)}</option>`;
  }).join('');
}

async function load(force = false) {
  const active = document.activeElement;
  const isEditing = active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);

  // Do not redraw while the operator is selecting/editing.
  if (!force && (editing || isEditing)) return;

  const s = await api('/api/state');
  lastLoad = Date.now();
  status.textContent = 'Last refresh: ' + new Date(lastLoad).toLocaleTimeString();

  app.innerHTML = s.map(p => `
    <div class="card">
      <h2><span class="dot ${esc(p.light)}"></span>${esc(p.printer_id)}</h2>

      <p>${esc(p.protocol).toUpperCase()} ${esc(p.host)}:${esc(p.port)}</p>
      <p><b>Message:</b> ${esc(p.current_message_name)}</p>
      <p><b>Light:</b> ${esc(p.light)}</p>

      <p><b>Fields:</b></p>
      ${Object.entries(p.fields).map(([k, v]) => `
        <div>
          ${esc(k)}:
          <input
            value="${esc(v)}"
            onfocus="editing=true"
            onblur="editing=false"
            onchange="setv('${esc(p.printer_id)}','field:${esc(k)}',this.value)">
        </div>
      `).join('')}

      <p>
        <select
          onfocus="editing=true"
          onblur="editing=false"
          onchange="setv('${esc(p.printer_id)}','message',this.value)">
          ${messageOptions(p)}
        </select>
      </p>

      <p>
        ${['green','off','yellow','blue','red'].map(l => `
          <button onclick="setv('${esc(p.printer_id)}','light','${l}')">${l}</button>
        `).join('')}
      </p>

      <pre>${esc(JSON.stringify(p, null, 2))}</pre>
    </div>
  `).join('');
}

load();
setInterval(() => load(false), 1000);
</script>
</body>
</html>'''


async def http_client(states_by_id, reader, writer):
    try:
        req = await reader.read(65536)
        first = req.split(b"\r\n", 1)[0].decode(errors="ignore")
        method, path, _ = (first.split() + ["", ""])[:3]
        parsed = urlparse(path)

        body = b""
        if b"\r\n\r\n" in req:
            body = req.split(b"\r\n\r\n", 1)[1]

        status = "200 OK"
        ctype = "application/json"
        out = b"{}"

        if parsed.path == "/":
            ctype = "text/html"
            out = HTML.encode()

        elif parsed.path == "/api/state":
            out = json.dumps([state_dict(s) for s in states_by_id.values()]).encode()

        elif parsed.path == "/api/set" and method.upper() == "POST":
            data = json.loads(body.decode() or "{}")
            st = states_by_id[data.get("printer_id")]

            for k, v in data.items():
                if k == "light":
                    st.light = str(v)

                elif k == "message":
                    msg = st.msg_by_name_or_id(str(v))
                    if msg:
                        st.current_message_id = msg["message_id"]
                        st.current_message_name = msg["printer_message_name"]

                elif k.startswith("field:"):
                    st.set_field(k.split(":", 1)[1], str(v), allow_unknown=True)

            out = json.dumps({"ok": True}).encode()

        else:
            status = "404 Not Found"
            out = b"not found"
            ctype = "text/plain"

        writer.write(
            f"HTTP/1.1 {status}\r\n"
            f"Content-Type: {ctype}\r\n"
            f"Content-Length: {len(out)}\r\n"
            f"Connection: close\r\n"
            f"\r\n".encode() + out
        )
        await writer.drain()

    finally:
        writer.close()

        try:
            await writer.wait_closed()
        except Exception:
            pass


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--ui-host")
    ap.add_argument("--ui-port", type=int)
    args = ap.parse_args()

    cfg, states = load_config(args.config)
    states_by_id = {s.printer_id: s for s in states}

    servers = []

    ui = cfg.get("ui", {})
    ui_host = args.ui_host or ui.get("host", "0.0.0.0")
    ui_port = args.ui_port or int(ui.get("port", 8098))

    srv = await asyncio.start_server(
        lambda r, w: http_client(states_by_id, r, w),
        ui_host,
        ui_port,
    )
    servers.append(srv)

    print(f"Dashboard    HTTP  listening on http://{ui_host}:{ui_port}")

    for st in states:
        srv = await asyncio.start_server(
            lambda r, w, s=st: client(s, r, w),
            st.host,
            st.port,
        )
        servers.append(srv)

        print(
            f"{st.printer_id:<12} {st.protocol.upper():<5} listening on "
            f"{st.host}:{st.port} current='{st.current_message_name}' "
            f"fields={[f['printer_field_name'] for f in st.active_fields()]}"
        )

    print(f"\nUI:          open http://127.0.0.1:{ui_port}")
    print("WSI test:    printf '\\x02Q\\x03' | nc -w 2 127.0.0.1 3101 | xxd")
    print("WSI update:  printf '\\x02UBATCH\\nTBUNDRC-55\\x03' | nc -w 2 127.0.0.1 3101 | xxd")
    print("NGPCL test:  printf '{~JR|}\\r' | nc -w 2 127.0.0.1 21000 | xxd")
    print("Status:      printf '{~DR|}\\r' | nc -w 2 127.0.0.1 21000 | xxd")
    print("Stop:        Ctrl+C\n", flush=True)

    stop = asyncio.Event()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            asyncio.get_running_loop().add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass

    await stop.wait()

    for s in servers:
        s.close()
        await s.wait_closed()


if __name__ == "__main__":
    asyncio.run(main())