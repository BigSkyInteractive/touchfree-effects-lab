/*
The two picture streams the page reads, the camera (JPEG) and the body mask
(PNG), both multipart MJPEG from the TouchFree server, read with fetch and
a ReadableStream instead of an <img>.

Why not an <img>. An <img> on a multipart stream decodes every part in
order, on its own schedule, and a page has no way to ask for the newest
one or to know how far behind it is; a hidden one (the engine's sources
are never in the DOM) is decoded at the browser's convenience. Parts the
page could not keep up with were queued, not dropped, and the mask
arrived about half a second behind the picture (Tim, 2026-08-30).

Here the parts are parsed as they arrive and decoded one at a time; a
part that arrives while the previous one is still decoding replaces any
part already waiting, so the newest frame is always the next one decoded
and nothing accumulates. `take()` hands the newest decoded frame to the
caller once; the caller owns it until the next `take()` replaces it.

If a part carries an `X-Timestamp` header (milliseconds since the epoch,
the server's clock, which is this machine's), the stream reports the age
of the newest part as `lagMs`: the one honest end-to-end number for the
stream, capture to page. Without the header, `lagMs` stays null.
*/

const CRLF2 = [13, 10, 13, 10];

function indexOf(buf, pat, from) {
  const n = buf.length - pat.length;
  outer: for (let i = from; i <= n; i++) {
    for (let j = 0; j < pat.length; j++) if (buf[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}
function concat(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length); out.set(a, 0); out.set(b, a.length); return out;
}

export function createMjpegStream(url, name) {
  const st = { name, open: false, connected: false, parts: 0, partsPerSec: 0, decodeMs: 0, dropped: 0, lagMs: null, width: 0, height: 0, error: '' };
  let running = false, ctrl = null, retryMs = 500;
  let decoding = false, waiting = null;          // waiting: the newest undecoded part, replaced not queued
  let newest = null, handed = null;              // decoded frames: the newest not yet taken, and the one the caller holds
  let secStart = performance.now(), secParts = 0;
  const dec = new TextDecoder('latin1');

  async function decode(part) {
    decoding = true;
    const t0 = performance.now();
    try {
      const bmp = await createImageBitmap(new Blob([part.bytes]));
      st.decodeMs = performance.now() - t0; st.width = bmp.width; st.height = bmp.height;
      if (newest) newest.bitmap.close();
      newest = { bitmap: bmp, ts: part.ts, at: performance.now() };
      if (part.ts) st.lagMs = Date.now() - part.ts;
    } catch (e) { st.error = 'decode: ' + e; }
    decoding = false;
    if (waiting) { const w = waiting; waiting = null; decode(w); }
  }
  function onPart(bytes, headers) {
    st.parts++; secParts++;
    const now = performance.now();
    if (now - secStart >= 1000) { st.partsPerSec = secParts * 1000 / (now - secStart); secParts = 0; secStart = now; }
    const ts = headers['x-timestamp'] ? Number(headers['x-timestamp']) : 0;
    const part = { bytes, ts };
    if (decoding) { if (waiting) st.dropped++; waiting = part; }
    else decode(part);
  }

  async function run() {
    while (running) {
      ctrl = new AbortController();
      try {
        const sep = url.includes('?') ? '&' : '?';
        const r = await fetch(url + sep + 't=' + Date.now(), { signal: ctrl.signal, cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const ctype = r.headers.get('Content-Type') || '';
        const m = /boundary=("?)([^";]+)\1/.exec(ctype);
        if (!m) throw new Error('not multipart: ' + ctype);
        const boundary = new TextEncoder().encode('--' + m[2]);
        st.connected = true; st.error = ''; retryMs = 500;
        const reader = r.body.getReader();
        let buf = new Uint8Array(0);
        while (running) {
          const { value, done } = await reader.read();
          if (done) throw new Error('stream ended');
          buf = concat(buf, value);
          // parse every complete part in the buffer
          for (;;) {
            const b = indexOf(buf, boundary, 0);
            if (b < 0) { if (buf.length > 1 << 22) buf = new Uint8Array(0); break; }   // no boundary in 4 MB: garbage, drop it
            const he = indexOf(buf, CRLF2, b + boundary.length);
            if (he < 0) break;
            const headers = {};
            for (const line of dec.decode(buf.subarray(b + boundary.length, he)).split('\r\n')) {
              const k = line.indexOf(':'); if (k > 0) headers[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim();
            }
            const len = headers['content-length'] ? parseInt(headers['content-length'], 10) : NaN;
            if (!Number.isFinite(len)) throw new Error('a part without Content-Length');
            const start = he + 4, end = start + len;
            if (buf.length < end) break;
            onPart(buf.slice(start, end), headers);
            buf = buf.subarray(end);
          }
        }
      } catch (e) {
        if (!running) break;
        st.connected = false; st.error = String(e && e.message ? e.message : e);
        console.warn('[lab stream ' + name + '] ' + st.error + '; again in ' + retryMs + ' ms');
        await new Promise((res) => setTimeout(res, retryMs)); retryMs = Math.min(4000, retryMs * 2);
      }
    }
    st.connected = false;
  }

  return {
    open() { if (running) return; running = true; st.open = true; run(); },
    close() { running = false; st.open = false; if (ctrl) ctrl.abort(); if (newest) { newest.bitmap.close(); newest = null; } if (handed) { handed.bitmap.close(); handed = null; } waiting = null; },
    /* The newest decoded frame, once; null when nothing new arrived since the last take. The
       returned frame stays valid until the next take that returns a frame. */
    take() {
      if (!newest) return null;
      if (handed) handed.bitmap.close();
      handed = newest; newest = null;
      return handed;
    },
    isOpen: () => running,
    stats: () => st,
  };
}
