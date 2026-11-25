// Upstream fetch hard deadlines.
//
// fetchWithHeadersTimeout aborts a request whose server completes the TCP
// handshake but never returns response headers; the timer is cleared once
// headers arrive, so a healthy streaming response is never affected.
//
// readWithIdleTimeout aborts a stream reader when no chunk arrives within the
// deadline (a wedged provider holding an open SSE response). The generous
// default leaves room for slow model loads before the first token.
//
// Timeouts abort with a plain Error rather than an AbortError so callers
// classify them as provider failures, not user-initiated stops.

const HEADERS_TIMEOUT_MS = 30000;
const STREAM_IDLE_TIMEOUT_MS = 600000;

function fetchWithHeadersTimeout(url, options = {}, timeoutMs = HEADERS_TIMEOUT_MS) {
  const controller = new AbortController();
  const callerSignal = options.signal;

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason), { once: true });
    }
  }

  let timer = setTimeout(() => {
    timer = null;
    controller.abort(new Error(`The server accepted the connection but did not respond within ${Math.round(timeoutMs / 1000)} seconds.`));
  }, timeoutMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return fetch(url, { ...options, signal: controller.signal }).then(
    response => {
      clear();
      return response;
    },
    error => {
      clear();
      throw error;
    }
  );
}

async function readWithIdleTimeout(reader, timeoutMs = STREAM_IDLE_TIMEOUT_MS) {
  let timer = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          timer = null;
          reject(new Error(`The provider stopped sending data for ${Math.round(timeoutMs / 60000)} minutes.`));
        }, timeoutMs);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      })
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

module.exports = { fetchWithHeadersTimeout, readWithIdleTimeout, HEADERS_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS };
