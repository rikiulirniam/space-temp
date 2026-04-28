const fs = require("fs");
const path = require("path");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const sqlite3 = require("sqlite3").verbose();

const PORT = 8080;
const INDEX_FILE = path.join(__dirname, "index.html");
const DB_FILE = path.join(__dirname, "monitoring.db");

// ─── DATABASE ────────────────────────────────────────────────────────────────
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error("❌ Database Error:", err.message);
  else console.log("✅ SQLite connected.");
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS sensor_data (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    waktu     DATETIME DEFAULT (datetime('now','localtime')),
    suhu      REAL,
    kelembapan REAL
  )`);
  db.run(
    `ALTER TABLE sensor_data ADD COLUMN presence_status TEXT DEFAULT 'empty'`,
    (err) => {
      // Ignore duplicate-column errors on existing databases.
      if (err && !String(err.message || "").includes("duplicate column")) {
        console.error("❌ Failed adding presence_status column:", err.message);
      }
    },
  );
  db.run(`CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
  )`);
  db.run(
    `INSERT OR IGNORE INTO app_settings (key,value) VALUES ('monitoring_enabled','0')`,
  );
  db.run(`CREATE TABLE IF NOT EXISTS presence_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    status    TEXT NOT NULL CHECK(status IN ('occupied','empty')),
    note      TEXT,
    waktu     DATETIME DEFAULT (datetime('now','localtime'))
  )`);
  db.run(
    `INSERT OR IGNORE INTO app_settings (key,value) VALUES ('presence_status','empty')`,
  );
  db.run(
    `INSERT INTO presence_events (status, note)
     SELECT 'empty', 'initial state'
     WHERE NOT EXISTS (SELECT 1 FROM presence_events LIMIT 1)`,
  );
  db.run(
    `UPDATE sensor_data
     SET presence_status = COALESCE(
       (
         SELECT p.status
         FROM presence_events p
         WHERE p.waktu <= sensor_data.waktu
         ORDER BY p.waktu DESC, p.id DESC
         LIMIT 1
       ),
       'empty'
     )
     WHERE presence_status IS NULL OR presence_status = ''`,
  );
  db.run(`UPDATE app_settings SET value='0' WHERE key='monitoring_enabled'`);
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const sendJson = (res, code, payload) => {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
};

// Track connections: ESP and Dashboard are split by header/query
// ESP32 connects with X-Client-Type: esp header or ?client=esp query
const dashboards = new Set();
let espSocket = null;

const broadcast = (payload, excludeWs = null) => {
  const msg = JSON.stringify(payload);
  dashboards.forEach((ws) => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
};

const sendToEsp = (payload) => {
  if (espSocket && espSocket.readyState === WebSocket.OPEN) {
    espSocket.send(JSON.stringify(payload));
    return true;
  }
  return false;
};

const parseSensorValues = (d) => {
  const t =
    d.temp !== undefined
      ? d.temp
      : d.temperature !== undefined
        ? d.temperature
        : d.t;
  const h =
    d.humi !== undefined ? d.humi : d.humidity !== undefined ? d.humidity : d.h;
  return { t, h };
};

const looksLikeEspPayload = (d) => {
  if (!d || typeof d !== "object") return false;
  if (d.type === "esp_status" || d.type === "esp_ack") return true;
  const vals = parseSensorValues(d);
  return vals.t != null && vals.h != null;
};

const handleEspPayload = (d) => {
  // ESP sends acknowledgement after receiving START/STOP
  if (d.type === "esp_ack") {
    console.log(`✅ ESP ACK: cmd=${d.cmd}, status=${d.status}`);
    broadcast(d);
    return;
  }

  // ESP sends its own status notification (e.g. WiFi connect/disconnect)
  if (d.type === "esp_status") {
    broadcast(d);
    return;
  }

  // Normal sensor data
  const vals = parseSensorValues(d);
  const t = vals.t;
  const h = vals.h;
  if (t == null || h == null) return;

  getMonitoring((err, enabled) => {
    if (err || !enabled) return;
    getCurrentPresence((presenceErr, presenceStatus) => {
      if (presenceErr) return;
      db.run(
        "INSERT INTO sensor_data (suhu,kelembapan,presence_status) VALUES (?,?,?)",
        [t, h, presenceStatus || "empty"],
        function (insertErr) {
          if (insertErr) return;
          // Ambil waktu dari row yang baru saja diinsert
          db.get(
            "SELECT waktu FROM sensor_data WHERE id = ?",
            [this.lastID],
            (selErr, row) => {
              broadcast({
                temp: t,
                humi: h,
                presenceStatus: presenceStatus || "empty",
                waktu: row ? row.waktu : null,
              });
            },
          );
        },
      );
    });
  });
};

const getMonitoring = (cb) =>
  db.get(
    `SELECT value FROM app_settings WHERE key='monitoring_enabled'`,
    (err, row) => cb(err, row ? row.value === "1" : true),
  );

const setMonitoring = (enabled, cb) => {
  db.run(
    `UPDATE app_settings SET value=?,updated_at=datetime('now','localtime') WHERE key='monitoring_enabled'`,
    [enabled ? "1" : "0"],
    (err) => {
      if (!err) broadcast({ type: "monitoring", enabled });
      cb && cb(err);
    },
  );
};

const getCurrentPresence = (cb) =>
  db.get(
    `SELECT value FROM app_settings WHERE key='presence_status'`,
    (err, row) => cb(err, row ? row.value : "empty"),
  );

const setPresence = (status, note, cb) => {
  if (status !== "occupied" && status !== "empty") {
    return cb && cb(new Error("Invalid presence status"));
  }
  db.serialize(() => {
    db.run(
      `UPDATE app_settings SET value=?,updated_at=datetime('now','localtime') WHERE key='presence_status'`,
      [status],
    );
    db.run(
      `INSERT INTO presence_events (status, note) VALUES (?, ?)`,
      [status, note || null],
      (err) => {
        if (!err) {
          broadcast({ type: "presence_status", status, note: note || null });
        }
        cb && cb(err);
      },
    );
  });
};

const getPresenceImpact = (sampleLimit, cb) => {
  db.all(
    `SELECT
      s.suhu AS temp,
      s.kelembapan AS humi,
      COALESCE(
        s.presence_status,
        (
          SELECT p.status
          FROM presence_events p
          WHERE p.waktu <= s.waktu
          ORDER BY p.waktu DESC, p.id DESC
          LIMIT 1
        ),
        'empty'
      ) AS presence_status
    FROM sensor_data s
    ORDER BY s.id DESC
    LIMIT ?`,
    [sampleLimit],
    (err, rows) => {
      if (err) return cb(err);

      const acc = {
        occupied: { count: 0, tempSum: 0, humiSum: 0 },
        empty: { count: 0, tempSum: 0, humiSum: 0 },
      };

      (rows || []).forEach((r) => {
        const key = r.presence_status === "occupied" ? "occupied" : "empty";
        const t = Number(r.temp);
        const h = Number(r.humi);
        if (!Number.isFinite(t) || !Number.isFinite(h)) return;
        acc[key].count += 1;
        acc[key].tempSum += t;
        acc[key].humiSum += h;
      });

      const occupiedAvgTemp =
        acc.occupied.count > 0
          ? acc.occupied.tempSum / acc.occupied.count
          : null;
      const emptyAvgTemp =
        acc.empty.count > 0 ? acc.empty.tempSum / acc.empty.count : null;
      const occupiedAvgHumi =
        acc.occupied.count > 0
          ? acc.occupied.humiSum / acc.occupied.count
          : null;
      const emptyAvgHumi =
        acc.empty.count > 0 ? acc.empty.humiSum / acc.empty.count : null;

      cb(null, {
        samples: {
          occupied: acc.occupied.count,
          empty: acc.empty.count,
          total: acc.occupied.count + acc.empty.count,
        },
        averages: {
          occupied: { temp: occupiedAvgTemp, humi: occupiedAvgHumi },
          empty: { temp: emptyAvgTemp, humi: emptyAvgHumi },
        },
        deltas: {
          temp:
            occupiedAvgTemp != null && emptyAvgTemp != null
              ? occupiedAvgTemp - emptyAvgTemp
              : null,
          humi:
            occupiedAvgHumi != null && emptyAvgHumi != null
              ? occupiedAvgHumi - emptyAvgHumi
              : null,
        },
      });
    },
  );
};

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const { method, url } = req;
  const reqUrl = new URL(url, `http://${req.headers.host || "localhost"}`);
  const pathname = reqUrl.pathname.replace(/\/+$/, "") || "/";
  const historyLimit = Math.max(
    1,
    Math.min(5000, Number(reqUrl.searchParams.get("limit")) || 50),
  );

  // Serve dashboard
  if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return fs.readFile(INDEX_FILE, (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end("Error");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
  }

  // Last 50 history rows
  if (method === "GET" && pathname === "/api/history") {
    return db.all(
      `SELECT
         suhu as temp,
         kelembapan as humi,
         waktu as time,
         COALESCE(presence_status, 'empty') as presenceStatus
       FROM sensor_data
       ORDER BY id DESC
       LIMIT ?`,
      [historyLimit],
      (err, rows) =>
        sendJson(
          res,
          err ? 500 : 200,
          err ? { error: err.message } : (rows || []).reverse(),
        ),
    );
  }

  // Monitoring status
  if (method === "GET" && pathname === "/api/control/status") {
    return getMonitoring((err, enabled) => {
      if (err) return sendJson(res, 500, { error: err.message });
      getCurrentPresence((presenceErr, presenceStatus) => {
        if (presenceErr)
          return sendJson(res, 500, { error: presenceErr.message });
        sendJson(res, 200, {
          monitoringEnabled: enabled,
          espOnline: !!espSocket,
          presenceStatus,
        });
      });
    });
  }

  if (method === "GET" && pathname === "/api/presence/status") {
    return getCurrentPresence((err, status) =>
      sendJson(res, err ? 500 : 200, err ? { error: err.message } : { status }),
    );
  }

  if (method === "GET" && pathname === "/api/analysis/presence-impact") {
    const sampleLimit = Math.max(
      1,
      Math.min(20000, Number(reqUrl.searchParams.get("limit")) || 2000),
    );
    return getPresenceImpact(sampleLimit, (err, result) =>
      sendJson(res, err ? 500 : 200, err ? { error: err.message } : result),
    );
  }

  if (method === "POST") {
    // Start: enable monitoring + tell ESP to start sending data
    if (pathname === "/api/control/start") {
      return setMonitoring(true, (err) => {
        if (err) return sendJson(res, 500, { error: err.message });
        sendToEsp({ type: "start" });
        broadcast({
          type: "app_status",
          message: "Monitoring started, ESP is sending data...",
        });
        sendJson(res, 200, { ok: true, monitoringEnabled: true });
      });
    }

    // Stop: disable monitoring + tell ESP to stop sending data
    if (pathname === "/api/control/stop") {
      return setMonitoring(false, (err) => {
        if (err) return sendJson(res, 500, { error: err.message });
        sendToEsp({ type: "stop" });
        broadcast({ type: "app_status", message: "Monitoring stopped." });
        sendJson(res, 200, { ok: true, monitoringEnabled: false });
      });
    }

    // Delete all data
    if (pathname === "/api/db/clear") {
      return db.run("DELETE FROM sensor_data", (err) => {
        if (err) return sendJson(res, 500, { error: err.message });
        db.run("DELETE FROM sqlite_sequence WHERE name='sensor_data'", () =>
          sendJson(res, 200, { ok: true }),
        );
      });
    }

    if (pathname === "/api/presence/status") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1e6) req.destroy();
      });
      req.on("end", () => {
        let parsed;
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          return sendJson(res, 400, { error: "Invalid JSON body" });
        }
        const status = parsed.status;
        const note = parsed.note;
        setPresence(status, note, (err) => {
          if (err) return sendJson(res, 400, { error: err.message });
          broadcast({
            type: "app_status",
            message: `Presence marked as ${status}.`,
          });
          sendJson(res, 200, { ok: true, status });
        });
      });
      return;
    }
  }

  // Download CSV
  if (method === "GET" && pathname === "/download") {
    return db.all(
      "SELECT * FROM sensor_data ORDER BY waktu DESC",
      (err, rows) => {
        if (err) {
          res.writeHead(500);
          return res.end("Failed");
        }
        let csv = "ID,Time,Temperature,Humidity\n";
        (rows || []).forEach((r) => {
          csv += `${r.id},${r.waktu},${r.suhu},${r.kelembapan}\n`;
        });
        res.writeHead(200, {
          "Content-Type": "text/csv",
          "Content-Disposition": "attachment; filename=sensor_data.csv",
        });
        res.end(csv);
      },
    );
  }

  // Download CSV for presence analysis (time,temp,humi,presence_status)
  if (method === "GET" && pathname === "/download/presence-analysis") {
    return db.all(
      `SELECT
        s.waktu AS time,
        s.suhu AS temp,
        s.kelembapan AS humi,
        COALESCE(
          s.presence_status,
          (
            SELECT p.status
            FROM presence_events p
            WHERE p.waktu <= s.waktu
            ORDER BY p.waktu DESC, p.id DESC
            LIMIT 1
          ),
          'empty'
        ) AS presence_status
      FROM sensor_data s
      ORDER BY s.waktu DESC, s.id DESC`,
      (err, rows) => {
        if (err) {
          res.writeHead(500);
          return res.end("Failed");
        }
        let csv = "time,temp,humi,presence_status\n";
        (rows || []).forEach((r) => {
          csv += `${r.time},${r.temp},${r.humi},${r.presence_status}\n`;
        });
        res.writeHead(200, {
          "Content-Type": "text/csv",
          "Content-Disposition": "attachment; filename=presence_analysis.csv",
        });
        res.end(csv);
      },
    );
  }

  res.writeHead(404);
  res.end("Not found");
});

