const allData = [];
let activeFilter = "all";
let monitoringEnabled = false;
let currentSessionId = null;
let selectedSessionId = null;
let sessions = [];
let ws = null;

function getStatus(t, h) {
  if (t >= 35 || t < 20) {
    return {
      cls: "s-bad",
      icon: "[X]",
      title: "Di Luar Batas Aman",
      desc: "Suhu ekstrem (>= 35 C atau < 24 C). Segera periksa ruangan.",
      badge: "bad",
      badgeText: "Bahaya",
    };
  }
  if (t >= 24 && t <= 32) {
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
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="badge b-${s.badge}">${s.icon} ${s.badgeText}</span>
          <span style="font-size:11px;color:var(--muted)">[${d.presenceStatus || "empty"}]</span>
        </div>
      </td>
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
  // presence buttons remain enabled; user can choose session when needed
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

function ingest(temp, humi, timeStr, ts, presenceStatus) {
  allData.push({
    temp,
    humi,
    time: timeStr || new Date().toLocaleTimeString("id-ID", { hour12: false }),
    ts: ts || Date.now(),
    presenceStatus: presenceStatus || "empty",
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
      ingest(+t, +h, str, ts, d.presenceStatus || d.presencestatus || "empty");
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
      allData.push({
        temp: +row.temp,
        humi: +row.humi,
        time: str,
        ts,
        presenceStatus: row.presenceStatus || "empty",
      });
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

let mlDbscanChart = null;
let mlRfChart = null;
let mlXgbChart = null;

async function analyzeSession() {
  const sessionId = selectedSessionId || currentSessionId;
  if (!sessionId) {
    alert("Silakan pilih sesi terlebih dahulu.");
    return;
  }

  const btn = document.getElementById("btnAnalyze");
  btn.disabled = true;
  btn.textContent = "⏳ Menganalisis...";

  try {
    const res = await fetch(`/api/session/${sessionId}/analyze`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || data.detail || "Gagal menganalisis sesi");
    }

    document.getElementById("mlAnalysisSection").style.display = "block";
    renderMlCharts(data);
  } catch (err) {
    alert("Error: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "🧠 Analisis Sesi";
  }
}

function renderMlCharts(data) {
  if (mlDbscanChart) mlDbscanChart.destroy();
  if (mlRfChart) mlRfChart.destroy();
  if (mlXgbChart) mlXgbChart.destroy();

  const dbscanData = data.dbscan || [];
  const normalPoints = dbscanData
    .filter((d) => !d.anomaly)
    .map((d) => ({ x: d.x, y: d.y }));
  const anomalyPoints = dbscanData
    .filter((d) => d.anomaly)
    .map((d) => ({ x: d.x, y: d.y }));

  mlDbscanChart = new Chart(document.getElementById("mlDbscanChart"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "Normal", data: normalPoints, backgroundColor: "#0369a1" },
        {
          label: "Anomali",
          data: anomalyPoints,
          backgroundColor: "#dc2626",
          pointRadius: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { title: { display: true, text: "Suhu (°C)" } },
        y: { title: { display: true, text: "Kelembapan (%)" } },
      },
    },
  });

  const rfData = data.random_forest || {};
  const rfLabels = Object.keys(rfData);
  const rfValues = Object.values(rfData);

  mlRfChart = new Chart(document.getElementById("mlRfChart"), {
    type: "doughnut",
    data: {
      labels: rfLabels,
      datasets: [
        {
          data: rfValues,
          backgroundColor: ["#16a34a", "#eab308", "#ef4444", "#3b82f6"],
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: {
          callbacks: { label: (ctx) => `${ctx.label}: ${ctx.raw.toFixed(1)}%` },
        },
      },
    },
  });

  const xgbData = data.xgboost || { waktu: [], aktual: [], prediksi: [] };
  const labels = xgbData.waktu.map((t) => {
    const parts = t.split(" ");
    return parts.length > 1 ? parts[1].substring(0, 5) : t.substring(0, 5);
  });

  mlXgbChart = new Chart(document.getElementById("mlXgbChart"), {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Suhu Aktual",
          data: xgbData.aktual,
          borderColor: "#94a3b8",
          borderWidth: 2,
          fill: false,
          pointRadius: 0,
          tension: 0.1,
        },
        {
          label: "Trend XGBoost",
          data: xgbData.prediksi,
          borderColor: "#c2410c",
          borderWidth: 3,
          fill: false,
          pointRadius: 0,
          tension: 0.4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: { title: { display: true, text: "Suhu (°C)" } },
        x: { ticks: { maxTicksLimit: 10 } },
      },
    },
  });
}

function bindControls() {
  document
    .getElementById("btnStart")
    .addEventListener("click", startMonitoring);
  document.getElementById("btnStop").addEventListener("click", stopMonitoring);
  document
    .getElementById("btnAnalyze")
    .addEventListener("click", analyzeSession);
  const btnOcc = document.getElementById("btnMarkOccupied");
  const btnEmp = document.getElementById("btnMarkEmpty");
  if (btnOcc)
    btnOcc.addEventListener("click", () =>
      applyPresenceToSession(selectedSessionId || currentSessionId, "occupied"),
    );
  if (btnEmp)
    btnEmp.addEventListener("click", () =>
      applyPresenceToSession(selectedSessionId || currentSessionId, "empty"),
    );
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

async function applyPresenceToSession(sessionId, status) {
  let sid = sessionId;
  if (!sid) {
    const input = prompt(
      "Masukkan session id (kosong = gunakan session aktif):",
      currentSessionId || "",
    );
    if (input === null) return; // user cancelled
    if (String(input).trim() === "") {
      sid = currentSessionId;
    } else {
      const parsed = Number(input);
      if (!Number.isFinite(parsed)) {
        alert("Session id tidak valid");
        return;
      }
      sid = parsed;
    }
  }
  if (!sid) {
    alert("Tidak ada session yang dipilih atau aktif.");
    return;
  }

  if (!confirm(`Terapkan status '${status}' ke seluruh data sesi #${sid}?`))
    return;
  try {
    const r = await fetch(`/api/sessions/${sid}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Gagal menerapkan status");
    alert(`Berhasil: semua data sesi #${sid} diberi status ${status}`);
    // reload history for the selected session
    resetData();
    await loadHistory(sid);
    refreshSessions();
  } catch (e) {
    alert("Error: " + e.message);
  }
}
