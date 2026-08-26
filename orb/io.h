#pragma once

// Where the firmware's words go.
//
// Everything used to print straight to Serial. With a WiFi client in the
// picture there are two possible destinations and no reason for any call site
// to know which is live, so they all print to io() and this decides.
//
// It buffers a whole line before writing it. That is not tidiness: a CSV row is
// ~24 separate print calls, which over TCP with Nagle disabled would be 24
// packets at 100 Hz, and over USB CDC is 24 separately-locked writes into a
// stream with a 100 ms tx timeout. One write per line fixes both.

#include <Arduino.h>

// The active link: the TCP client if one is connected, else Serial. During
// setup(), before WiFi is up, that is always Serial.
Print &io();

// Can a line be written right now without blocking? Always true on Serial --
// that path is unchanged from when it was the only one. On TCP it is a real
// check, because a backed-up socket makes NetworkClient::write sit in select()
// for up to ten seconds, which would stop the 100 Hz loop dead.
bool io_can_write();

// Push a partial line out. Only needed before a deliberate stall.
void io_flush();
