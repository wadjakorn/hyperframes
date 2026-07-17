#!/usr/bin/env node
// Review server for the project's renders/. Node http is concurrent and handles
// Range, so video seeking works and one stalled request can't block everything
// (which is what kept hanging python's single-threaded http.server).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(process.cwd(), "renders");
const PORT = Number(process.env.PORT ?? 3066);

// Enumerate reachable addresses instead of hardcoding one — works on any host.
const addresses = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
const TYPES = {
  ".mp4": "video/mp4",
  ".html": "text/html; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
};

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(ROOT, rel === "/" ? "review.html" : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end("not found");
    }
    const size = fs.statSync(file).size;
    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": size,
        "Accept-Ranges": "bytes",
      });
      return fs.createReadStream(file).pipe(res);
    }
    const [s, e] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(s, 10) || 0;
    const end = e ? parseInt(e, 10) : size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": type,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`review server on :${PORT}`);
    for (const a of ["localhost", ...addresses()]) console.log(`  http://${a}:${PORT}/`);
  });
