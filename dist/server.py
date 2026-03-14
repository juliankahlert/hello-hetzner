#!/usr/bin/env python3
"""Distribution server exposing a single negotiated /hello endpoint."""

import json
import mimetypes
import os
import shutil
import socket
import threading
import time
from http.server import SimpleHTTPRequestHandler
from socketserver import ThreadingTCPServer
from typing import Optional
from urllib.parse import parse_qs, urlsplit


HOST = "0.0.0.0"
PORT = 4001
STATIC_DIR = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
)
SAMPLE_INTERVAL = 0.5


def _read_proc(path):
    """Read a /proc file and return its text, or None on failure."""
    try:
        with open(path, "r", encoding="utf-8") as file_obj:
            return file_obj.read()
    except OSError:
        return None


def read_cpu_times():
    """Return aggregate CPU tick counters from /proc/stat, or None."""
    text = _read_proc("/proc/stat")
    if text is None:
        return None

    for line in text.splitlines():
        if line.startswith("cpu "):
            parts = line.split()
            return tuple(int(part) for part in parts[1:8])
    return None


def read_meminfo():
    """Return memory info from /proc/meminfo as bytes."""
    text = _read_proc("/proc/meminfo")
    if text is None:
        return {}

    info = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, rest = line.split(":", 1)
        parts = rest.split()
        if not parts:
            continue
        value = int(parts[0])
        if len(parts) > 1 and parts[1] == "kB":
            value *= 1024
        info[key.strip()] = value
    return info


def read_net_bytes():
    """Return total RX/TX bytes across non-loopback interfaces, or None."""
    text = _read_proc("/proc/net/dev")
    if text is None:
        return None

    rx_total = 0
    tx_total = 0
    for line in text.splitlines()[2:]:
        if ":" not in line:
            continue
        iface, data = line.split(":", 1)
        if iface.strip() == "lo":
            continue
        cols = data.split()
        if len(cols) >= 9:
            rx_total += int(cols[0])
            tx_total += int(cols[8])
    return rx_total, tx_total


def read_uptime():
    """Return uptime in seconds from /proc/uptime, or None."""
    text = _read_proc("/proc/uptime")
    if text is None:
        return None
    try:
        return float(text.split()[0])
    except (IndexError, ValueError):
        return None


def read_loadavg():
    """Return [1min, 5min, 15min] load averages, or None."""
    try:
        return [round(value, 2) for value in os.getloadavg()]
    except OSError:
        return None


def read_cpu_count():
    """Return the number of logical CPUs."""
    return os.cpu_count() or 1


def read_disk_usage(path="/"):
    """Return (total, used) bytes for the given path, or (None, None)."""
    try:
        usage = shutil.disk_usage(path)
        return usage.total, usage.used
    except OSError:
        return None, None


