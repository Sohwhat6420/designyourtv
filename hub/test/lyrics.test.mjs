import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { quietHub, raw, tmpDir, collectSse } from "./helpers.mjs";
import { parseLrc, lineAt, cleanTitle, cleanArtist, trackOf, keyOf, createLyricsReader, USER_AGENT } from "../lib/lyrics.mjs";

const LRC = `[ar:Some Artist]
[ti:Some Song]
[length: 03:30]
[offset:+500]
[00:12.00]First line
[00:20.5]Second line
[00:25]<00:25.00>Third <00:26.10>line
[01:00.000][02:30.25]Chorus line
[00:40.00]
[1:02:03.50]Past an hour
not a lyric line
`;

test("lrc: timestamps in every form, several per line, offset, enhanced tags, gaps kept, sorted", () => {
  const l = parseLrc(LRC);
  assert.deepEqual(l.map(x => x.t_s), [11.5, 20, 24.5, 39.5, 59.5, 149.75, 3723]);
  assert.deepEqual(l.map(x => x.text), ["First line", "Second line", "Third line", "", "Chorus line", "Chorus line", "Past an hour"]);
  assert.deepEqual(parseLrc("[00:01.00]a\r\n[00:00.50]b\r\n").map(x => x.text), ["b", "a"], "CRLF, and sorted by time");
  assert.deepEqual(parseLrc("[offset:-1000]\n[00:01.00]late"), [{ t_s: 2, text: "late" }], "a negative offset pushes lines later");
  assert.deepEqual(parseLrc(""), []);
  assert.deepEqual(parseLrc(null), []);
  assert.equal(parseLrc("[00:00.20]early\n[offset:+5000]")[0].t_s, 0, "never below zero");
});

test("lrc: the line to show at a position", () => {
  const l = parseLrc("[00:10.00]a\n[00:20.00]b\n[00:30.00]c");
  assert.equal(lineAt(l, 5).index, -1);
  assert.equal(lineAt(l, 5).next.text, "a");
  assert.equal(lineAt(l, 10).current.text, "a");
  assert.equal(lineAt(l, 29.9).current.text, "b");
  assert.equal(lineAt(l, 99).current.text, "c");
  assert.equal(lineAt(l, 99).next, null);
});

test("track: only title, artist, album and length are read; noise players add is cleaned for the retry", () => {
  const np = { status: "playing", title: "Song (Official Video)", artist: "Band - Topic", album: "LP", duration_s: 215.4, app: "Chrome", position_s: 12, secret: "x" };
  assert.deepEqual(trackOf(np), { title: "Song (Official Video)", artist: "Band", album: "LP", duration_s: 215 });
  assert.equal(cleanTitle("Song (Official Video)"), "Song");
  assert.equal(cleanTitle("Song [Lyrics] (feat. Guest)"), "Song");
  assert.equal(cleanTitle("Song - Remastered 2011"), "Song - Remastered 2011", "a real title is not mangled");
  assert.equal(cleanArtist("Band - Topic"), "Band");
  assert.equal(trackOf({ status: "none" }), null);
  assert.equal(trackOf({ status: "playing", title: "x", artist: "" }), null);
  assert.equal(trackOf({ status: "playing", title: "x", artist: "y", duration_s: 0 }).duration_s, null, "a stream with no length sends none");
  assert.equal(keyOf(trackOf(np)), keyOf(trackOf({ ...np, status: "paused", position_s: 99 })), "pausing is not a new track");
});

const resp = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: k => ({ "content-type": "application/json", ...headers })[k.toLowerCase()] ?? null }, json: async () => body });
const REC = { id: 77, trackName: "Song", artistName: "Band", duration: 215, instrumental: false, plainLyrics: "a\nb", syncedLyrics: "[00:01.00]a\n[00:05.00]b" };
const NP = { status: "playing", title: "Song", artist: "Band", album: "LP", duration_s: 215 };

