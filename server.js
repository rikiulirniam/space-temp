const fs = require("fs");
const path = require("path");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const sqlite3 = require("sqlite3").verbose();

const PORT = 8080;
const INDEX_FILE = path.join(__dirname, "index.html");
const DB_FILE = path.join(__dirname, "monitoring.db");

// --- DATABASE SETUP ---
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error("❌ Database Error:", err.message);
  else console.log("✅ Database SQLite Terhubung.");
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    waktu DATETIME DEFAULT (datetime('now','localtime')),
    suhu REAL,
    kelembapan REAL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT (datetime('now','localtime'))
  )`);

  db.run(
    `INSERT OR IGNORE INTO app_settings (key, value) VALUES ('monitoring_enabled', '0')`,
  );

  db.run(
    `UPDATE app_settings SET value = '0', updated_at = datetime('now','localtime') WHERE key = 'monitoring_enabled'`,
  );
});

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(JSON.stringify(payload));
}

function getMonitoringEnabled(callback) {
  db.get(
    `SELECT value FROM app_settings WHERE key = 'monitoring_enabled'`,
    (err, row) => {
      if (err) return callback(err);
      callback(null, row ? row.value === "1" : true);
    },
  );
}

function setMonitoringEnabled(enabled, callback) {
  db.run(
    `UPDATE app_settings SET value = ?, updated_at = datetime('now','localtime') WHERE key = 'monitoring_enabled'`,
    [enabled ? "1" : "0"],
    callback,
  );
}

function broadcastMonitoringState(enabled) {
  const payload = JSON.stringify({ type: "monitoring", enabled });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

const server = http.createServer((req, res) => {
  const method = req.method || "GET";

  // 1. Dashboard UI
  if (method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    fs.readFile(INDEX_FILE, (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end("Error loading index.html");
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  // 2. API History (Ambil 50 data terakhir)
  if (method === "GET" && req.url === "/api/history") {
    db.all(
      "SELECT suhu as temp, kelembapan as humi, waktu as time FROM sensor_data ORDER BY id DESC LIMIT 50",
      (err, rows) => {
        if (err) {
          return sendJson(res, 500, { error: err.message });
        }
        sendJson(res, 200, rows.reverse());
      },
    );
    return;
  }

  // 3. API Status Monitoring
  if (method === "GET" && req.url === "/api/control/status") {
    getMonitoringEnabled((err, enabled) => {
      if (err) {
        return sendJson(res, 500, { error: err.message });
      }
      sendJson(res, 200, { monitoringEnabled: enabled });
    });
    return;
  }

  // 4. API Start Monitoring
  if (method === "POST" && req.url === "/api/control/start") {
    setMonitoringEnabled(true, (err) => {
      if (err) {
        return sendJson(res, 500, { error: err.message });
      }
      broadcastMonitoringState(true);
      sendJson(res, 200, { ok: true, monitoringEnabled: true });
    });
    return;
  }

  // 5. API Stop Monitoring
  if (method === "POST" && req.url === "/api/control/stop") {
    setMonitoringEnabled(false, (err) => {
      if (err) {
        return sendJson(res, 500, { error: err.message });
      }
      broadcastMonitoringState(false);
      sendJson(res, 200, { ok: true, monitoringEnabled: false });
    });
    return;
  }

  // 6. API Clear Database (hapus semua data sensor)
  if (method === "POST" && req.url === "/api/db/clear") {
    db.serialize(() => {
      db.run("DELETE FROM sensor_data", function onDelete(err) {
        if (err) {
          return sendJson(res, 500, { error: err.message });
        }

        const deletedRows = this.changes || 0;
        db.run("DELETE FROM sqlite_sequence WHERE name = 'sensor_data'", () => {
          sendJson(res, 200, { ok: true, deletedRows });
        });
      });
    });
    return;
  }

  // 7. API Download CSV
  if (method === "GET" && req.url === "/download") {
    db.all("SELECT * FROM sensor_data ORDER BY waktu DESC", (err, rows) => {
      if (err) return res.end("Gagal mengambil data");
      let csv = "ID,Waktu,Suhu,Kelembapan\n";
      rows.forEach((r) => {
        csv += `${r.id},${r.waktu},${r.suhu},${r.kelembapan}\n`;
      });
      res.writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=data_sensor_dasihayu.csv",
      });
      res.end(csv);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`📱 Client Konek: ${ip}`);

  getMonitoringEnabled((err, enabled) => {
    if (!err && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "monitoring", enabled }));
    }
  });

  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      const t = parsed.temp ?? parsed.temperature ?? parsed.t;
      const h = parsed.humi ?? parsed.humidity ?? parsed.h;

      if (t !== undefined && h !== undefined) {
        getMonitoringEnabled((err, enabled) => {
          if (err) {
            console.log("⚠️ Gagal membaca status monitoring:", err.message);
            return;
          }

          if (!enabled) {
            return;
          }

          // Simpan ke SQLite
          db.run(`INSERT INTO sensor_data (suhu, kelembapan) VALUES (?, ?)`, [
            t,
            h,
          ]);

          // Broadcast ke semua Dashboard yang sedang buka
          const payload = JSON.stringify({ temp: t, humi: h });
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(payload);
            }
          });
        });
      }
    } catch (e) {
      console.log("⚠️ Data masuk bukan JSON valid.");
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server Dashboard: http://localhost:${PORT}`);
  console.log(`📡 WebSocket siap menerima data dari ESP32.`);
});
