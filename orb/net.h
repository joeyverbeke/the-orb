#pragma once

// WiFi link. The orb is a station on an ordinary 2.4 GHz network and listens on
// a TCP port; tools/bridge.py connects out to it and speaks exactly the same
// newline-delimited text the serial port carried. Device-as-server because the
// laptop's address changes constantly and the orb's name does not.
//
// Nothing here blocks. WiFi association happens in the background, the listen
// socket is non-blocking, and writes are hand-rolled for the same reason --
// see net_write.

#include <Arduino.h>

void net_begin();
void net_tick();

// Associated and holding an IP.
bool net_wifi_up();

// A host is connected. This, not net_wifi_up, is what decides where output goes.
bool net_client_up();

// The connected host, for reading commands. nullptr when there is none.
Stream *net_client();

// Queue a line for the host and push what the socket will take. Never blocks,
// never tears a line: a short send leaves the remainder queued for next time.
// Returns 0 only if the queue had no room, which is a real drop.
size_t net_write(const uint8_t *buf, size_t n);

// Bytes still waiting to go out. Telemetry uses this to decide whether the link
// is keeping up -- see io_can_write.
size_t net_tx_pending();