test("reader: sends only the track's four fields and a User-Agent; parses; caches on disk across restarts", async () => {
  const dir = tmpDir("lyr"), calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: new URL(url), init }); return resp(200, REC); };
  const r1 = createLyricsReader({ fetchImpl, cacheDir: dir });
  const a = await r1.get({ ...NP, position_s: 9, app: "MusicBee", note: "private" });
  assert.equal(a.status, "synced");
  assert.deepEqual(a.lines, [{ t_s: 1, text: "a" }, { t_s: 5, text: "b" }]);
  assert.deepEqual(a.track, { title: "Song", artist: "Band", album: "LP", duration_s: 215 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin + calls[0].url.pathname, "https://lrclib.net/api/get");
  assert.deepEqual([...calls[0].url.searchParams.keys()].sort(), ["album_name", "artist_name", "duration", "track_name"], "nothing but the metadata");
  assert.equal(calls[0].init.headers["user-agent"], USER_AGENT);
  assert.match(USER_AGENT, /^tv-wallpaper-hub\/1\.0/);
  assert.equal((await r1.get(NP)).cached, true, "the second ask is the memory copy");
  assert.equal(calls.length, 1);
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  assert.equal(files.length, 1);
  assert.ok(!fs.readdirSync(dir).some(f => f.endsWith(".tmp")), "written atomically");

  const r2 = createLyricsReader({ fetchImpl: async () => { throw new Error("must not be called"); }, cacheDir: dir });
  const b = await r2.get(NP);
  assert.equal(b.status, "synced"); assert.equal(b.cached, true); assert.equal(b.lines.length, 2);
});

test("reader: a 404 retries cleaned up, then searches; the miss is cached on disk; a search hit must be within 5 s of the length", async () => {
  const dir = tmpDir("lyr"), seen = [];
  const fetchImpl = async url => {
    const u = new URL(url); seen.push(u.pathname.split("/").pop() + ":" + [...u.searchParams.keys()].join(","));
    if (u.pathname.endsWith("/get")) return resp(404, { name: "TrackNotFound" });
    return resp(200, [{ ...REC, id: 1, duration: 300 }, { ...REC, id: 2, duration: 214 }]);
  };
  const r = createLyricsReader({ fetchImpl, cacheDir: dir });
  const a = await r.get({ ...NP, title: "Song (Official Video)" });
  assert.deepEqual(seen, ["get:track_name,artist_name,album_name,duration", "get:track_name,artist_name", "search:track_name,artist_name"]);
  assert.equal(a.status, "synced"); assert.equal(a.id, 2, "the 214 s recording, not the 300 s one");

  const miss = createLyricsReader({ fetchImpl: async () => resp(404, {}), cacheDir: tmpDir("lyr") });
  const m = await miss.get({ ...NP, title: "Nope" });
  assert.deepEqual([m.status, m.why], ["none", "no match on LRCLIB"]);
});

test("reader: a miss is remembered on disk for the next start", async () => {
  const dir = tmpDir("lyr");
  const miss = createLyricsReader({ fetchImpl: async () => resp(404, {}), cacheDir: dir });
  assert.equal((await miss.get(NP)).status, "none");
  const next = createLyricsReader({ fetchImpl: async () => { throw new Error("must not be called"); }, cacheDir: dir });
  const n = await next.get(NP);
  assert.deepEqual([n.status, n.cached], ["none", true]);
});

test("reader: instrumental, unsynced-only and nothing-playing all answer none or instrumental without extra calls", async () => {
  const inst = createLyricsReader({ fetchImpl: async () => resp(200, { ...REC, instrumental: true, syncedLyrics: null, plainLyrics: null }) });
  assert.equal((await inst.get(NP)).status, "instrumental");
  const plain = createLyricsReader({ fetchImpl: async () => resp(200, { ...REC, syncedLyrics: null }) });
  const p = await plain.get(NP);
  assert.deepEqual([p.status, p.why], ["none", "only unsynced words exist"]);
  let calls = 0;
  const idle = createLyricsReader({ fetchImpl: async () => { calls++; return resp(200, REC); } });
  assert.deepEqual([(await idle.get({ status: "none" })).status, (await idle.get(undefined)).status, calls], ["none", "none", 0]);
});

