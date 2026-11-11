// Server-Sent Events: one broadcaster, many clients, a comment ping every 15 s so proxies and the TV's browser keep
// the stream open, and clients removed the moment their socket closes.
export function createSse({ pingMs = 15e3 } = {}) {
  const clients = new Set();
  const ping = setInterval(() => { for (const c of clients) write(c, ": ping\n\n"); }, pingMs);
  ping.unref();

  function write(c, s) {
    try { if (!c.res.writableEnded && !c.res.destroyed) c.res.write(s); else drop(c); } catch { drop(c); }
  }
  function drop(c) { if (clients.delete(c)) { try { c.res.end(); } catch { /* gone */ } c.onClose?.(); } }

  return {
    clients,
    get size() { return clients.size; },
    /** Take over a response as an event stream. `info` is kept for the status page (ip, device, since). */
    attach(req, res, info = {}, { headers = {}, onClose } = {}) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store",
        connection: "keep-alive", "x-accel-buffering": "no", ...headers });
      res.write("retry: 5000\n\n");
      req.socket.setKeepAlive?.(true);
      req.socket.setNoDelay?.(true);
      const c = { res, info: { ...info, since: new Date().toISOString() }, onClose };
      clients.add(c);
      req.on("close", () => drop(c));
      res.on("close", () => drop(c));
      return c;
    },
    /** Send one event to every client that did not ask to skip it (info.skip). Data is JSON-encoded (one line, so no escaping is needed). */
    send(event, data) {
      const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const c of clients) if (!c.info.skip?.includes(event)) write(c, s);
    },
    close() { clearInterval(ping); for (const c of [...clients]) drop(c); },
  };
}
