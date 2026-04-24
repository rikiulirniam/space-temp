const fs = require("fs");
const path = require("path");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const sqlite3 = require("sqlite3").verbose();

const PORT = 8080;
const INDEX_FILE = path.join(__dirname, "index.html");
const DB_FILE = path.join(__dirname, "monitoring.db");

// --- SETUP DATABASE ---
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) console.error("Gagal konek ke database:", err.message);
  else console.log("✅ Terhubung ke database SQLite.");
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    waktu DATETIME DEFAULT CURRENT_TIMESTAMP,
    suhu REAL,
    kelembapan REAL
  )`);
});

const server = http.createServer((req, res) => {
  // 1. Dashboard UI
  if (req.url === "/" || req.url === "/index.html") {
    try {
      const html = fs.readFileSync(INDEX_FILE, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (error) {
      res.writeHead(500);
      res.end("Gagal membaca index.html");
    }
    return;
  }

  // 2. API History (Ambil 50 data terakhir untuk reload)
  if (req.url === "/api/history") {
    db.all("SELECT suhu as temp, kelembapan as humi, waktu as time FROM sensor_data ORDER BY id DESC LIMIT 50", (err, rows) => {
      if (err) {
        res.writeHead(500);
        res.end(JSON.stringify(err));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0"
      });
      res.end(JSON.stringify(rows.reverse())); // Urutkan dari lama ke baru
    });
    return;
  }

  // 3. API Download CSV
  if (req.url === "/download") {
    db.all("SELECT * FROM sensor_data ORDER BY waktu DESC", (err, rows) => {
      if (err) {
        res.end("Gagal mengambil data");
        return;
      }
      let csv = "ID,Waktu,Suhu,Kelembapan\n";
      rows.forEach(row => {
        csv += `${row.id},${row.waktu},${row.suhu},${row.kelembapan}\n`;
      });
      res.writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=data_sensor.csv"
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
  console.log(`📱 Client connected from ${req.socket.remoteAddress}`);

  ws.on("message", (data) => {
    try {
      const payload = data.toString();
      const parsed = JSON.parse(payload);

      // Simpan ke DB jika data valid
      const temp = parsed.temperature ?? parsed.temp ?? parsed.suhu ?? parsed.t;
      const humi = parsed.humidity ?? parsed.humi ?? parsed.kelembapan ?? parsed.h;

      if (temp !== undefined && humi !== undefined) {
        db.run(`INSERT INTO sensor_data (suhu, kelembapan) VALUES (?, ?)`, [temp, humi]);
        
        // Siapkan payload standar untuk broadcast
        const cleanPayload = JSON.stringify({ temp, humi });

        // Broadcast ke SEMUA client (termasuk dashboard)
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(cleanPayload);
          }
        });
      }
    } catch (e) {
      console.log("Invalid data received:", data.toString());
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server aktif di port ${PORT}`);
});