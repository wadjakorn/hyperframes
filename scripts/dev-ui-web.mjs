#!/usr/bin/env node
// dev-ui-web.mjs — a tiny, dependency-free web UI to manage HyperFrames dev servers.
//
// It is a thin wrapper over scripts/dev-ui.sh: every action shells out to that
// script (via execFile — no shell, so project names can't inject), so the shell
// script stays the single source of truth for process orchestration.
//
//   node scripts/dev-ui-web.mjs            # serve on 0.0.0.0:4173
//   WEB_PORT=8080 node scripts/dev-ui-web.mjs
//
// Then open http://<this-box>:4173 from your laptop.
//
// Forward-host: links to preview/studio are built from the SAME host you used to
// reach this page (the request Host header), so they work from wherever you are —
// provided the started servers are exposed (the "Expose to network" toggle).

import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, createWriteStream, writeFileSync, existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(__dirname, "dev-ui.sh");
const CLI = join(REPO_ROOT, "packages/cli/dist/cli.js");
const WEB_PORT = Number(process.env.WEB_PORT || 4173);
const BUN_BIN = join(process.env.HOME || "", ".bun", "bin");
// permission mode for the headless agent; acceptEdits auto-applies file edits
// without prompting (safe default). Override with bypassPermissions for full autonomy.
const AGENT_PERM = process.env.DEVUI_AGENT_PERMISSION || "acceptEdits";
const JOB_DIR = join(REPO_ROOT, ".dev-ui", "jobs");
mkdirSync(JOB_DIR, { recursive: true });
const CHILD_ENV = () => ({ ...process.env, PATH: `${BUN_BIN}:${process.env.PATH}` });

// This is an UNAUTHENTICATED local dev tool: it can start/stop servers and run an
// agent that edits repo files. So it binds loopback by default — network exposure
// is an explicit opt-in (DEVUI_WEB_HOST=0.0.0.0), intended only for a trusted
// private network (LAN / Tailscale). Disable the file-editing agent with
// DEVUI_AGENT=off. There is deliberately no auth (see PR description / README).
const WEB_HOST = process.env.DEVUI_WEB_HOST || "127.0.0.1";
const EXPOSED = WEB_HOST !== "127.0.0.1" && WEB_HOST !== "localhost";
const AGENT_ENABLED = process.env.DEVUI_AGENT !== "off";

// run dev-ui.sh with args; returns { code, stdout, stderr }
function runScript(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [SCRIPT, ...args],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PATH: `${BUN_BIN}:${process.env.PATH}`, ...extraEnv },
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
      },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// ── jobs registry — tracked background processes (render / transcribe / agent) ─