class StatsSampler(threading.Thread):
    """Background sampler that maintains the latest system metrics snapshot."""

    def __init__(self, interval=SAMPLE_INTERVAL):
        super().__init__(daemon=True)
        self.interval = interval
        self.snapshot = self._empty_snapshot()
        self._lock = threading.Lock()

    @staticmethod
    def _empty_snapshot():
        return {
            "cpu_percent": 0.0,
            "cpu_count": read_cpu_count(),
            "loadavg": None,
            "mem_total": None,
            "mem_available": None,
            "disk_total": None,
            "disk_used": None,
            "uptime_seconds": None,
            "net_rx_rate": 0.0,
            "net_tx_rate": 0.0,
            "timestamp": time.time(),
        }

    @staticmethod
    def _cpu_percent(previous, current):
        """Compute CPU percentage from two aggregate CPU samples."""
        if previous is None or current is None:
            return 0.0

        previous_idle = previous[3]
        current_idle = current[3]
        previous_total = sum(previous)
        current_total = sum(current)
        diff_idle = current_idle - previous_idle
        diff_total = current_total - previous_total

        if diff_total == 0:
            return 0.0
        return round((1.0 - diff_idle / diff_total) * 100.0, 1)

    def run(self):
        previous_cpu = read_cpu_times()
        previous_net = read_net_bytes()
        previous_time = time.monotonic()

        while True:
            time.sleep(self.interval)

            now = time.monotonic()
            elapsed = now - previous_time
            if elapsed <= 0:
                elapsed = self.interval

            current_cpu = read_cpu_times()
            cpu_percent = self._cpu_percent(previous_cpu, current_cpu)
            previous_cpu = current_cpu

            meminfo = read_meminfo()
            disk_total, disk_used = read_disk_usage("/")
            uptime = read_uptime()

            current_net = read_net_bytes()
            rx_rate = 0.0
            tx_rate = 0.0
            if previous_net and current_net:
                rx_rate = round((current_net[0] - previous_net[0]) / elapsed, 1)
                tx_rate = round((current_net[1] - previous_net[1]) / elapsed, 1)
            previous_net = current_net
            previous_time = now

            snapshot = {
                "cpu_percent": cpu_percent,
                "cpu_count": read_cpu_count(),
                "loadavg": read_loadavg(),
                "mem_total": meminfo.get("MemTotal"),
                "mem_available": meminfo.get("MemAvailable"),
                "disk_total": disk_total,
                "disk_used": disk_used,
                "uptime_seconds": int(uptime) if uptime is not None else None,
                "net_rx_rate": rx_rate,
                "net_tx_rate": tx_rate,
                "timestamp": time.time(),
            }

            with self._lock:
                self.snapshot = snapshot

    def get_snapshot(self):
        with self._lock:
            return dict(self.snapshot)


class DistributionHandler(SimpleHTTPRequestHandler):
    """Serve dashboard HTML, stats JSON, and static assets on /hello."""

    sampler: Optional[StatsSampler] = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path != "/hello":
            self._send_text_response(404, b"Not Found\n")
            return

        query = parse_qs(parsed.query, keep_blank_values=True)
        if "file" in query:
            self._serve_static_file(query.get("file", [""])[0])
            return

        requested_format = query.get("format", [""])[0].lower()
        accept_header = (self.headers.get("Accept") or "").lower()

        if requested_format == "json" or "application/json" in accept_header:
            self._serve_stats()
            return

        if not accept_header or "text/html" in accept_header or "*/*" in accept_header:
            self._serve_index()
            return

        self._send_text_response(406, b"Not Acceptable\n")

    def _send_text_response(self, status, body, content_type="text/plain; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_stats(self):
        snapshot = self.sampler.get_snapshot() if self.sampler else {}
        body = json.dumps(snapshot, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_index(self):
        index_path = os.path.join(STATIC_DIR, "index.html")
        try:
            with open(index_path, "rb") as file_obj:
                body = file_obj.read()
        except OSError:
            self._send_text_response(404, b"Not Found\n")
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_static_file(self, requested_file):
        if not requested_file or os.path.isabs(requested_file):
            self._send_text_response(404, b"Not Found\n")
            return

        normalized_path = os.path.normpath(requested_file)
        file_path = os.path.abspath(os.path.join(STATIC_DIR, normalized_path))

        try:
            if os.path.commonpath([STATIC_DIR, file_path]) != STATIC_DIR:
                raise ValueError
        except ValueError:
            self._send_text_response(404, b"Not Found\n")
            return

        if not os.path.isfile(file_path):
            self._send_text_response(404, b"Not Found\n")
            return

        try:
            with open(file_path, "rb") as file_obj:
                body = file_obj.read()
        except OSError:
            self._send_text_response(404, b"Not Found\n")
            return

        content_type, content_encoding = mimetypes.guess_type(file_path)
        self.send_response(200)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        if content_encoding:
            self.send_header("Content-Encoding", content_encoding)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


def _guess_local_ip():
    """Best-effort guess of the machine's LAN IP for display."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
        finally:
            sock.close()
    except OSError:
        return "localhost"


def main():
    sampler = StatsSampler()
    sampler.start()

    DistributionHandler.sampler = sampler
    ThreadingTCPServer.allow_reuse_address = True
    server = ThreadingTCPServer((HOST, PORT), DistributionHandler)

    local_ip = _guess_local_ip()
    print(f"Distribution server running on http://{local_ip}:{PORT}/hello")
    print("Press Ctrl+C to stop.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
