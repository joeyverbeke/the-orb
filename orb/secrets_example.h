#pragma once

// Copy to secrets.h and fill in. secrets.h is gitignored.
//
// 2.4 GHz only -- the ESP32-S3 has no 5 GHz radio. A network that hides both
// bands behind one SSID usually still works; a 5 GHz-only one never will.

#define WIFI_SSID "your-network"
#define WIFI_PASS "your-password"