test("reader: a network failure or a 429 says none, is not cached on disk, and pauses LRCLIB calls", async () => {
  const dir = tmpDir("lyr");
  let t = 1_000_000, calls = 0, mode = "boom";
  const fetchImpl = async () => { calls++; if (mode === "boom") throw new Error("getaddrinfo ENOTFOUND"); if (mode === "429") return resp(429, {}, { "retry-after": "10" }); return resp(200, REC); };
  const r = createLyricsReader({ fetchImpl, cacheDir: dir, now: () => t });
  const a = await r.get(NP);
  assert.deepEqual([a.status, a.why, calls], ["none", "LRCLIB unreachable", 1]);
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, "a failure is never written to the cache");
  await r.get(NP);
  assert.equal(calls, 1, "a minute's cool-down: no second call");
  t += 61e3; mode = "429";
  await r.get(NP);
  assert.equal(calls, 2);
  t += 5e3; await r.get(NP);
  assert.equal(calls, 2, "Retry-After (10 s, plus a margin) is honoured");
  t += 20e3; mode = "ok";
  assert.equal((await r.get(NP)).status, "synced");
});

test("reader: a corrupt cache file is ignored and replaced", async () => {
  const dir = tmpDir("lyr");
  const r = createLyricsReader({ fetchImpl: async () => resp(200, REC), cacheDir: dir });
  await r.get(NP);
  const f = fs.readdirSync(dir)[0];
  fs.writeFileSync(`${dir}/${f}`, "{not json");
  const r2 = createLyricsReader({ fetchImpl: async () => resp(200, REC), cacheDir: dir });
  assert.equal((await r2.get(NP)).status, "synced");
  assert.ok(JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")).result);
});

test("hub: /api/lyrics for the playing track, and a lyrics event on a track change only", async () => {
  const listeners = []; let np = { status: "none" };
  const monitor = { snapshot: () => ({}), nowPlaying: () => np, on: (ev, fn) => ev === "nowplaying" && listeners.push(fn), stop() {} };
  const emit = n => { np = n; listeners.forEach(f => f(n)); };
  const seen = [];
  const fetchImpl = async url => { seen.push(new URL(url).searchParams.get("track_name")); return resp(200, { ...REC, trackName: new URL(url).searchParams.get("track_name") }); };
  const hub = await quietHub({ monitor, systemMs: 60e3, lyrics: createLyricsReader({ fetchImpl, cacheDir: tmpDir("lyr") }) });
  try {
    assert.deepEqual(JSON.parse((await raw(hub.port, "/api/lyrics")).body), { status: "none", why: "nothing is playing", lines: [], track: null, key: null });
    const evP = collectSse(`${hub.url}/api/events`, ev => ev.filter(e => e.ev === "lyrics").length >= 2, 3000);
    await new Promise(r => setTimeout(r, 250));
    emit({ ...NP });
    await new Promise(r => setTimeout(r, 250));
    emit({ ...NP, status: "paused", position_s: 40 });           // same track: no new event, no new lookup
    await new Promise(r => setTimeout(r, 150));
    emit({ ...NP, title: "Other", duration_s: 180 });
    const events = (await evP).filter(e => e.ev === "lyrics");
    assert.deepEqual(events.map(e => [e.data.status, e.data.track.title]), [["synced", "Song"], ["synced", "Other"]]);
    assert.deepEqual(seen, ["Song", "Other"], "pause did not look anything up");
    const api = JSON.parse((await raw(hub.port, "/api/lyrics")).body);
    assert.deepEqual([api.status, api.track.title, api.lines.length], ["synced", "Other", 2]);
    assert.equal((await raw(hub.port, "/api/lyrics?title=Evil&artist=X")).status, 200);
    assert.deepEqual(seen, ["Song", "Other"], "query strings are ignored: only the playing track is ever looked up");
    const late = await collectSse(`${hub.url}/api/events`, e => e.some(x => x.ev === "lyrics"), 1500);
    assert.equal(late.find(e => e.ev === "lyrics").data.track.title, "Other", "a page that connects mid-song is sent the current words");
  } finally { await hub.close(); }
});

test("reader: if the exact lookups say 'no such track' but the search is busy (503), it says none and asks again later", async () => {
  const dir = tmpDir("lyr");
  let busy = true, calls = 0;
  const fetchImpl = async url => { calls++; return new URL(url).pathname.endsWith("/search") ? (busy ? resp(503, {}, { "retry-after": "1" }) : resp(200, [REC])) : resp(404, {}); };
  let t = 5_000_000;
  const r = createLyricsReader({ fetchImpl, cacheDir: dir, now: () => t });
  const a = await r.get(NP);
  assert.deepEqual([a.status, a.why], ["none", "no match on LRCLIB (search unavailable)"]);
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, "not cached");
  busy = false; t += 5e3;
  assert.equal((await r.get(NP)).status, "synced");
});
