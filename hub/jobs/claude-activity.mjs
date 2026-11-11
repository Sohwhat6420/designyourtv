// Count Claude Code activity per day (Singapore time) from local transcripts: counts only, no content kept.
// Usage: node claude-activity.mjs <projectsDir> <out.json>
// The hub runs this once a day at about 04:00 SGT as a windowless, below-normal-priority child (hub/server.mjs).
// It reads ~/.claude/projects/**/*.jsonl (several GB, so it takes minutes) and writes the result atomically.
//
// Tokens: every API reply is written once per content block, all
// copies carrying the same usage, so each reply counts once by message id + request id. A reply's tokens are its input,
// output, cache writes and cache reads, the way ccusage and the Console add them up. Only this machine's transcripts:
// claude.ai chats, the phone and other computers have no local record, so the total is "Claude Code on this PC".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const [root, outFile] = process.argv.slice(2);
if (!root || !outFile) { console.error("usage: node claude-activity.mjs <projectsDir> <out.json>"); process.exit(2); }
const files = [];
(function walk(d) {
  let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of entries) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".jsonl")) files.push(p); }
})(root);
const days = {}, prompts = {}, tokens = {}, tsRe = /"timestamp":"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/;
const idRe = /"id":"(msg_[A-Za-z0-9_-]+)"/, reqRe = /"requestId":"([A-Za-z0-9_-]+)"/;
const FIELDS = { input: /"input_tokens":(\d+)/, output: /"output_tokens":(\d+)/, cache_write: /"cache_creation_input_tokens":(\d+)/, cache_read: /"cache_read_input_tokens":(\d+)/ };
const sum = { input: 0, output: 0, cache_write: 0, cache_read: 0 }, seen = new Set();
const sgDay = iso => new Date(Date.parse(iso + ":00Z") + 8 * 3600e3).toISOString().slice(0, 10);
for (const f of files) {
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      const isA = line.includes('"type":"assistant"'), isP = !isA && line.includes('"type":"user"') && line.includes('"role":"user","content":"');
      if (!isA && !isP) continue;
      const m = tsRe.exec(line); if (!m) continue;
      const d = sgDay(m[1]);
      if (!isA) { prompts[d] = (prompts[d] || 0) + 1; continue; }
      days[d] = (days[d] || 0) + 1;
      const u = line.indexOf('"usage":{'); if (u < 0) continue;
      const id = idRe.exec(line), rq = reqRe.exec(line), key = (id ? id[1] : "") + ":" + (rq ? rq[1] : "");
      if (key !== ":") { if (seen.has(key)) continue; seen.add(key); }
      const usage = line.slice(u, u + 1200);           // the usage block itself: quotes inside the reply's text are escaped, so never match
      let n = 0;
      for (const [k, re] of Object.entries(FIELDS)) { const x = re.exec(usage); if (x) { sum[k] += +x[1]; n += +x[1]; } }
      if (n) tokens[d] = (tokens[d] || 0) + n;
    }
  } catch { /* a file being written or removed mid-read */ }
}
const total = Object.values(sum).reduce((a, b) => a + b, 0);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const tmp = `${outFile}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify({ made: new Date().toISOString(), tz: "Asia/Singapore", device: os.hostname(),
  note: "assistant replies, typed prompts and tokens (input + output + cache writes + cache reads, each reply once) per day; counts only",
  replies: days, prompts, tokens, total, breakdown: sum, first: Object.keys(days).sort()[0] || null }, null, 0));
fs.renameSync(tmp, outFile);
console.log("days", Object.keys(days).length, "files", files.length, "replies", seen.size, "tokens", total);