const jobs = new Map();
let jobSeq = 0;
const newJobId = () => `j${Date.now().toString(36)}${(jobSeq++).toString(36)}`;
// parse a percentage out of a progress line; null if none (indeterminate)
const pctFrom = (line) => {
  const m = line.match(/(\d{1,3})\s*%/);
  return m ? Math.min(100, Number(m[1])) : null;
};
const jobView = (j) => ({
  id: j.id,
  kind: j.kind,
  project: j.project,
  state: j.state,
  pct: j.pct,
  lastLine: j.lastLine,
  startedAt: j.startedAt,
  endedAt: j.endedAt,
  exitCode: j.exitCode,
});
const persistJob = (j) => {
  try {
    writeFileSync(join(JOB_DIR, `${j.id}.json`), JSON.stringify(jobView(j)));
  } catch {
    /* best-effort */
  }
};
// update job state from one output line (+ optional caller hook)
function handleLine(job, line, onLine) {
  job.lastLine = line.slice(0, 300);
  const p = pctFrom(line);
  if (p != null) job.pct = p;
  if (onLine) onLine(line, job);
}
// spawn a tracked background job; returns the job (with .child)
function startJob({ kind, project, cmd, args, cwd, onLine }) {
  const id = newJobId();
  const log = createWriteStream(join(JOB_DIR, `${id}.log`), { flags: "a" });
  const child = spawn(cmd, args, { cwd: cwd || REPO_ROOT, env: CHILD_ENV() });
  const job = {
    id,
    kind,
    project,
    pid: child.pid,
    state: "running",
    pct: null,
    lastLine: "",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    child,
  };
  jobs.set(id, job);
  persistJob(job);
  const feed = (buf) => {
    const text = buf.toString();
    log.write(text);
    for (const line of text.split(/\r?\n/)) if (line.trim()) handleLine(job, line, onLine);
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.on("close", (code) => {
    job.state = code === 0 ? "done" : job.state === "stopped" ? "stopped" : "failed";
    job.exitCode = code;
    job.endedAt = Date.now();
    job.child = null;
    log.end();
    persistJob(job);
  });
  return job;
}
function stopJobById(id) {
  const j = jobs.get(id);
  if (!j || !j.child) return false;
  j.state = "stopped";
  try {
    j.child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  return true;
}
// project path allowlist: repo-relative, no traversal, must be a real composition
const isSafeRel = (p) => /^[\w./-]+$/.test(p) && !p.includes("..");
const safeProjectPath = (raw) => {
  const p = String(raw || "").replace(/\\/g, "/");
  if (!isSafeRel(p)) return null;
  return existsSync(join(REPO_ROOT, p, "index.html")) ? p : null;
};
// parse one `claude --output-format stream-json` line into a display event
const assistantText = (j) =>
  (j.message?.content || [])
    .map((c) => (c.type === "text" ? c.text : c.type === "tool_use" ? `→ ${c.name}` : ""))
    .filter(Boolean)
    .join("\n");
// per-type renderers; system keeps only session init (drops hook_* noise)
const AGENT_EVENT = {
  assistant: (j) => ({ t: "assistant", text: assistantText(j) }),
  result: (j) => ({ t: "result", text: j.result || (j.is_error ? "(error)" : "(done)") }),
  system: (j) => (j.subtype === "init" ? { t: "system", text: "session started" } : null),
};
function agentEvent(line) {
  const j = parseJson(line);
  const fn = j && AGENT_EVENT[j.type];
  return fn ? fn(j) : null;
}

// host the CLIENT used to reach us (forward-host) — strip port, keep hostname
const clientHost = (req) => (req.headers.host || "localhost").split(":")[0];
const parseJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const errMessage = (e) => (e && e.message ? e.message : String(e));
const exposeEnv = (b) => (b.expose ? { EXPOSE: "1" } : {});
// reply from a script run: 200/500 by exit code, with combined output
const replyRun = (res, r) =>
  send(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, output: r.stdout + r.stderr });
const html = (_req, res) => send(res, 200, PAGE, "text/html; charset=utf-8");

// ── route handlers (one per endpoint, kept small so the dispatcher stays flat) ─
async function getStatus(req, res) {
  const host = clientHost(req); // forward-host: build URLs from the host the client used
  const { stdout } = await runScript(["status", "--json"]);
  const instances = (parseJson(stdout.trim()) ?? []).map((i) => ({
    ...i,
    url: `http://${host}:${i.port}`,
  }));
  send(res, 200, { instances, host });
}
async function getProjects(_req, res) {
  const { stdout } = await runScript(["projects", "--json"]);
  send(res, 200, { projects: parseJson(stdout.trim()) ?? [] });
}
async function postStart(req, res) {
  const b = await readBody(req);
  const project = safeProjectPath(b.project);
  if (!project) return send(res, 400, { ok: false, error: "unknown project" });
  replyRun(res, await runScript(["start", project], exposeEnv(b)));
}
async function postStudio(req, res) {
  const b = await readBody(req);
  replyRun(res, await runScript(["studio"], exposeEnv(b)));
}
// stop + restart share a shape: one `target`, one script command
const targetCmd = (cmd) => async (req, res) => {
  const b = await readBody(req);
  if (!b.target) return send(res, 400, { ok: false, error: "target required" });
  replyRun(res, await runScript([cmd, String(b.target)]));
};
// normalize + validate a project name; null if invalid
const cleanName = (raw) => {
  const name = String(raw || "").trim();
  return /^[a-zA-Z0-9_-]+$/.test(name) ? name : null;
};
const createArgs = (b, name) => {
  const args = ["create", name];
  if (b.example) args.push("--example", String(b.example));
  if (b.resolution) args.push("--resolution", String(b.resolution));
  return args;
};
async function postCreate(req, res) {
  const b = await readBody(req);
  const name = cleanName(b.name);
  if (!name) return send(res, 400, { ok: false, error: "name: letters, digits, - _ only" });
  const r = await runScript(createArgs(b, name));
  if (r.code !== 0) return send(res, 500, { ok: false, output: r.stdout + r.stderr });
  if (!b.start) return send(res, 200, { ok: true, output: r.stdout });
  // optionally start a server for the new project right away
  const s = await runScript(["start", `projects/${name}`], exposeEnv(b));
  send(res, 200, { ok: s.code === 0, output: r.stdout + s.stdout + s.stderr });
}

const byNewest = (a, b) => b.startedAt - a.startedAt;
function getJobs(_req, res) {
  send(res, 200, { jobs: [...jobs.values()].map(jobView).sort(byNewest) });
}
async function postRenderJob(req, res) {
  const b = await readBody(req);
  const project = safeProjectPath(b.project);
  if (!project) return send(res, 400, { ok: false, error: "unknown project" });
  const job = startJob({ kind: "render", project, cmd: "node", args: [CLI, "render", project] });
  send(res, 200, { ok: true, id: job.id });
}
async function postJobStop(req, res) {
  const b = await readBody(req);
  send(res, 200, { ok: stopJobById(String(b.id || "")) });
}
// env doctor: shells out to `dev-ui.sh doctor --json`. Check-only from the web
// (cheap fixes: bun symlink, git identity); the heavy model prefetch stays a
// terminal op (`dev-ui.sh doctor --prefetch`) so a request can't hang on a GB download.
async function postDoctor(_req, res) {
  const { stdout } = await runScript(["doctor", "--json"]);
  send(res, 200, parseJson(stdout.trim()) ?? { ok: false, checks: [] });
}
// SSE: start an agent job in the project and stream its events to the browser
const trimmed = (v) => String(v ?? "").trim();
async function postAgent(req, res) {
  if (!AGENT_ENABLED)
    return send(res, 403, { ok: false, error: "agent disabled (DEVUI_AGENT=off)" });
  const b = await readBody(req);
  const project = safeProjectPath(b.project);
  const prompt = trimmed(b.prompt);
  if (!project || !prompt)
    return send(res, 400, { ok: false, error: "project and prompt required" });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const job = startJob({
    kind: "agent",
    project,
    cwd: join(REPO_ROOT, project),
    cmd: "claude",
    args: [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      AGENT_PERM,
    ],
    onLine: (line) => {
      const e = agentEvent(line);
      if (e && e.text) sse(e);
    },
  });
  sse({ t: "start", text: `agent on ${project} · job ${job.id}` });
  job.child.on("close", (code) => {
    sse({ t: "end", text: `finished (exit ${code})` });
    res.end();
  });
  req.on("close", () => {}); // keep the job running even if the browser tab closes
}

const ROUTES = {
  "GET /": html,
  "GET /index.html": html,
  "GET /api/status": getStatus,
  "GET /api/projects": getProjects,
  "GET /api/jobs": getJobs,
  "POST /api/start": postStart,
  "POST /api/studio": postStudio,
  "POST /api/stop": targetCmd("stop"),
  "POST /api/restart": targetCmd("restart"),
  "POST /api/create": postCreate,
  "POST /api/jobs/render": postRenderJob,
  "POST /api/jobs/stop": postJobStop,
  "POST /api/doctor": postDoctor,
  "POST /api/agent": postAgent,
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const handler = ROUTES[`${req.method} ${url.pathname}`];
  try {
    if (handler) await handler(req, res);
    else send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: errMessage(e) });
  }
});

server.listen(WEB_PORT, WEB_HOST, () => {
  console.log(`dev-ui console on http://${WEB_HOST}:${WEB_PORT}/`);
  if (EXPOSED)
    console.log(
      "  ⚠ exposed on the network with NO auth — anyone who can reach this port can\n" +
        "    control servers and run the file-editing agent. Use only on a trusted LAN/Tailscale.",
    );
  else console.log("  loopback only — set DEVUI_WEB_HOST=0.0.0.0 to reach it from another device");
  if (!AGENT_ENABLED) console.log("  agent endpoint disabled (DEVUI_AGENT=off)");
});

// ── single-page UI (served from dev-ui-web.html; edit that file for design) ──
const PAGE = readFileSync(join(__dirname, "dev-ui-web.html"), "utf8");
