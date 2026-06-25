#include <WiFi.h>
#include <WiFiMulti.h>
#include <WebSocketsClient.h>
#include <DHT.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Fonts/FreeSans9pt7b.h> 

// --- Inisialisasi WiFiMulti ---
WiFiMulti wifiMulti;

// const char* server_ip = "192.168.10.185"; //dev
const char* server_ip = "spacetemp.rikiulir.site";
const uint16_t server_port = 8080;

// --- Konfigurasi Pin ---
#define I2C_SDA 26
#define I2C_SCL 27
#define LED_NORMAL 18 // Indikator suhu ideal (Hijau)
#define LED_WARN  21   // Indikator suhu peringatan (Kuning)
#define LED_ALERT 19  // Indikator suhu bahaya (Merah)
#define BUZZER_PIN 5  // Pin untuk Buzzer

// --- OLED 0.91" 128x32 ---
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 32
#define OLED_RESET -1 
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// --- DHT22 ---
const uint8_t DHTPIN = 15; 
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

WebSocketsClient webSocket;

// Kontrol pengiriman data
bool monitoringEnabled = true; 

// --- Variabel Waktu & Peringatan ---
const unsigned long SEND_INTERVAL_MS = 1000; 
const unsigned long PING_INTERVAL_MS = 10000; 
const unsigned long BLINK_INTERVAL_MS = 300; 

unsigned long lastSend = 0;
unsigned long lastPing = 0;
unsigned long lastBlink = 0;

// --- Batas Suhu Ruang Bayi ---
const float TEMP_DANGER_MIN = 20.0;
const float TEMP_DANGER_MAX = 35.0;
const float TEMP_IDEAL_MIN = 24.0;
const float TEMP_IDEAL_MAX = 32.0;

// Status Logika
bool isAlertMode = false; 
bool isWarnMode = false;
bool blinkState = false;  

void updateOLED(float t, float h) {
  display.clearDisplay();
  
  display.setFont(&FreeSans9pt7b);
  display.setTextSize(1); 
  display.setTextColor(SSD1306_WHITE);

  if (isnan(t) || isnan(h)) {
    display.setCursor(0, 20); 
    display.print("DHT Error!");
  } else {
    if (isAlertMode) {
      display.setCursor(0, 14);
      display.print("! BAHAYA !");
      display.setCursor(0, 31);
      display.print(t, 1);
      display.print("C");
    } else if (isWarnMode) {
      display.setCursor(0, 14);
      display.print("PERHATIAN");
      display.setCursor(0, 31);
      display.print(t, 1);
      display.print("C");
    } else {
      display.setCursor(0, 14);
      display.print("Temp : ");
      display.print(t, 1);
      display.print(" C");
      
      display.setCursor(0, 31);
      display.print("Humi : ");
      display.print(h, 1);
      display.print(" %");
    }
  }
  
  display.display();
  display.setFont(); 
}

void processSensorData() {
  if (millis() - lastSend < SEND_INTERVAL_MS) return;
  lastSend = millis();

  float t = dht.readTemperature();
  float h = dht.readHumidity();
  
  if (!isnan(t)) {
    // Evaluasi Status Suhu
    if (t < TEMP_DANGER_MIN || t >= TEMP_DANGER_MAX) {
      isAlertMode = true;
      isWarnMode = false;
    } else if (t >= TEMP_IDEAL_MIN && t <= TEMP_IDEAL_MAX) {
      isAlertMode = false;
      isWarnMode = false;
    } else {
      // Masuk rentang peringatan (22-23 atau 28-30)
      isAlertMode = false;
      isWarnMode = true;
    }

    // Eksekusi Kondisi Berdasarkan Status
    if (isAlertMode) {
      // LED Normal dan Warn dimatikan paksa, LED Merah diatur oleh fungsi blink di loop()
      digitalWrite(LED_NORMAL, LOW); 
      digitalWrite(LED_WARN, LOW);
    } else if (isWarnMode) {
      // LED Kuning aktif, layar berhenti berkedip
      display.invertDisplay(false); 
      digitalWrite(LED_NORMAL, LOW); 
      digitalWrite(LED_WARN, HIGH);
      digitalWrite(LED_ALERT, LOW);
      analogWrite(BUZZER_PIN, 0); 
    } else {
      // LED Hijau aktif, layar berhenti berkedip
      display.invertDisplay(false); 
      digitalWrite(LED_NORMAL, HIGH); 
      digitalWrite(LED_WARN, LOW);
      digitalWrite(LED_ALERT, LOW);
      analogWrite(BUZZER_PIN, 0); 
    }
  }

  updateOLED(t, h);

  if (isnan(t) || isnan(h)) {
    Serial.println("[ERROR] Gagal baca sensor DHT22");
    return;
  }

  if (!monitoringEnabled) return;

  String json = "{\"temp\":" + String(t, 2) + ",\"humi\":" + String(h, 2) + "}";
  if (webSocket.isConnected()) {
    webSocket.sendTXT(json);
  }
}

