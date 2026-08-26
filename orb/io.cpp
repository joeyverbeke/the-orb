#include "io.h"
#include "net.h"

namespace {

// Long enough for the CSV row (~130 bytes) plus headroom. A line that overruns
// is written in pieces rather than truncated -- correctness over packet count.
class LineOut : public Print {
 public:
  size_t write(uint8_t c) override {
    buf_[n_++] = c;
    if (c == '\n' || n_ == sizeof(buf_)) drain();
    return 1;
  }

  size_t write(const uint8_t *p, size_t n) override {
    for (size_t i = 0; i < n; i++) write(p[i]);
    return n;
  }

  void drain() {
    if (!n_) return;
    if (net_client_up()) {
      net_write(buf_, n_);
    } else {
      Serial.write(buf_, n_);
    }
    n_ = 0;
  }

 private:
  uint8_t buf_[192];
  size_t  n_ = 0;
};

LineOut out;

}  // namespace

Print &io() { return out; }

void io_flush() { out.drain(); }

bool io_can_write() {
  // Not "is the socket writable" but "is the link keeping up". A row is only
  // worth queueing if the queue is nearly empty; otherwise the link is behind
  // and the honest thing is to skip this row rather than deepen a backlog of
  // frames that will arrive stale. Room is left for a settings dump to burst
  // past a telemetry stream that is running flat out.
  return net_client_up() ? net_tx_pending() < 512 : true;
}
