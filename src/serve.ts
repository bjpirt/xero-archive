import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, SITE_DIR, DATA_DIR } from "./config";
import { log } from "./log";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

/**
 * Serves the project root but ONLY exposes the `site/` and `data/` folders —
 * so .env and .tokens.json are never reachable. Rooted at ROOT so the site can
 * reference ../../data/... for attachments and reports.
 */
export function serve(port = 4180): void {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
      let rel = urlPath === "/" ? "/site/index.html" : urlPath;
      const full = path.normalize(path.join(ROOT, rel));

      // Path guard: only inside site/ or data/.
      const inSite = full === SITE_DIR || full.startsWith(SITE_DIR + path.sep);
      const inData = full === DATA_DIR || full.startsWith(DATA_DIR + path.sep);
      if (!inSite && !inData) {
        res.writeHead(403).end("Forbidden");
        return;
      }

      let target = full;
      if (existsSync(target) && statSync(target).isDirectory()) {
        target = path.join(target, "index.html");
      }
      if (!existsSync(target)) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream" });
      createReadStream(target).pipe(res);
    } catch {
      res.writeHead(500).end("Server error");
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}/site/index.html`;
    log.ok(`Serving archive at ${url}`);
    log.info("Press Ctrl+C to stop.");
    openBrowser(url);
  });
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    /* ignore */
  }
}
