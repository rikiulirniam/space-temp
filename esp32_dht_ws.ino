#include <WiFi.h>
#include <WebSocketsClient.h>
#include <DHT.h>

// --- Konfigurasi jaringan dan server ---
const char* ssid = "Wifi-MST-III-TMR"; // ganti jika perlu
const char* pass = "";                 // ganti jika perlu
const char* server_ip = "172.16.160.169"; // alamat server
const uint16_t server_port = 8080;

// --- DHT22 ---
const uint8_t DHTPIN = 15; // pin DATA
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

WebSocketsClient webSocket;

// Kontrol pengiriman data (server dapat mengubah via start/stop)
bool monitoringEnabled = true; // default: kirim data

// Interval pengiriman dan ping (lebih pendek untuk respons lebih cepat)
const unsigned long SEND_INTERVAL_MS = 1000; // kirim tiap 1s
const unsigned long PING_INTERVAL_MS = 10000; // ping tiap 10s

unsigned long lastSend = 0;
unsigned long lastPing = 0;

void sendSensorIfNeeded() {
  if (!monitoringEnabled) return;
  if (millis() - lastSend < SEND_INTERVAL_MS) return;
  lastSend = millis();

  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) {
    Serial.println("[ERROR] Gagal baca sensor DHT22");
    return;
  }

  String json = "{\"temp\":" + String(t, 2) + ",\"humi\":" + String(h, 2) + "}";
  if (webSocket.isConnected()) {
    webSocket.sendTXT(json);
    Serial.print("[DATA] Terkirim: ");
    Serial.println(json);
  } else {
    Serial.println("[DATA] WebSocket belum terkoneksi");
  }
}

void handleServerText(const String &p) {
  // Payload JSON sederhana — cari token "start" atau "stop"
  String msg = p;
  msg.trim();
  Serial.print("[WS] RX: ");
  Serial.println(msg);

  if (msg.indexOf("\"start\"") >= 0 || msg.indexOf("\"type\":\"start\"") >= 0) {
    monitoringEnabled = true;
    webSocket.sendTXT("{\"type\":\"esp_ack\",\"cmd\":\"start\",\"status\":\"ok\"}");
    Serial.println("[WS] Perintah START diterima -> monitoring ON");
    return;
  }
  if (msg.indexOf("\"stop\"") >= 0 || msg.indexOf("\"type\":\"stop\"") >= 0) {
    monitoringEnabled = false;
    webSocket.sendTXT("{\"type\":\"esp_ack\",\"cmd\":\"stop\",\"status\":\"ok\"}");
    Serial.println("[WS] Perintah STOP diterima -> monitoring OFF");
    return;
  }
}

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Terputus dari server");
      break;
    case WStype_CONNECTED:
      Serial.println("[WS] Tersambung ke server");
      // Kirim identitas agar server mengenali ini sebagai ESP
      webSocket.sendTXT("{\"type\":\"esp_status\",\"status\":\"online\"}");
      break;
    case WStype_TEXT:
      if (payload && length > 0) {
        // payload mungkin bukan null-terminated -> salin ke buffer yang aman
        char *buf = (char*)malloc(length + 1);
        if (buf) {
          memcpy(buf, payload, length);
          buf[length] = '\0';
          String s = String(buf);
          free(buf);
          handleServerText(s);
        }
      }
      break;
    case WStype_PONG:
      Serial.println("[WS] PONG diterima");
      break;
    case WStype_ERROR:
      Serial.println("[WS] Error WebSocket");
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n--- BOOT ESP32 ---");

  dht.begin();

  Serial.print("[WIFI] Menghubungkan ke: ");
  Serial.println(ssid);
  WiFi.begin(ssid, pass);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();
  Serial.println("[WIFI] Connected");
  Serial.print("[WIFI] IP: ");
  Serial.println(WiFi.localIP());

  // Gunakan query param client=esp agar server langsung menandai koneksi sebagai ESP
  webSocket.begin(server_ip, server_port, "/?client=esp");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);

  Serial.println("[SYSTEM] Setup selesai");
}

void loop() {
  webSocket.loop();

  // Kirim ping berkala agar server dapat menandai socket alive (server mem-ping juga)
  if (millis() - lastPing > PING_INTERVAL_MS) {
    lastPing = millis();
    if (webSocket.isConnected()) {
      webSocket.sendPing();
      Serial.println("[WS] Ping dikirim");
    }
  }

  sendSensorIfNeeded();
}