void handleServerText(const String &p) {
  String msg = p;
  msg.trim();

  if (msg.indexOf("\"start\"") >= 0 || msg.indexOf("\"type\":\"start\"") >= 0) {
    monitoringEnabled = true;
    webSocket.sendTXT("{\"type\":\"esp_ack\",\"cmd\":\"start\",\"status\":\"ok\"}");
    return;
  }
  if (msg.indexOf("\"stop\"") >= 0 || msg.indexOf("\"type\":\"stop\"") >= 0) {
    monitoringEnabled = false;
    webSocket.sendTXT("{\"type\":\"esp_ack\",\"cmd\":\"stop\",\"status\":\"ok\"}");
    return;
  }
}

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      webSocket.sendTXT("{\"type\":\"esp_status\",\"status\":\"online\"}");
      break;
    case WStype_TEXT:
      if (payload && length > 0) {
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
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  
  pinMode(LED_NORMAL, OUTPUT);
  pinMode(LED_WARN, OUTPUT);
  pinMode(LED_ALERT, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  
  digitalWrite(LED_NORMAL, LOW);
  digitalWrite(LED_WARN, LOW);
  digitalWrite(LED_ALERT, LOW);
  analogWrite(BUZZER_PIN, 0);

  Wire.begin(I2C_SDA, I2C_SCL);

  if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { 
    Serial.println(F("[ERROR] SSD1306 allocation failed"));
  } else {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0,0);
    display.println("Booting System...");
    display.display();
  }

  dht.begin();

  if(display.getBuffer() != NULL) {
    display.clearDisplay();
    display.setCursor(0,0);
    display.println("Connecting WiFi...");
    display.display();
  }

  // Daftarkan SSID dan Password (Prioritas failover)
  wifiMulti.addAP("bit-2", "aaaaaaaa");
  wifiMulti.addAP("antiwacana_2,4G", "mauwifian");

  // Tunggu hingga salah satu koneksi berhasil
  while (wifiMulti.run() != WL_CONNECTED) {
    delay(500);
  }

  webSocket.begin(server_ip, server_port, "/?client=esp");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
}

void loop() {
  // Hanya eksekusi WebSocket jika WiFi sedang terhubung
  if (wifiMulti.run() == WL_CONNECTED) {
    webSocket.loop();

    if (millis() - lastPing > PING_INTERVAL_MS) {
      lastPing = millis();
      if (webSocket.isConnected()) {
        webSocket.sendPing();
      }
    }
  }

  processSensorData();

  // --- LOGIKA KEDIP PERINGATAN (BAHAYA) ---
  if (isAlertMode) {
    if (millis() - lastBlink > BLINK_INTERVAL_MS) {
      lastBlink = millis();
      blinkState = !blinkState; 
      
      display.invertDisplay(blinkState); 
      
      if (blinkState) {
        digitalWrite(LED_ALERT, HIGH); 
        analogWrite(BUZZER_PIN, 80); 
      } else {
        digitalWrite(LED_ALERT, LOW); 
        analogWrite(BUZZER_PIN, 0); 
      }
    }
  }
}