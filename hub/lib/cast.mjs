// A tiny Cast v2 sender (the protocol the Google Home app speaks to Chromecast built-in on port 8009), for the TV's
// third wake path: LAUNCH the Default Media Receiver (CC1AD845) and, once the TV is up, STOP it again so the Cast
// splash never stays on screen. Home Assistant's cast integration turns a device on the same way ("The only way we
// can turn the Chromecast on is by launching an app", homeassistant/components/cast/media_player.py).
// Zero dependencies: the CastMessage protobuf (cast_channel.proto) is six fields, so it is encoded by hand here.
// TLS with no certificate check: every Cast receiver presents a self-signed device certificate, and this only ever
// talks to one literal LAN address. GET_STATUS is read-only; LAUNCH and STOP change the screen.
import tls from "node:tls";

export const CAST_PORT = 8009;
export const DEFAULT_MEDIA_RECEIVER = "CC1AD845";
const NS = {
  conn: "urn:x-cast:com.google.cast.tp.connection",
  heartbeat: "urn:x-cast:com.google.cast.tp.heartbeat",
  receiver: "urn:x-cast:com.google.cast.receiver",
};

// ---------- protobuf, just enough of it ----------
const varint = n => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
const field = (no, wire, body) => Buffer.concat([varint((no << 3) | wire), body]);
const str = (no, s) => { const b = Buffer.from(String(s), "utf8"); return field(no, 2, Buffer.concat([varint(b.length), b])); };

/** One CastMessage, framed: a 4-byte big-endian length, then the protobuf (version 0, payload type STRING). */
export function encodeCastMessage({ source = "sender-0", destination = "receiver-0", namespace, data }) {
  const body = Buffer.concat([field(1, 0, varint(0)), str(2, source), str(3, destination), str(4, namespace),
    field(5, 0, varint(0)), str(6, typeof data === "string" ? data : JSON.stringify(data))]);
  const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/** A CastMessage body (no length prefix) -> {source, destination, namespace, payload}. Unknown fields are skipped. */
export function decodeCastMessage(buf) {
  const out = {}; let i = 0;
  const readVarint = () => { let n = 0, shift = 0, b; do { b = buf[i++]; n |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80 && i < buf.length); return n >>> 0; };
  while (i < buf.length) {
    const tag = readVarint(), no = tag >>> 3, wire = tag & 7;
    if (wire === 0) { readVarint(); continue; }
    if (wire !== 2) throw new Error(`cast: unsupported wire type ${wire}`);
    const len = readVarint(), v = buf.subarray(i, i + len); i += len;
    if (no === 2) out.source = v.toString("utf8");
    else if (no === 3) out.destination = v.toString("utf8");
    else if (no === 4) out.namespace = v.toString("utf8");
    else if (no === 6) out.payload = v.toString("utf8");
  }
  return out;
}

/** Splits a TCP stream into framed messages: feed(chunk) returns every complete message decoded. */
export function createFramer() {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = Buffer.concat([buf, chunk]);
    const out = [];
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > 1 << 20) throw new Error("cast: message too large");
      if (buf.length < 4 + len) break;
      out.push(decodeCastMessage(buf.subarray(4, 4 + len)));
      buf = buf.subarray(4 + len);
    }
    return out;
  };
}

/**
 * One request to the platform receiver ("receiver-0"): CONNECT, then `request` with a requestId, and resolve with the
 * first reply carrying that requestId (RECEIVER_STATUS, LAUNCH_ERROR, ...). PINGs are answered while waiting.
 */
export function castRequest(host, request, { port = CAST_PORT, timeoutMs = 8000, connect = tls.connect } = {}) {
  return new Promise((resolve, reject) => {
    const requestId = 1 + Math.floor(Math.random() * 1e6);
    const feed = createFramer();
    let done = false;
    const finish = (err, v) => { if (done) return; done = true; clearTimeout(t); try { sock.end(); sock.destroy(); } catch { /* gone */ } err ? reject(err) : resolve(v); };
    const t = setTimeout(() => finish(new Error("cast: timed out")), timeoutMs);
    const sock = connect({ host, port, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      sock.write(encodeCastMessage({ namespace: NS.conn, data: { type: "CONNECT" } }));
      sock.write(encodeCastMessage({ namespace: NS.receiver, data: { ...request, requestId } }));
    });
    sock.on("data", chunk => {
      let msgs; try { msgs = feed(chunk); } catch (e) { return finish(e); }
      for (const m of msgs) {
        let p; try { p = JSON.parse(m.payload || "null"); } catch { continue; }
        if (m.namespace === NS.heartbeat && p?.type === "PING") sock.write(encodeCastMessage({ namespace: NS.heartbeat, data: { type: "PONG" } }));
        else if (p && p.requestId === requestId) finish(null, p);
      }
    });
    sock.on("error", e => finish(new Error(`cast: ${e.code || e.message}`)));
    sock.on("close", () => finish(new Error("cast: connection closed")));
  });
}

/** RECEIVER_STATUS -> {apps:[{appId, name, sessionId}], standby, active_input, volume}. Read-only. */
export async function castStatus(host, opts) {
  const r = await castRequest(host, { type: "GET_STATUS" }, opts);
  return summariseStatus(r);
}
export function summariseStatus(r) {
  const s = r?.status || {};
  return { apps: (s.applications || []).map(a => ({ appId: a.appId, name: a.displayName || null, sessionId: a.sessionId || null, idle: !!a.isIdleScreen })),
    standby: typeof s.isStandBy === "boolean" ? s.isStandBy : null, active_input: typeof s.isActiveInput === "boolean" ? s.isActiveInput : null,
    volume: s.volume ? { level: s.volume.level ?? null, muted: s.volume.muted ?? null } : null };
}

/** LAUNCH an app (default: the Default Media Receiver). Changes the screen. Resolves with the summarised status. */
export async function castLaunch(host, appId = DEFAULT_MEDIA_RECEIVER, opts) {
  const r = await castRequest(host, { type: "LAUNCH", appId }, { timeoutMs: 15e3, ...opts });
  if (r.type !== "RECEIVER_STATUS") throw new Error(`cast: ${r.type}${r.reason ? ` (${r.reason})` : ""}`);
  return summariseStatus(r);
}

/** STOP one session (the splash this module launched). */
export async function castStop(host, sessionId, opts) {
  const r = await castRequest(host, { type: "STOP", sessionId }, opts);
  return summariseStatus(r);
}
