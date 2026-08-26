#include "net.h"
#include "config.h"
#include "io.h"
#include "telemetry.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "orb/secrets.h missing -- copy orb/secrets_example.h to it and fill in your network"
#endif

#include <ESPmDNS.h>
#include <WiFi.h>
#include <lwip/sockets.h>

static NetworkServer server(ORB_TCP_PORT);
static NetworkClient client;

static bool     wifi_was_up  = false;
static bool     mdns_up      = false;
static uint32_t last_kick_ms = 0;
static uint32_t last_mdns_ms = 0;

// If association has not happened by now, stop waiting politely and re-issue
// the join. setAutoReconnect covers a network that drops; it does not cover one
// that was not there at boot and appeared later.
static const uint32_t REJOIN_MS = 15000;
static const uint32_t MDNS_RETRY_MS = 3000;

bool net_wifi_up()   { return WiFi.status() == WL_CONNECTED; }
bool net_client_up() { return client && client.connected(); }

Stream *net_client() { return net_client_up() ? &client : nullptr; }

// Outbound queue. The socket refuses writes the moment its window is full, and
// the first thing a host does on connecting is ask for the whole settings block
// -- ~1.4 kB of small lines, back to back, into a connection that has not opened
// up yet. Dropping those is not an option: a lost '#' line desynchronises the
// panel from the device, and a lost CSV header makes the bridge discard every
// row that follows. So they wait here and go out as the link allows.
//
// Big enough for two full settings dumps. Telemetry is kept off it unless the
// queue is nearly empty (io_can_write), so rows never build a stale backlog --
// the queue exists for bursts, not for buffering the stream.
static uint8_t txbuf[4096];
static size_t  tx_tail = 0;   // next byte out
static size_t  tx_used = 0;

size_t net_tx_pending() { return tx_used; }

static bool writable() {
  int fd = client.fd();
  if (fd < 0) return false;
  fd_set w;
  FD_ZERO(&w);
  FD_SET(fd, &w);
  struct timeval tv = {0, 0};
  return ::select(fd + 1, nullptr, &w, nullptr, &tv) > 0 && FD_ISSET(fd, &w);
}

// Deliberately not client.write(). That retries around a select() with a
// one-second timeout, ten times -- so a host that stops reading can park loop()
// for ten seconds, and the orb goes dead in the hand.
static void drain() {
  while (tx_used && writable()) {
    size_t run = sizeof(txbuf) - tx_tail;      // to the end of the ring
    if (run > tx_used) run = tx_used;
    int res = ::send(client.fd(), txbuf + tx_tail, run, MSG_DONTWAIT);
    if (res <= 0) break;
    tx_tail = (tx_tail + (size_t)res) % sizeof(txbuf);
    tx_used -= (size_t)res;
  }
}

size_t net_write(const uint8_t *buf, size_t n) {
  if (!net_client_up()) return 0;

  drain();
  if (n > sizeof(txbuf) - tx_used) return 0;   // no room even after draining

  size_t head = (tx_tail + tx_used) % sizeof(txbuf);
  for (size_t i = 0; i < n; i++) {
    txbuf[head] = buf[i];
    head = (head + 1) % sizeof(txbuf);
  }
  tx_used += n;

  drain();
  return n;
}

static void join() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  last_kick_ms = millis();
}

void net_begin() {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(ORB_HOSTNAME);

  // Modem sleep parks the radio between beacons and adds up to ~100 ms to
  // anything arriving from the host. At 100 Hz that is the difference between a
  // link you can feel through and one you cannot.
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);

  join();

  server.begin();
  server.setNoDelay(true);

  io().print(F("# wifi ssid=")); io().println(F(WIFI_SSID));
  io().print(F("# tcp port="));  io().println(ORB_TCP_PORT);
}

static void on_client_gone() {
  // The serial path gets 'c 0' from the bridge on its way out; a socket that
  // dies has no such chance. Without this the orb streams into nothing, and a
  // host-driven hold outlives the host that set it.
  telemetry_set_streaming(false);
  cfg.hold = -1.0f;
  tx_tail = 0;
  tx_used = 0;
}

void net_tick() {
  drain();

  bool up = net_wifi_up();

  if (up && !wifi_was_up) {
    io().print(F("# wifi=1 ip=")); io().println(WiFi.localIP());
  } else if (!up && wifi_was_up) {
    io().println(F("# wifi=0 -- lost the network"));
    mdns_up = false;
  }
  wifi_was_up = up;

  if (!up && millis() - last_kick_ms > REJOIN_MS) join();

  // Retried rather than attempted once on the association edge: mdns_init fails
  // if the interface is not quite ready, and the orb is then reachable only by
  // an address that DHCP is free to change.
  if (up && !mdns_up && millis() - last_mdns_ms > MDNS_RETRY_MS) {
    last_mdns_ms = millis();
    if (MDNS.begin(ORB_HOSTNAME)) {
      MDNS.addService("orb", "tcp", ORB_TCP_PORT);
      mdns_up = true;
      io().print(F("# mdns=")); io().print(ORB_HOSTNAME); io().println(F(".local"));
    }
  }

  // One host at a time. A laptop that slept leaves a half-open socket behind
  // that looks connected from here and would otherwise hold the slot forever,
  // so the newcomer wins.
  if (server.hasClient()) {
    NetworkClient fresh = server.accept();
    if (net_client_up()) {
      client.stop();
      on_client_gone();
    }
    client = fresh;
    client.setNoDelay(true);
    Serial.print(F("# host connected from ")); Serial.println(client.remoteIP());
  }

  static bool had_client = false;
  bool has = net_client_up();
  if (had_client && !has) {
    client.stop();
    on_client_gone();
    Serial.println(F("# host disconnected"));
  }
  had_client = has;
}
