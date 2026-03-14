/* ==========================================================================
   sys/dash -- Dashboard App Logic
   Polls /api/stats every 1s and updates the DOM + sparklines.
   No frameworks, no build tools. Pure vanilla JS.
   ========================================================================== */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const POLL_MS = 1000;
  const SPARK_HISTORY = 60; // data points kept for sparklines

  // ---------------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);

  const dom = {
    connStatus:  $("#conn-status"),
    statusText:  $(".status-text"),
    clock:       $("#clock"),
    uptime:      $("#uptime"),
    loadavg:     $("#loadavg"),
    cpuCount:    $("#cpu-count"),
    cpuPct:      $("#cpu-pct"),
    cpuBar:      $("#cpu-bar"),
    cpuCard:     $(".card--cpu"),
    memPct:      $("#mem-pct"),
    memBar:      $("#mem-bar"),
    memUsed:     $("#mem-used"),
    memAvail:    $("#mem-avail"),
    memTotal:    $("#mem-total"),
    diskPct:     $("#disk-pct"),
    diskBar:     $("#disk-bar"),
    diskUsed:    $("#disk-used"),
    diskFree:    $("#disk-free"),
    diskTotal:   $("#disk-total"),
    netRx:       $("#net-rx"),
    netRxUnit:   $("#net-rx-unit"),
    netTx:       $("#net-tx"),
    netTxUnit:   $("#net-tx-unit"),
    lastUpdate:  $("#last-update"),
    cpuSpark:    $("#cpu-spark"),
    rxSpark:     $("#rx-spark"),
    txSpark:     $("#tx-spark"),
  };

  // ---------------------------------------------------------------------------
  // Sparkline history buffers
  // ---------------------------------------------------------------------------
  const history = {
    cpu: [],
    rx:  [],
    tx:  [],
  };

  // ---------------------------------------------------------------------------
  // Formatters
  // ---------------------------------------------------------------------------

  /** Format bytes into a human-readable string (e.g. 3.2 GiB). */
  function fmtBytes(b) {
    if (b == null) return "--";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 1) + " " + units[i];
  }

  /** Format a rate (bytes/sec) with auto-scaling unit. Returns {value, unit}. */
  function fmtRate(bps) {
    if (bps == null) return { value: "0", unit: "B/s" };
    const units = ["B/s", "KB/s", "MB/s", "GB/s"];
    let i = 0;
    let v = bps;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return { value: v.toFixed(i === 0 ? 0 : 1), unit: units[i] };
  }

  /** Format uptime seconds into a human-readable string. */
  function fmtUptime(sec) {
    if (sec == null) return "---";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const parts = [];
    if (d > 0) parts.push(d + "d");
    if (h > 0) parts.push(h + "h");
    if (m > 0) parts.push(m + "m");
    parts.push(s + "s");
    return parts.join(" ");
  }

  /** Current wall-clock time as HH:MM:SS. */
  function clockStr() {
    const now = new Date();
    return [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
  }

  // ---------------------------------------------------------------------------
  // Sparkline drawing
  // ---------------------------------------------------------------------------

  /**
   * Draw a filled sparkline on a canvas.
   * @param {HTMLCanvasElement} canvas
   * @param {number[]} data      - values (0..max auto-scaled)
   * @param {string}   color     - stroke/fill CSS color
   */
  function drawSpark(canvas, data, color) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    // Ensure canvas buffer matches display size
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (data.length < 2) return;

    const max = Math.max(...data, 1); // avoid division by zero
    const step = w / (SPARK_HISTORY - 1);
    const padding = 2;

    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = i * step;
      const y = h - padding - ((data[i] / max) * (h - padding * 2));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    // Stroke
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();

    // Fill gradient beneath
    const lastX = (data.length - 1) * step;
    ctx.lineTo(lastX, h);
    ctx.lineTo(0, h);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color.replace(")", ", 0.25)").replace("rgb", "rgba"));
    grad.addColorStop(1, color.replace(")", ", 0.0)").replace("rgb", "rgba"));
    // Fallback for hex colors
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.3;
    ctx.fill();
    ctx.globalAlpha = 1.0;
  }

  // Hex to rgba helper for sparkline fills
  function hexToRGBA(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /** Draw sparkline with hex color support. */
  function drawSparkHex(canvas, data, hexColor) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (data.length < 2) return;

    const max = Math.max(...data, 1);
    const step = w / (SPARK_HISTORY - 1);
    const pad = 2;

    // Build path
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = i * step;
      const y = h - pad - ((data[i] / max) * (h - pad * 2));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }

    ctx.strokeStyle = hexColor;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();

    // Fill
    const lastX = (data.length - 1) * step;
    ctx.lineTo(lastX, h);
    ctx.lineTo(0, h);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hexToRGBA(hexColor, 0.25));
    grad.addColorStop(1, hexToRGBA(hexColor, 0.0));
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // ---------------------------------------------------------------------------
  // Update DOM from API response
  // ---------------------------------------------------------------------------

  function update(data) {
    // Connection status
    dom.connStatus.classList.add("live");
    dom.statusText.textContent = "live";

    // CPU
    const cpuPct = data.cpu_percent != null ? data.cpu_percent : 0;
    dom.cpuPct.textContent = cpuPct.toFixed(1);
    dom.cpuBar.style.width = Math.min(cpuPct, 100) + "%";

    // CPU warning glow at high usage
    dom.cpuCard.classList.toggle("warn", cpuPct > 90);

    // CPU count
    dom.cpuCount.textContent = data.cpu_count != null ? data.cpu_count : "-";

    // Load average
    if (data.loadavg) {
      dom.loadavg.textContent = data.loadavg.map((v) => v.toFixed(2)).join("  ");
    } else {
      dom.loadavg.textContent = "---";
    }

    // Uptime
    dom.uptime.textContent = fmtUptime(data.uptime_seconds);

    // Memory
    const memTotal = data.mem_total;
    const memAvail = data.mem_available;
    const memUsed = memTotal != null && memAvail != null ? memTotal - memAvail : null;
    const memPct = memTotal ? ((memUsed / memTotal) * 100) : 0;
    dom.memPct.textContent = memPct.toFixed(1);
    dom.memBar.style.width = Math.min(memPct, 100) + "%";
    dom.memUsed.textContent = fmtBytes(memUsed);
    dom.memAvail.textContent = fmtBytes(memAvail);
    dom.memTotal.textContent = fmtBytes(memTotal);

    // Disk
    const diskTotal = data.disk_total;
    const diskUsed = data.disk_used;
    const diskFree = diskTotal != null && diskUsed != null ? diskTotal - diskUsed : null;
    const diskPct = diskTotal ? ((diskUsed / diskTotal) * 100) : 0;
    dom.diskPct.textContent = diskPct.toFixed(1);
    dom.diskBar.style.width = Math.min(diskPct, 100) + "%";
    dom.diskUsed.textContent = fmtBytes(diskUsed);
    dom.diskFree.textContent = fmtBytes(diskFree);
    dom.diskTotal.textContent = fmtBytes(diskTotal);

    // Network
    const rx = fmtRate(data.net_rx_rate);
    const tx = fmtRate(data.net_tx_rate);
    dom.netRx.textContent = rx.value;
    dom.netRxUnit.textContent = rx.unit;
    dom.netTx.textContent = tx.value;
    dom.netTxUnit.textContent = tx.unit;

    // Sparkline history
    history.cpu.push(cpuPct);
    history.rx.push(data.net_rx_rate || 0);
    history.tx.push(data.net_tx_rate || 0);
    if (history.cpu.length > SPARK_HISTORY) history.cpu.shift();
    if (history.rx.length > SPARK_HISTORY)  history.rx.shift();
    if (history.tx.length > SPARK_HISTORY)  history.tx.shift();

    drawSparkHex(dom.cpuSpark, history.cpu, "#e8a832");
    drawSparkHex(dom.rxSpark,  history.rx,  "#34d399");
    drawSparkHex(dom.txSpark,  history.tx,  "#f472b6");

    // Footer timestamp
    const ts = data.timestamp ? new Date(data.timestamp * 1000) : new Date();
    dom.lastUpdate.textContent = "last update: " + ts.toLocaleTimeString();
  }

  // ---------------------------------------------------------------------------
  // Polling loop
  // ---------------------------------------------------------------------------

  let failCount = 0;

  async function poll() {
    try {
      const resp = await fetch("/hello?format=json");
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      failCount = 0;
      update(data);
    } catch (err) {
      failCount++;
      if (failCount > 3) {
        dom.connStatus.classList.remove("live");
        dom.statusText.textContent = "offline";
      }
    }
  }

  // Clock tick (runs independently of API polling)
  function tickClock() {
    dom.clock.textContent = clockStr();
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  tickClock();
  setInterval(tickClock, 1000);

  // Initial poll, then interval
  poll();
  setInterval(poll, POLL_MS);
})();
