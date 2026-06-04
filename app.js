const allData = [];
let activeFilter = "all";
let monitoringEnabled = false;
let currentSessionId = null;
let selectedSessionId = null;
let sessions = [];
let ws = null;

function getStatus(t, h) {
  if (t >= 35 || t < 24) {
    return {
      cls: "s-bad",
      icon: "[X]",
      title: "Di Luar Batas Aman",
      desc: "Suhu ekstrem (>= 35 C atau < 24 C). Segera periksa ruangan.",
      badge: "bad",
      badgeText: "Bahaya",
    };
  }
  if (t >= 20 && t <= 30) {
    return {
      cls: "s-ok",
      icon: "[OK]",
      title: "Kondisi Ideal",
      desc: "Suhu ruangan dalam batas nyaman untuk bayi.",
      badge: "ok",
      badgeText: "Ideal",
    };
  }
  return {
    cls: "s-warn",
    icon: "[!]",
    title: "Perlu Diperhatikan",
    desc: "Suhu mulai tidak ideal, pantau kondisi ruangan.",
    badge: "warn",
    badgeText: "Perhatian",
  };
}

function mean5min() {
  const now = Date.now();
  const win = allData.filter((d) => now - d.ts <= 5 * 60 * 1000);
  if (!win.length) return null;
  const t = win.reduce((s, d) => s + d.temp, 0) / win.length;
  const h = win.reduce((s, d) => s + d.humi, 0) / win.length;
  return { temp: +t.toFixed(1), humi: +h.toFixed(1) };
}

const chart = new Chart(document.getElementById("trendChart"), {
  type: "line",
  data: {
    labels: [],
    datasets: [
      {
        label: "Suhu (C)",
        data: [],
        borderColor: "#c2410c",
        backgroundColor: "rgba(194,65,12,.08)",
        yAxisID: "y",
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.4,
      },
      {
        label: "Kelembapan (%)",
        data: [],
        borderColor: "#0369a1",
        backgroundColor: "rgba(3,105,161,.08)",
        yAxisID: "y1",
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.4,
      },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false } },
    scales: {
      y: {
        position: "left",
        grid: { color: "rgba(0,0,0,.05)" },
        ticks: { font: { size: 11 }, callback: (v) => v + " C" },
      },
      y1: {
        position: "right",
        grid: { drawOnChartArea: false },
        ticks: { font: { size: 11 }, callback: (v) => v + "%" },
      },
      x: {
        grid: { display: false },
        ticks: {
          font: { size: 10 },
          maxTicksLimit: 7,
          maxRotation: 0,
        },
      },
    },
  },
});

function updateChart() {
  const src = filtered();

  chart.data.labels = src.map((d) => {
    const parts = d.time.split(" ");
    const timePart = parts.length > 1 ? parts[1] : d.time;
    return timePart.substring(0, 5);
  });

  chart.data.datasets[0].data = src.map((d) => d.temp);
  chart.data.datasets[1].data = src.map((d) => d.humi);
  document.getElementById("chartSub").textContent =
    src.length + " pembacaan ditampilkan";
  chart.update("none");
}

function filtered() {
  return activeFilter === "all"
    ? allData
    : allData.filter((d) => getStatus(d.temp, d.humi).badge === activeFilter);
}

function renderLog() {
  const src = [...filtered()].reverse().slice(0, 100);
  const lb = document.getElementById("logBody");
  if (!src.length) {
    lb.innerHTML =
      '<tr><td colspan="4" class="empty-state">Tidak ada data untuk filter ini</td></tr>';
    return;
  }
  lb.innerHTML = src
    .map((d) => {
      const s = getStatus(d.temp, d.humi);
      return `<tr>
      <td class="td-time">${d.time}</td>
      <td class="td-val v-temp">${d.temp.toFixed(1)} °C</td>
      <td class="td-val v-humi">${d.humi.toFixed(1)} %</td>
      <td><span class="badge b-${s.badge}">${s.icon} ${s.badgeText}</span></td>
    </tr>`;
    })
    .join("");
  document.getElementById("historyCount").textContent =
    filtered().length + " data tersimpan";
}

function setFilter(f) {
  activeFilter = f;
  document
    .querySelectorAll(".filter-btn")
    .forEach((b) => b.classList.remove("active"));
  document
    .getElementById({ all: "fAll", ok: "fOk", warn: "fWarn", bad: "fBad" }[f])
    .classList.add("active");
  updateChart();
  renderLog();
}

function updateSessionLabel() {
  const labelId = selectedSessionId || currentSessionId;
  document.getElementById("sessionLabel").textContent = labelId
    ? `Sesi: #${labelId}`
    : "Sesi: —";
  const dl = document.getElementById("btnDownload");
  if (labelId) {
    dl.href = `/download/session?sessionId=${labelId}`;
    dl.classList.remove("link-disabled");
  } else {
    dl.href = "/download/session";
    dl.classList.add("link-disabled");
  }
}