// ─── WEBSOCKET SERVER ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("⚠️ Terminating unresponsive WebSocket connection.");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 10000); // 10 seconds heartbeat

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  const isEsp =
    (req.headers["x-client-type"] || "").toLowerCase() === "esp" ||
    (req.url || "").includes("client=esp");

  if (isEsp) {
    // ── ESP32 connection ────────────────────────────────────────────────────
    console.log(`🔌 ESP32 connected: ${req.socket.remoteAddress}`);
    espSocket = ws;

    // Notify all dashboards that ESP is online
    broadcast({ type: "esp_status", status: "online" });

    ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());

        handleEspPayload(d);
      } catch {
        console.log("⚠️  Non-JSON payload from ESP32.");
      }
    });

    ws.on("close", () => {
      console.log("🔌 ESP32 disconnected.");
      espSocket = null;
      broadcast({ type: "esp_status", status: "offline" });
    });
  } else {
    // ── Dashboard connection ────────────────────────────────────────────────
    console.log(`📊 Dashboard connected: ${req.socket.remoteAddress}`);
    dashboards.add(ws);

    // Send initial status to the new dashboard
    getMonitoring((err, enabled) => {
      if (!err && ws.readyState === WebSocket.OPEN) {
        getCurrentPresence((presenceErr, presenceStatus) => {
          if (!presenceErr && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "monitoring",
                enabled,
                espOnline: !!espSocket,
                presenceStatus,
              }),
            );
          }
        });
      }
    });

    ws.on("close", () => dashboards.delete(ws));

    // Fallback: if ESP forgets client=esp, auto-detect via payload
    ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (!looksLikeEspPayload(d)) return;

        console.log(
          "⚠️  ESP detected without client=esp, automatically moved to ESP channel.",
        );

        dashboards.delete(ws);
        espSocket = ws;
        broadcast({ type: "esp_status", status: "online" });

        // Ensure ESP disconnection is tracked if it connected without the right headers
        ws.on("close", () => {
          if (espSocket === ws) {
            console.log("🔌 ESP32 disconnected (from fallback).");
            espSocket = null;
            broadcast({ type: "esp_status", status: "offline" });
          }
        });

        handleEspPayload(d);
      } catch {
        // Ignore non-JSON messages from dashboard
      }
    });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Dashboard: http://localhost:${PORT}`);
  console.log(`📡 Waiting for ESP32 connection...`);
});