function formatSessionTime(raw) {
  if (!raw) return "—";
  const parsed = new Date(String(raw).replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function renderSessions() {
  const list = document.getElementById("sessionList");
  if (!sessions.length) {
    list.innerHTML =
      '<div class="session-empty">Belum ada sesi monitoring</div>';
    return;
  }

  list.innerHTML = sessions
    .map((s) => {
      const isSelected = selectedSessionId === s.id;
      const isActive = !s.endTime;
      const cls = [
        "session-item",
        isSelected ? "is-selected" : "",
        isActive ? "is-active" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const badgeClass = isActive ? "badge-active" : "badge-ended";
      const badgeText = isActive ? "Aktif" : "Selesai";
      return `<button class="${cls}" data-id="${s.id}" type="button">
        <div class="session-main">
          <div class="session-title">Sesi #${s.id}</div>
          <div class="session-time">Mulai: ${formatSessionTime(
            s.startTime,
          )}</div>
          <div class="session-time">Selesai: ${formatSessionTime(
            s.endTime,
          )}</div>
        </div>
        <div class="session-actions">
          <div class="session-badge ${badgeClass}">${badgeText}</div>
          <button class="session-delete" data-id="${s.id}" type="button">
            Hapus
          </button>
        </div>
      </button>`;
    })
    .join("");
}

async function refreshSessions() {
  try {
    const r = await fetch("/api/sessions");
    const rows = await r.json();
    sessions = Array.isArray(rows)
      ? rows.map((row) => ({
          id: Number(row.id),
          startTime: row.startTime,
          endTime: row.endTime,
        }))
      : [];
  } catch {
    sessions = [];
  }
  if (selectedSessionId && !sessions.some((s) => s.id === selectedSessionId)) {
    selectedSessionId = currentSessionId;
    resetData();
    if (selectedSessionId) {
      await loadHistory(selectedSessionId);
    }
    updateSessionLabel();
  }
  renderSessions();
}

async function selectSession(sessionId) {
  if (!sessionId) return;
  selectedSessionId = sessionId;
  updateSessionLabel();
  resetData();
  await loadHistory(sessionId);
  renderSessions();
}

async function deleteSession(sessionId) {
  if (!sessionId) return;
  const ok = window.confirm(`Hapus sesi #${sessionId}? Data akan dihapus.`);
  if (!ok) return;
  const r = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
  if (!r.ok) {
    let msg = "Gagal menghapus sesi.";
    try {
      const data = await r.json();
      if (data && data.error) msg = data.error;
    } catch {}
    window.alert(msg);
    return;
  }
  if (selectedSessionId === sessionId) {
    selectedSessionId = null;
  }
  if (currentSessionId === sessionId) {
    currentSessionId = null;
  }
  updateSessionLabel();
  resetData();
  await refreshSessions();
}

function updateCards() {
  if (!allData.length) return;

  const latest = allData[allData.length - 1];
  const s = getStatus(latest.temp, latest.humi);

  document.getElementById("valTemp").textContent = latest.temp.toFixed(1);
  document.getElementById("valHumi").textContent = latest.humi.toFixed(1);

  const tPct = Math.min(100, Math.max(0, ((latest.temp - 20) / 15) * 100));
  const hPct = Math.min(100, Math.max(0, ((latest.humi - 30) / 50) * 100));

  const tColor =
    s.badge === "ok" ? "#16a34a" : s.badge === "warn" ? "#d97706" : "#dc2626";
  document.getElementById("tempBar").style.cssText =
    `width:${tPct}%;background:${tColor}`;
  document.getElementById("humiBar").style.cssText =
    `width:${hPct}%;background:${tColor}`;

  const b = document.getElementById("statusBanner");
  b.className = "status-banner " + s.cls;
  document.getElementById("statusIcon").textContent = s.icon;
  document.getElementById("statusTitle").textContent = s.title;
  document.getElementById("statusDesc").textContent = s.desc;

  const now = new Date();
  document.getElementById("lastUpdate").textContent =
    "Diperbarui " +
    now.toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
}

function ingest(temp, humi, timeStr, ts) {
  allData.push({
    temp,
    humi,
    time: timeStr || new Date().toLocaleTimeString("id-ID", { hour12: false }),
    ts: ts || Date.now(),
  });
  updateCards();
  updateChart();
  renderLog();
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onopen = () => console.log("WS connected");
  ws.onclose = () => {
    setTimeout(connectWs, 3000);
  };

  ws.onmessage = (e) => {
    let d;
    try {
      d = JSON.parse(e.data);
    } catch {
      return;
    }

    if (d.type === "monitoring") {
      monitoringEnabled = d.enabled;
      syncButtons();
      if (d.espOnline !== undefined) setEspStatus(d.espOnline);
    }
    if (d.type === "session") {
      currentSessionId = d.sessionId || null;
      if (d.active && currentSessionId) {
        selectedSessionId = currentSessionId;
      }
      updateSessionLabel();
      if (d.active && currentSessionId) {
        resetData();
        loadHistory(currentSessionId);
      }
      refreshSessions();
    }
    if (d.type === "esp_status") setEspStatus(d.status === "online");
    if (d.type === "app_status") console.log(d.message);

    const t =
      d.temp !== undefined
        ? d.temp
        : d.temperature !== undefined
          ? d.temperature
          : d.t;
    const h =
      d.humi !== undefined
        ? d.humi
        : d.humidity !== undefined
          ? d.humidity
          : d.h;
    if (t != null && h != null) {
      if (
        selectedSessionId &&
        d.sessionId &&
        Number(d.sessionId) !== Number(selectedSessionId)
      ) {
        return;
      }
      const ts = d.waktu ? new Date(d.waktu).getTime() : Date.now();
      const str = d.waktu
        ? new Date(d.waktu).toLocaleString("id-ID", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          })
        : new Date().toLocaleTimeString("id-ID", { hour12: false });
      ingest(+t, +h, str, ts);
    }
  };
}

function setEspStatus(online) {
  document.getElementById("espDot").className =
    "esp-dot" + (online ? " online" : "");
  document.getElementById("espLabel").textContent = online
    ? "Sensor terhubung"
    : "Sensor tidak terhubung";
}

function syncButtons() {
  document.getElementById("btnStart").disabled = monitoringEnabled;
  document.getElementById("btnStop").disabled = !monitoringEnabled;
}

function resetData() {
  allData.length = 0;
  updateChart();
  renderLog();
}

async function startMonitoring() {
  const r = await fetch("/api/control/start", { method: "POST" });
  const d = await r.json();
  monitoringEnabled = true;
  currentSessionId = d.sessionId || null;
  selectedSessionId = currentSessionId;
  updateSessionLabel();
  resetData();
  if (currentSessionId) await loadHistory(currentSessionId);
  syncButtons();
  refreshSessions();
}

async function stopMonitoring() {
  const r = await fetch("/api/control/stop", { method: "POST" });
  const d = await r.json();
  monitoringEnabled = false;
  currentSessionId = d.sessionId || currentSessionId;
  updateSessionLabel();
  syncButtons();
  refreshSessions();
}

async function loadHistory(sessionId) {
  try {
    const r = await fetch(`/api/history?limit=500&sessionId=${sessionId}`);
    const rows = await r.json();
    rows.forEach((row) => {
      const ts = row.time ? new Date(row.time).getTime() : Date.now();
      const str = row.time
        ? new Date(row.time).toLocaleString("id-ID", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          })
        : "—";
      allData.push({ temp: +row.temp, humi: +row.humi, time: str, ts });
    });
    if (allData.length) {
      updateCards();
      updateChart();
      renderLog();
    }
  } catch (e) {
    console.warn("History load failed", e);
  }
}

async function bootstrap() {
  try {
    const s = await fetch("/api/control/status");
    const d = await s.json();
    monitoringEnabled = d.monitoringEnabled;
    setEspStatus(d.espOnline);
    currentSessionId = d.currentSessionId || null;
    selectedSessionId = currentSessionId;
    updateSessionLabel();
    syncButtons();
  } catch {}

  await refreshSessions();

  if (selectedSessionId) {
    await loadHistory(selectedSessionId);
  }

  connectWs();
}

function bindControls() {
  document
    .getElementById("btnStart")
    .addEventListener("click", startMonitoring);
  document.getElementById("btnStop").addEventListener("click", stopMonitoring);
  document
    .getElementById("fAll")
    .addEventListener("click", () => setFilter("all"));
  document
    .getElementById("fOk")
    .addEventListener("click", () => setFilter("ok"));
  document
    .getElementById("fWarn")
    .addEventListener("click", () => setFilter("warn"));
  document
    .getElementById("fBad")
    .addEventListener("click", () => setFilter("bad"));

  document.getElementById("sessionList").addEventListener("click", (e) => {
    const delBtn = e.target.closest(".session-delete");
    if (delBtn) {
      e.stopPropagation();
      const delId = Number(delBtn.dataset.id);
      if (Number.isFinite(delId)) deleteSession(delId);
      return;
    }
    const btn = e.target.closest(".session-item");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (!Number.isFinite(id)) return;
    selectSession(id);
  });
}

bindControls();
bootstrap();
