import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { getVaultRoot, getProjectMetadata, ensureVaultStructure, resolveConfiguredPorts } from "./vault.js";
import { getVaultProjectList } from "./canvas.js";
import { ActivityBus, ActivityEvent, eventMatchesProjectFilter } from "./activity.js";
import { getPackageVersion } from "./version.js";
import {
  exportVault,
  importVault,
  resetVault,
  listBackups,
  persistVaultBackup,
  deleteBackup,
  inspectBackup,
  resolveBackupPath
} from "./backup.js";
import { packVaultZip, unpackVaultZip, parseMultipartFormData } from "./status-backup.js";
import { logErrorReport } from "./error-logger.js";
import { recordTelemetry } from "./telemetry.js";
import { getRecord } from "./store.js";
import { sanitizeToolOutput, isPathInside } from "./safety.js";
import { scheduleHybridPush } from "./hybrid-sync.js";
import { TopologyInfo, TopologyRole, BackupFileInfo, BackupListFilters } from "./types.js";
import { listMemoryRecords } from "./hits.js";
import {
  readWikiFile,
  readWikiSection,
  regenerateWiki,
  WikiError
} from "./wiki.js";
import {
  VaultManagerError,
  setProjectAlias,
  removeProjectAlias,
  mergeVaultProjects,
  createVaultProject,
  updateVaultProject,
  deleteVaultProject
} from "./vault-manager.js";
import {
  listPrompts,
  searchPrompts,
  listSessions,
  getSessionTurns,
  exportSessionStory,
  generateActivityReport,
  deriveRulesFromPrompts
} from "./prompt.js";

/** Zero-dep markdown → safe HTML for prompt drawer (interview Q4). */
export function renderPromptMarkdownHtml(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  // Fenced code blocks ```lang\n...\n```
  let html = escaped.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const cls = lang ? ` class="language-${lang}"` : "";
    return `<pre><code${cls}>${code.trimEnd()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Simple headings / paragraphs
  const lines = html.split(/\r?\n/);
  const out: string[] = [];
  let inPara = false;
  for (const line of lines) {
    if (line.startsWith("<pre>")) {
      if (inPara) {
        out.push("</p>");
        inPara = false;
      }
      out.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      if (inPara) {
        out.push("</p>");
        inPara = false;
      }
      const level = heading[1].length;
      out.push(`<h${level}>${heading[2]}</h${level}>`);
      continue;
    }
    if (!line.trim()) {
      if (inPara) {
        out.push("</p>");
        inPara = false;
      }
      continue;
    }
    if (!inPara) {
      out.push("<p>");
      inPara = true;
    } else {
      out.push("<br>");
    }
    out.push(line);
  }
  if (inPara) out.push("</p>");
  return out.join("");
}

/** Collapse wiki h2 sections into details/summary for the status Wiki tab. */
export function wrapWikiH2Html(html: string): string {
  const parts = String(html || "").split("<h2>");
  if (parts.length < 2) return html;
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const rest = parts[i];
    const closeIdx = rest.indexOf("</h2>");
    const title = closeIdx >= 0 ? rest.slice(0, closeIdx) : rest;
    const body = closeIdx >= 0 ? rest.slice(closeIdx + 5) : "";
    out += `<details><summary><h2>${title}</h2></summary>${body}</details>`;
  }
  return out;
}


export interface McpStatusSummary {
  host: string;
  port: number;
  activeTransports: number;
  available: boolean;
}

export interface StatusServerOptions {
  port?: number;
  host?: string;
  vaultRoot?: string;
  authToken?: string;
  activityBus: ActivityBus;
  errorLogPath?: string;
  getMcp?: () => McpStatusSummary;
  isProxy?: boolean;
  isDaemon?: boolean;
}

export interface StatusServerInstance {
  server: http.Server;
  port: number;
  host: string;
  url: string;
  close: () => Promise<void>;
}

function parseAfterSeq(raw: string | null): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const STATUS_AUTH_COOKIE = "spec_memo_status_token";

/** Same-origin path only. Rejects protocol-relative `//host` and backslash tricks. */
export function safeStatusNextPath(raw: string | null | undefined): string {
  const next = String(raw ?? "").trim() || "/";
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return "/";
  }
  return next;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

function statusAuthCookie(token: string, maxAgeSec = 60 * 60 * 24 * 365): string {
  return `${STATUS_AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

function clearStatusAuthCookie(): string {
  return `${STATUS_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function collectAuthCandidates(req: http.IncomingMessage, url: URL): string[] {
  const candidates: string[] = [];
  const header = req.headers.authorization;
  if (header) {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) candidates.push(match[1].trim());
    else if (header.trim()) candidates.push(header.trim());
  }
  const queryToken = url.searchParams.get("token") || url.searchParams.get("authToken");
  if (queryToken) candidates.push(queryToken);
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[STATUS_AUTH_COOKIE]) candidates.push(cookies[STATUS_AUTH_COOKIE]);
  return candidates;
}

function providedAuthToken(req: http.IncomingMessage, url: URL): string | undefined {
  return collectAuthCandidates(req, url)[0];
}

function isAuthorized(req: http.IncomingMessage, url: URL, authToken?: string): boolean {
  if (!authToken) return true;
  return collectAuthCandidates(req, url).some((c) => c === authToken);
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "*");
}

function parseBackupListFilters(url: URL): BackupListFilters | { error: string } {
  const filters: BackupListFilters = {};
  const q = url.searchParams.get("q");
  if (q) filters.q = q;
  const scope = url.searchParams.get("scope");
  if (scope === "all" || scope === "full" || scope === "project") {
    filters.scope = scope;
  } else if (scope) {
    return { error: "Invalid scope" };
  }
  const projectId = url.searchParams.get("projectId");
  if (projectId) filters.projectId = projectId;
  const enc = url.searchParams.get("encrypted");
  if (enc !== null && enc !== "") {
    if (enc !== "true" && enc !== "false") {
      return { error: "encrypted must be true or false" };
    }
    filters.encrypted = enc === "true";
  }
  const since = url.searchParams.get("since");
  if (since) filters.since = since;
  const until = url.searchParams.get("until");
  if (until) filters.until = until;
  const kinds = url.searchParams.getAll("kind").filter(Boolean);
  if (kinds.length > 0) filters.kinds = kinds;
  const minSize = url.searchParams.get("minSize");
  if (minSize) {
    const n = Number(minSize);
    if (!Number.isFinite(n)) return { error: "Invalid minSize" };
    filters.minSize = n;
  }
  const maxSize = url.searchParams.get("maxSize");
  if (maxSize) {
    const n = Number(maxSize);
    if (!Number.isFinite(n)) return { error: "Invalid maxSize" };
    filters.maxSize = n;
  }
  return filters;
}

function backupTimestampSuffix(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function writeJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function filterEventsForSnapshot(events: ActivityEvent[], projectId?: string, afterSeq = 0): ActivityEvent[] {
  return events.filter(
    (e) => e.seq > afterSeq && eventMatchesProjectFilter(e, projectId)
  );
}

function readBodyBuffer(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        const err = new Error(`Payload exceeds maximum size of ${maxBytes} bytes`);
        (err as any).statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

export function generateLoginHtml(version = getPackageVersion()): string {
  const versionLabel = `v${version}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>spec-memo — Sign in</title>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --bright: #f0f6fc;
      --muted: #8b949e;
      --accent: #58a6ff;
      --err: #f85149;
      --err-bg: rgba(248, 81, 73, 0.15);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      width: 100%;
      max-width: 400px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 28px 24px;
    }
    h1 {
      font-size: 1.15rem;
      color: var(--bright);
      margin-bottom: 6px;
    }
    .sub {
      color: var(--muted);
      font-size: 0.85rem;
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-size: 0.8rem;
      color: var(--muted);
      margin-bottom: 6px;
    }
    input[type="password"], input[type="text"] {
      width: 100%;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--bright);
      font-size: 0.95rem;
      margin-bottom: 14px;
    }
    input:focus {
      outline: none;
      border-color: var(--accent);
    }
    .username-assist {
      position: absolute;
      left: -9999px;
      width: 1px;
      height: 1px;
      overflow: hidden;
    }
    button {
      width: 100%;
      padding: 10px 12px;
      border: none;
      border-radius: 8px;
      background: var(--accent);
      color: #04101f;
      font-weight: 600;
      font-size: 0.95rem;
      cursor: pointer;
    }
    button:hover { filter: brightness(1.08); }
    button:disabled { opacity: 0.6; cursor: wait; }
    .error {
      display: none;
      background: var(--err-bg);
      color: var(--err);
      border: 1px solid rgba(248, 81, 73, 0.35);
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 0.82rem;
      margin-bottom: 14px;
    }
    .error.show { display: block; }
    .foot {
      margin-top: 16px;
      color: var(--muted);
      font-size: 0.75rem;
      text-align: center;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>spec-memo status</h1>
    <p class="sub">Enter the access token to open the monitor (${versionLabel}).</p>
    <div id="login-error" class="error" role="alert">Invalid access token.</div>
    <form id="login-form" method="post" action="/api/auth/login" autocomplete="on">
      <div class="username-assist">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" value="spec-memo-status" autocomplete="username" tabindex="-1" aria-hidden="true">
      </div>
      <label for="password">Access token</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus spellcheck="false">
      <button type="submit" id="login-submit">Sign in</button>
    </form>
    <p class="foot">Token is stored in an HttpOnly cookie for this browser.</p>
  </main>
  <script>
    (function () {
      const params = new URLSearchParams(window.location.search);
      const err = document.getElementById("login-error");
      if (params.get("error") === "1") err.classList.add("show");
      const form = document.getElementById("login-form");
      const submit = document.getElementById("login-submit");
      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        err.classList.remove("show");
        submit.disabled = true;
        const password = document.getElementById("password").value;
        try {
          const res = await fetch("/api/auth/login", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ token: password, password: password })
          });
          if (!res.ok) {
            err.classList.add("show");
            submit.disabled = false;
            return;
          }
          const next = params.get("next") || "/";
          const safeNext =
            next.startsWith("/") && !next.startsWith("//") && next.indexOf("\\\\") === -1
              ? next
              : "/";
          window.location.href = safeNext;
        } catch (_) {
          err.classList.add("show");
          submit.disabled = false;
        }
      });
    })();
  </script>
</body>
</html>`;
}

export function generateStatusHtml(version = getPackageVersion()): string {
  const versionLabel = `v${version}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>spec-memo — MCP Status Monitor</title>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --card-hover: #1c2128;
      --border: #30363d;
      --text: #c9d1d9;
      --bright: #f0f6fc;
      --muted: #8b949e;
      --accent: #58a6ff;
      --accent-bg: rgba(88, 166, 255, 0.1);
      --ok: #3fb950;
      --ok-bg: rgba(63, 185, 80, 0.15);
      --err: #f85149;
      --err-bg: rgba(248, 81, 73, 0.15);
      --write: #d2a8ff;
      --warn: #d29922;
      --code-bg: #0d1117;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 14px 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      background: var(--card);
    }
    header h1 { color: var(--bright); font-size: 1.25rem; font-weight: 600; }
    header h1 span { color: var(--accent); font-weight: 500; font-size: 0.82rem; margin-left: 8px; }
    header h1 .version-tag { color: var(--muted); font-weight: 400; font-size: 0.75rem; margin-left: 6px; }
    
    .nav-tabs {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--border);
      background: var(--card);
      padding: 0 24px;
    }
    .tab-btn {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--muted);
      font-size: 0.85rem;
      font-weight: 500;
      padding: 10px 16px;
      cursor: pointer;
      border-radius: 0;
      margin-top: 0;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab-btn:hover { color: var(--bright); border-color: var(--border); }
    .tab-btn.active { color: var(--accent); border-color: var(--accent); }

    .badges { display: flex; gap: 8px; flex-wrap: wrap; }
    .badge {
      font-size: 0.75rem;
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--card);
    }
    .badge.live { border-color: var(--ok); color: var(--ok); }
    .badge.reconnecting { border-color: var(--warn); color: var(--warn); }
    .badge.offline { border-color: var(--err); color: var(--err); }
    .badge-proxy { background: #2e1065; border-color: #a855f7; color: #d8b4fe; }
    .badge-direct-remote { background: #0c2d48; border-color: #38bdf8; color: #7dd3fc; }
    .badge-cli { background: #064e3b; border-color: #34d399; color: #6ee7b7; }
    .badge-web { background: #451a03; border-color: #f59e0b; color: #fcd34d; }
    .badge-emerald { background: #064e3b; border-color: #10b981; color: #a7f3d0; }
    .badge-amber { background: #451a03; border-color: #f59e0b; color: #fde68a; }
    .badge-indigo { background: #1e1b4b; border-color: #6366f1; color: #c7d2fe; }
    .badge-cyan { background: #083344; border-color: #06b6d4; color: #a5f3fc; }
    .badge-danger { background: #450a0a; border-color: #ef4444; color: #fecaca; }
    .badge-unknown { background: var(--card); border-color: var(--border); color: var(--muted); }

    .topology-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
    }
    .topology-tier {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 6px;
      font-size: 0.76rem;
      margin-bottom: 4px;
      border: 1px solid transparent;
      opacity: 0.5;
      transition: opacity 0.2s, border-color 0.2s, background 0.2s;
    }
    .topology-tier.active {
      opacity: 1;
      background: rgba(88, 166, 255, 0.08);
      border-color: var(--accent);
    }
    .topology-tier .tier-name { font-weight: 600; color: var(--bright); }
    .topology-tier .tier-desc { font-size: 0.68rem; color: var(--muted); }
    .backup-item {
      padding: 6px 8px;
      border-radius: 6px;
      background: var(--bg);
      border: 1px solid var(--border);
      margin-bottom: 4px;
      font-size: 0.75rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }
    .backup-item .backup-fn { font-family: monospace; color: var(--bright); word-break: break-all; }
    .backup-item .backup-meta { font-size: 0.68rem; color: var(--muted); }

    .client-list { list-style: none; max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
    .client-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 0.8rem;
    }
    .client-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .client-name { font-weight: 600; color: var(--bright); }
    .client-ip { font-family: monospace; font-size: 0.72rem; color: var(--muted); }
    .client-detail {
      font-size: 0.72rem;
      color: var(--muted);
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 5px;
    }
    .status-dot.active { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
    .status-dot.idle { background: var(--muted); }

    .tab-content { display: none; flex: 1; min-height: 0; position: relative; }
    .tab-content.active { display: flex; }

    /* Activity Tab Layout */
    #tab-activity.active {
      display: grid;
      grid-template-columns: 280px 1fr;
    }
    @media (max-width: 900px) { #tab-activity.active { grid-template-columns: 1fr; } }
    aside {
      border-right: 1px solid var(--border);
      padding: 16px;
      overflow-y: auto;
      background: var(--card);
    }
    .panel { margin-bottom: 20px; }
    .panel h2 { font-size: 0.75rem; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; letter-spacing: 0.04em; }
    .stat-grid { display: grid; gap: 8px; }
    .stat {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .stat label { display: block; font-size: 0.7rem; color: var(--muted); margin-bottom: 4px; }
    .stat value { font-size: 0.95rem; color: var(--bright); word-break: break-all; }
    select, button, input[type="password"], input[type="text"], input[type="date"] {
      width: 100%;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 10px;
      font-size: 0.85rem;
    }
    input:focus, select:focus {
      border-color: var(--accent);
      outline: none;
    }
    button { cursor: pointer; margin-top: 6px; transition: border-color 0.15s, color 0.15s, opacity 0.15s; }
    button:hover:not(:disabled) { border-color: var(--accent); color: var(--bright); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: #238636; border-color: rgba(240,246,252,0.1); color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #2ea043; border-color: rgba(240,246,252,0.1); color: #fff; }
    .btn-secondary { background: var(--card); }
    .helper-text { font-size: 0.75rem; color: var(--muted); margin-top: 6px; }
    .vault-list { list-style: none; max-height: 220px; overflow-y: auto; }
    .vault-list li {
      padding: 8px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
      border: 1px solid transparent;
      margin-bottom: 4px;
    }
    .vault-list li:hover { background: var(--bg); border-color: var(--border); }
    .vault-list li.active { border-color: var(--accent); background: rgba(88, 166, 255, 0.08); }
    .vault-list .name { color: var(--bright); display: block; }
    .vault-list .id { color: var(--muted); font-size: 0.75rem; font-family: monospace; }
    .filter-context { font-size: 0.85rem; color: var(--accent); margin-top: 6px; min-height: 1.2em; }
    
    section.log-panel {
      display: flex;
      flex-direction: column;
      min-height: 0;
      padding: 16px;
      position: relative;
    }
    .log-toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }
    .log-toolbar button { width: auto; margin-top: 0; padding: 6px 12px; }
    #activity-log {
      flex: 1;
      overflow-y: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.78rem;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 0;
      min-height: 320px;
    }
    .log-line {
      padding: 6px 12px;
      border-bottom: 1px solid rgba(48, 54, 61, 0.5);
      display: grid;
      grid-template-columns: 68px 52px 42px 1fr;
      gap: 8px;
      align-items: start;
      animation: fadeIn 0.25s ease;
    }
    .log-line.write .kind-tag { color: var(--write); }
    .log-line.http .kind-tag { color: var(--muted); }
    .log-line.error .ok-tag { color: var(--err); }
    .log-line.ok-line .ok-tag { color: var(--ok); }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
    .kind-tag, .ok-tag { font-weight: 600; text-transform: uppercase; font-size: 0.68rem; }
    .log-summary { color: var(--bright); word-break: break-word; }
    .log-meta { color: var(--muted); font-size: 0.72rem; margin-top: 2px; }

    /* Prompts Tab Styles */
    .prompts-container {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      padding: 16px 24px;
      gap: 12px;
      overflow-x: hidden;
    }
    .filter-bar {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .filter-row {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .filter-group {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 160px;
    }
    .filter-group label { font-size: 0.75rem; color: var(--muted); white-space: nowrap; }
    .filter-chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .chip {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 3px 10px;
      font-size: 0.72rem;
      cursor: pointer;
      color: var(--muted);
      transition: all 0.15s;
    }
    .chip:hover { border-color: var(--accent); color: var(--bright); }
    .chip.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }

    .data-table-container {
      flex: 1;
      min-height: 0;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow-y: auto;
      position: relative;
    }
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
      text-align: left;
    }
    .data-table th {
      position: sticky;
      top: 0;
      background: #1c2128;
      color: var(--muted);
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      z-index: 10;
    }
    .data-table td {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(48, 54, 61, 0.4);
      color: var(--text);
      vertical-align: top;
    }
    .data-table tr.master-row { cursor: pointer; transition: background 0.1s; }
    .data-table tr.master-row:hover { background: var(--card-hover); }
    .data-table tr.master-row.selected { background: var(--accent-bg); }
    .expand-btn {
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 0.72rem;
      color: var(--muted);
      cursor: pointer;
      margin: 0;
      width: auto;
      line-height: 1;
    }
    .expand-btn:hover { border-color: var(--accent); color: var(--bright); }
    .preview-row {
      background: #0d1117;
      display: none;
    }
    .preview-row.open { display: table-row; }
    .preview-box {
      padding: 12px 16px;
      font-family: ui-monospace, monospace;
      font-size: 0.78rem;
      color: var(--bright);
      white-space: pre-wrap;
      word-break: break-word;
      background: #090d13;
      border-radius: 6px;
      margin: 4px 8px 10px 8px;
      border: 1px solid var(--border);
    }

    /* Slide-out Side Details Panel (Drawer) */
    .drawer-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 500;
      display: none;
    }
    .drawer-overlay.open { display: block; }
    .drawer {
      position: fixed;
      top: 0;
      right: -600px;
      bottom: 0;
      width: 580px;
      max-width: 90vw;
      background: var(--card);
      border-left: 1px solid var(--border);
      box-shadow: -4px 0 24px rgba(0,0,0,0.6);
      z-index: 600;
      display: flex;
      flex-direction: column;
      transition: right 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .drawer.open { right: 0; }
    .drawer-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .drawer-header h3 { font-size: 1.1rem; color: var(--bright); font-weight: 600; }
    .drawer-close {
      background: transparent;
      border: none;
      color: var(--muted);
      font-size: 1.3rem;
      cursor: pointer;
      margin: 0;
      padding: 0 4px;
      width: auto;
    }
    .drawer-close:hover { color: var(--bright); }
    .drawer-body {
      padding: 20px;
      overflow-y: auto;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .metadata-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 16px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      font-size: 0.78rem;
    }
    .meta-item { display: flex; flex-direction: column; gap: 2px; }
    .meta-label { color: var(--muted); font-size: 0.7rem; text-transform: uppercase; }
    .meta-val { color: var(--bright); font-weight: 500; word-break: break-all; }
    .drawer-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .drawer-actions button { width: auto; margin-top: 0; padding: 7px 12px; font-size: 0.78rem; }
    .markdown-body {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      font-size: 0.85rem;
      line-height: 1.5;
      color: var(--bright);
      overflow-x: auto;
    }
    .markdown-body pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      overflow-x: auto;
      margin: 10px 0;
      font-family: ui-monospace, monospace;
      font-size: 0.8rem;
    }
    .markdown-body code {
      background: rgba(110,118,129,0.2);
      padding: 2px 4px;
      border-radius: 4px;
      font-family: ui-monospace, monospace;
      font-size: 0.8rem;
    }
    .markdown-body pre code { background: transparent; padding: 0; }
    .secret-badge {
      display: inline-block;
      background: var(--err-bg);
      color: var(--err);
      border: 1px solid rgba(248,81,73,0.35);
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 0.72rem;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .pagination-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 0.8rem;
      color: var(--muted);
      flex-wrap: wrap;
      gap: 8px;
    }
    .pagination-controls { display: flex; align-items: center; gap: 8px; }
    .pagination-controls button { width: auto; margin-top: 0; padding: 4px 10px; font-size: 0.75rem; }

    /* Invoicing & Activity Tab */
    .invoicing-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .invoicing-stat {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
    }
    .invoicing-stat label { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; display: block; margin-bottom: 4px; }
    .invoicing-stat .val { font-size: 1.4rem; font-weight: 600; color: var(--bright); }

    /* Rules Tab */
    .rules-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 12px;
      overflow-y: auto;
      flex: 1;
    }
    .rule-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .rule-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
    }
    .rule-title { font-weight: 600; color: var(--bright); font-size: 0.9rem; }
    .rule-pattern {
      font-size: 0.8rem;
      color: var(--text);
      background: var(--bg);
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      font-family: ui-monospace, monospace;
    }

    /* Alerts & Banners */
    .banner-container {
      position: absolute;
      top: 12px;
      right: 16px;
      left: 16px;
      z-index: 100;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: center;
    }
    .banner {
      pointer-events: auto;
      max-width: 640px;
      width: 100%;
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 0.85rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border: 1px solid;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      animation: fadeIn 0.2s ease;
    }
    .banner.error { background: #3c1214; border-color: var(--err); color: #ffb4b0; }
    .banner.success { background: #0c2d18; border-color: var(--ok); color: #7ee787; }
    .banner.info { background: #13233a; border-color: var(--accent); color: #a5d6ff; }
    .banner button.close-banner {
      background: transparent;
      border: none;
      color: inherit;
      font-size: 1rem;
      cursor: pointer;
      margin: 0;
      padding: 0 4px;
      width: auto;
      line-height: 1;
    }

    /* Modals */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(13, 17, 23, 0.75);
      backdrop-filter: blur(2px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 16px;
    }
    .modal-overlay.open { display: flex; }
    .modal-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      max-width: 440px;
      width: 100%;
      padding: 20px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6);
      animation: fadeIn 0.15s ease;
    }
    .modal-card h3 { font-size: 1.05rem; color: var(--bright); margin-bottom: 10px; }
    .modal-card p { font-size: 0.85rem; color: var(--text); line-height: 1.4; margin-bottom: 12px; }
    .modal-card label { display: block; font-size: 0.78rem; color: var(--muted); margin-top: 10px; }
    .modal-actions { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }
    .modal-actions button { width: auto; margin-top: 0; padding: 8px 14px; }
  </style>
</head>
<body>
  <header>
    <h1>spec-memo <span>Status Monitor <span class="version-tag">(status monitor ${versionLabel})</span></span></h1>
    <div class="badges">
      <span id="topology-badge" class="badge badge-emerald">LOCAL VAULT (Standalone)</span>
      <span id="stream-badge" class="badge offline">Offline</span>
      <span id="server-badge" class="badge">Checking…</span>
    </div>
  </header>

  <nav class="nav-tabs">
    <button class="tab-btn active" data-tab="tab-activity">Activity & Status</button>
    <button class="tab-btn" data-tab="tab-memory">Memory</button>
    <button class="tab-btn" data-tab="tab-prompts">Prompts & Intent Stories</button>
    <button class="tab-btn" data-tab="tab-invoicing">Activity & Invoicing</button>
    <button class="tab-btn" data-tab="tab-rules">Derived Rules</button>
    <button class="tab-btn" data-tab="tab-backups">Backups</button>
    <button class="tab-btn" data-tab="tab-wiki">Wiki</button>
    <button class="tab-btn" data-tab="tab-vaults">Vaults</button>
  </nav>

  <div class="banner-container" id="banner-container"></div>

  <!-- TAB 1: Activity & Status -->
  <main id="tab-activity" class="tab-content active">
    <aside>
      <div class="panel">
        <h2>Architecture & Topology</h2>
        <div class="topology-card" id="topology-card">
          <div class="topology-tier active" id="tier-local">
            <span class="badge badge-emerald" style="padding:1px 6px;font-size:0.62rem;">Mode 1</span>
            <div><div class="tier-name">Local Vault</div><div class="tier-desc">Only local files (~/.spec-memo/)</div></div>
          </div>
          <div class="topology-tier" id="tier-proxy">
            <span class="badge badge-amber" style="padding:1px 6px;font-size:0.62rem;">Mode 2</span>
            <div><div class="tier-name">Intermediary Proxy / Hybrid</div><div class="tier-desc">Caches locally, syncs to remote</div></div>
          </div>
          <div class="topology-tier" id="tier-remote">
            <span class="badge badge-indigo" style="padding:1px 6px;font-size:0.62rem;">Mode 3</span>
            <div><div class="tier-name">Final Remote Master</div><div class="tier-desc">Authoritative memory source & backup</div></div>
          </div>
          <div class="helper-text" id="topology-summary" style="margin-top:6px;">Self-contained local filesystem store with local FTS5 indexing.</div>
        </div>
      </div>

      <div class="panel">
        <h2>Server</h2>
        <div class="stat-grid">
          <div class="stat"><label>Status</label><div class="value" id="stat-status">—</div></div>
          <div class="stat"><label>Version</label><div class="value" id="stat-version">${versionLabel}</div></div>
          <div class="stat"><label>Topology Role</label><div class="value" id="stat-role">—</div></div>
          <div class="stat"><label>MCP SSE</label><div class="value" id="stat-mcp">—</div></div>
          <div class="stat"><label>Active Clients</label><div class="value" id="stat-clients">—</div></div>
          <div class="stat"><label>Vaults</label><div class="value" id="stat-vaults">—</div></div>
          <div class="stat"><label>Uptime</label><div class="value" id="stat-uptime">—</div></div>
          <div class="stat"><label>Buffered events</label><div class="value" id="stat-buffered">—</div></div>
        </div>
      </div>
      <div class="panel">
        <h2>Vault Clients (<span id="client-count">0</span>)</h2>
        <div class="client-list" id="client-list">
          <div class="helper-text">No clients connected yet</div>
        </div>
      </div>
      <div class="panel">
        <h2>Vault filter</h2>
        <select id="vault-filter"><option value="">All vaults</option></select>
        <div class="filter-context" id="filter-context"></div>
      </div>

      <div class="panel" style="border: 1px solid rgba(248, 81, 73, 0.35); border-radius: 8px; padding: 12px; background: rgba(248, 81, 73, 0.04);">
        <h2 style="color: var(--err);">Danger Zone</h2>
        <button type="button" id="btn-open-reset" class="btn-secondary" style="border-color: var(--err); color: #ffb4b0; margin-top:4px;">Reset Database / Clear Files…</button>
        <div class="helper-text" style="color: var(--muted); font-size: 0.72rem; margin-top: 6px;">
          Wipes records and SQLite DB after generating a mandatory pre-wipe backup snapshot.
        </div>
      </div>

      <div class="panel">
        <h2>Vault projects</h2>
        <ul class="vault-list" id="vault-list"></ul>
      </div>
    </aside>
    <section class="log-panel">
      <div class="log-toolbar">
        <button type="button" id="btn-pause">Pause scroll</button>
        <button type="button" id="btn-clear">Clear view</button>
      </div>
      <div id="activity-log"></div>
    </section>
  </main>

  <!-- TAB: Memory (retrieval hits) -->
  <section id="tab-memory" class="tab-content">
    <div class="prompts-container">
      <div class="filter-bar">
        <div class="filter-row">
          <div class="filter-group" style="max-width: 220px;">
            <label for="memory-vault-select">Vault:</label>
            <select id="memory-vault-select"><option value="all">All Vaults</option></select>
          </div>
          <div class="filter-group" style="max-width: 160px;">
            <label for="memory-kind-select">Kind:</label>
            <select id="memory-kind-select">
              <option value="">All</option>
              <option value="trap">trap</option>
              <option value="decision">decision</option>
              <option value="spec">spec</option>
              <option value="plan">plan</option>
              <option value="state">state</option>
              <option value="review">review</option>
            </select>
          </div>
          <div class="filter-group" style="max-width: 160px;">
            <label for="memory-sort-select">Sort:</label>
            <select id="memory-sort-select">
              <option value="hits" selected>Hits</option>
              <option value="occurrences">Occurrences</option>
              <option value="updated">Updated</option>
            </select>
          </div>
          <button type="button" id="btn-memory-refresh" class="btn-primary" style="width:auto; margin-top:0; padding:6px 14px; margin-left:auto;">Refresh</button>
        </div>
      </div>

      <div class="data-table-container">
        <table class="data-table" id="memory-table">
          <thead>
            <tr>
              <th style="width: 90px;">Kind</th>
              <th>Title</th>
              <th style="width: 70px;">Hits</th>
              <th style="width: 100px;">Occurrences</th>
              <th style="width: 150px;">Last hit</th>
              <th style="width: 150px;">Updated</th>
            </tr>
          </thead>
          <tbody id="memory-tbody">
            <tr><td colspan="6" style="text-align:center; padding:30px; color:var(--muted);">Open this tab to load memory records…</td></tr>
          </tbody>
        </table>
      </div>
      <div class="pagination-bar">
        <div><span id="memory-count-badge">0 records</span></div>
      </div>
    </div>
  </section>

  <!-- TAB 2: Prompts & Intent Stories Explorer -->
  <section id="tab-prompts" class="tab-content">
    <div class="prompts-container">
      <div class="filter-bar">
        <div class="filter-row">
          <div class="filter-group" style="max-width: 220px;">
            <label for="prompt-vault-select">Vault:</label>
            <select id="prompt-vault-select"><option value="all">All Vaults</option></select>
          </div>
          <div class="filter-group" style="flex: 2;">
            <label for="prompt-query-input">Search:</label>
            <input type="text" id="prompt-query-input" placeholder="Search prompt body, task, or session…">
          </div>
          <div class="filter-group" style="max-width: 140px;">
            <label for="prompt-model-input">Model:</label>
            <input type="text" id="prompt-model-input" placeholder="e.g. 3.7-flash">
          </div>
          <div class="filter-group" style="max-width: 140px;">
            <label for="prompt-agent-input">Role/Agent:</label>
            <input type="text" id="prompt-agent-input" placeholder="e.g. planner">
          </div>
        </div>
        <div class="filter-row">
          <div class="filter-chips">
            <span style="font-size:0.72rem; color:var(--muted); margin-right:4px;">IDE:</span>
            <span class="chip active" data-ide="">ALL</span>
            <span class="chip" data-ide="cursor">CURSOR</span>
            <span class="chip" data-ide="vscode">VSCODE</span>
            <span class="chip" data-ide="claude">CLAUDE</span>
            <span class="chip" data-ide="gemini">GEMINI</span>
            <span class="chip" data-ide="antigravity">ANTIGRAVITY</span>
            <span class="chip" data-ide="opencode">OPENCODE</span>
            <span class="chip" data-ide="codex">CODEX</span>
            <span class="chip" data-ide="pi">PI</span>
            <span class="chip" data-ide="terminal">TERMINAL</span>
            <span class="chip" data-ide="generic">GENERIC</span>
          </div>
          <div class="filter-group" style="max-width: 130px;">
            <label for="prompt-since-input">Since:</label>
            <input type="date" id="prompt-since-input">
          </div>
          <div class="filter-group" style="max-width: 130px;">
            <label for="prompt-until-input">Until:</label>
            <input type="date" id="prompt-until-input">
          </div>
          <div class="filter-group" style="max-width: 150px; margin-left:auto;">
            <label for="prompt-client-input">Client:</label>
            <input type="text" id="prompt-client-input" placeholder="client tag">
          </div>
          <button type="button" id="btn-prompts-clear" class="btn-secondary" style="width:auto; margin-top:0; padding:6px 12px;">Clear</button>
          <button type="button" id="btn-prompts-refresh" class="btn-primary" style="width:auto; margin-top:0; padding:6px 14px;">Filter</button>
        </div>
      </div>

      <div class="data-table-container">
        <table class="data-table" id="prompts-table">
          <thead>
            <tr>
              <th style="width: 32px;"></th>
              <th style="width: 130px;">Timestamp</th>
              <th style="width: 110px;">Vault</th>
              <th style="width: 80px;">IDE</th>
              <th style="width: 100px;">Model</th>
              <th style="width: 130px;">Session ID</th>
              <th style="width: 50px;">Turn</th>
              <th>Intent / Prompt Snippet</th>
              <th style="width: 70px;">Action</th>
            </tr>
          </thead>
          <tbody id="prompts-tbody">
            <tr><td colspan="9" style="text-align:center; padding:30px; color:var(--muted);">Loading prompts…</td></tr>
          </tbody>
        </table>
      </div>

      <div class="pagination-bar">
        <div><span id="prompt-count-badge">0 prompts found</span></div>
        <div class="pagination-controls">
          <label for="prompt-limit-select">Page size:</label>
          <select id="prompt-limit-select" style="width:70px; padding:3px 6px;">
            <option value="10">10</option>
            <option value="20" selected>20</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
          <button type="button" id="btn-prompt-prev" class="btn-secondary" disabled>&larr; Prev</button>
          <span id="prompt-page-indicator">Page 1</span>
          <button type="button" id="btn-prompt-next" class="btn-secondary" disabled>Next &rarr;</button>
        </div>
      </div>
    </div>
  </section>

  <!-- TAB 3: Activity & Invoicing -->
  <section id="tab-invoicing" class="tab-content">
    <div class="prompts-container">
      <div class="filter-bar">
        <div class="filter-row">
          <div class="filter-group" style="max-width: 220px;">
            <label for="invoicing-vault-select">Vault:</label>
            <select id="invoicing-vault-select"><option value="all">All Vaults</option></select>
          </div>
          <div class="filter-group" style="max-width: 180px;">
            <label for="invoicing-client-input">Client:</label>
            <input type="text" id="invoicing-client-input" placeholder="All clients">
          </div>
          <div class="filter-group" style="max-width: 160px;">
            <label for="invoicing-since-input">Since:</label>
            <input type="date" id="invoicing-since-input">
          </div>
          <div class="filter-group" style="max-width: 160px;">
            <label for="invoicing-until-input">Until:</label>
            <input type="date" id="invoicing-until-input">
          </div>
          <button type="button" id="btn-invoicing-run" class="btn-primary" style="width:auto; margin-top:0; padding:6px 16px;">Generate Report</button>
        </div>
      </div>

      <div class="invoicing-grid">
        <div class="invoicing-stat">
          <label>Total Billable Hours</label>
          <div class="val" id="inv-total-hours">0.0 hrs</div>
        </div>
        <div class="invoicing-stat">
          <label>Work Sessions</label>
          <div class="val" id="inv-total-sessions">0</div>
        </div>
        <div class="invoicing-stat">
          <label>Ingested Prompts</label>
          <div class="val" id="inv-total-prompts">0</div>
        </div>
        <div class="invoicing-stat">
          <label>Total Work Duration</label>
          <div class="val" id="inv-total-duration">0 min</div>
        </div>
      </div>

      <div class="data-table-container" style="max-height: 450px;">
        <table class="data-table">
          <thead>
            <tr>
              <th>Session ID</th>
              <th>Vault</th>
              <th>Client</th>
              <th>Task Slug</th>
              <th>Start Time</th>
              <th>Duration</th>
              <th>Deliverables</th>
              <th>Status</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody id="invoicing-tbody">
            <tr><td colspan="9" style="text-align:center; padding:20px; color:var(--muted);">Click 'Generate Report' to compute invoicing metrics</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- TAB 4: Derived Rules -->
  <section id="tab-rules" class="tab-content">
    <div class="prompts-container">
      <div class="filter-bar">
        <div class="filter-row">
          <div class="filter-group" style="max-width: 220px;">
            <label for="rules-vault-select">Vault:</label>
            <select id="rules-vault-select"><option value="all">All Vaults</option></select>
          </div>
          <div class="filter-group" style="max-width: 200px;">
            <label for="rules-session-input">Session ID (optional):</label>
            <input type="text" id="rules-session-input" placeholder="Specific session ID">
          </div>
          <button type="button" id="btn-rules-scan" class="btn-primary" style="width:auto; margin-top:0; padding:6px 16px;">Derive Rules from Prompts</button>
          <button type="button" id="btn-rules-save-traps" class="btn-secondary" style="width:auto; margin-top:0; padding:6px 14px;" disabled>Save High Confidence as Traps</button>
        </div>
      </div>

      <div class="rules-grid" id="rules-grid">
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--muted);">
          Click 'Derive Rules from Prompts' to analyze recent prompt history for anti-regression traps and constraints.
        </div>
      </div>
    </div>
  </section>

  <!-- TAB: Wiki -->
  <section id="tab-wiki" class="tab-content">
    <div class="prompts-container">
      <div class="filter-bar">
        <div class="filter-row">
          <div class="filter-group" style="max-width: 280px;">
            <label for="wiki-vault-select">Project:</label>
            <select id="wiki-vault-select"><option value="">Select a project</option></select>
          </div>
          <button type="button" id="btn-wiki-regenerate" class="btn-primary" style="width:auto; margin-top:0; padding:6px 16px;">Regenerate</button>
        </div>
      </div>
      <div class="helper-text" id="wiki-empty" style="margin-bottom:8px;">Select a project to view its wiki. Missing wiki shows an empty state; Regenerate is always available.</div>
      <div id="wiki-view" class="wiki-view" style="padding:12px 4px;"></div>
    </div>
  </section>

  <!-- TAB: Vaults (project identity manager) -->
  <section id="tab-vaults" class="tab-content">
    <div class="prompts-container">
      <div class="filter-bar">
        <div class="filter-row">
          <button type="button" id="btn-vaults-refresh" class="btn-secondary" style="width:auto; margin-top:0; padding:6px 14px;">Refresh</button>
          <button type="button" id="btn-vault-create" class="btn-primary" style="width:auto; margin-top:0; padding:6px 14px;">Create project</button>
        </div>
      </div>
      <div class="data-table-container">
        <table class="data-table" id="vaults-manager-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Display name</th>
              <th>Alias target</th>
              <th style="width:90px;">Records</th>
              <th style="width:280px;">Actions</th>
            </tr>
          </thead>
          <tbody id="vaults-manager-tbody">
            <tr><td colspan="5" style="text-align:center; padding:30px; color:var(--muted);">Open this tab to load vault projects…</td></tr>
          </tbody>
        </table>
      </div>
      <div class="helper-text" style="margin-top:12px;">Merge redirects source ids to a canonical project. Optional record copy imports history once; new writes always use the canonical folder.</div>
    </div>
  </section>

  <!-- TAB 5: Backups -->
  <section id="tab-backups" class="tab-content">
    <div class="prompts-container">
      <div class="filter-bar">
        <div class="filter-row">
          <div class="filter-group" style="max-width: 220px;">
            <label for="backup-vault-select">Vault:</label>
            <select id="backup-vault-select"><option value="">All vaults</option></select>
          </div>
          <button type="button" id="btn-create-backup" class="btn-primary" style="width:auto; margin-top:0; padding:6px 16px;">Create Backup</button>
          <button type="button" id="btn-backups-refresh" class="btn-secondary" style="width:auto; margin-top:0; padding:6px 14px;">Refresh</button>
          <div class="filter-group" style="max-width: 160px;">
            <label for="backup-q-input">Filename:</label>
            <input type="text" id="backup-q-input" placeholder="Search filename…">
          </div>
          <div class="filter-group" style="max-width: 130px;">
            <label for="backup-scope-select">Scope:</label>
            <select id="backup-scope-select">
              <option value="all">All</option>
              <option value="full">Full</option>
              <option value="project">Project</option>
            </select>
          </div>
          <div class="filter-group" style="max-width: 120px;">
            <label for="backup-encrypted-select">Encrypted:</label>
            <select id="backup-encrypted-select">
              <option value="">Any</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>
        </div>
        <div class="filter-row">
          <div class="filter-group" style="max-width: 140px;">
            <label for="backup-since-input">Since:</label>
            <input type="date" id="backup-since-input">
          </div>
          <div class="filter-group" style="max-width: 140px;">
            <label for="backup-until-input">Until:</label>
            <input type="date" id="backup-until-input">
          </div>
          <div class="filter-chips" id="backup-kind-chips" style="flex-wrap:wrap;">
            <span style="font-size:0.72rem; color:var(--muted); margin-right:4px;">Kinds:</span>
            <label class="chip" style="cursor:pointer;"><input type="checkbox" class="backup-kind-cb" value="trap" style="margin-right:4px;">trap</label>
            <label class="chip" style="cursor:pointer;"><input type="checkbox" class="backup-kind-cb" value="decision" style="margin-right:4px;">decision</label>
            <label class="chip" style="cursor:pointer;"><input type="checkbox" class="backup-kind-cb" value="spec" style="margin-right:4px;">spec</label>
            <label class="chip" style="cursor:pointer;"><input type="checkbox" class="backup-kind-cb" value="plan" style="margin-right:4px;">plan</label>
            <label class="chip" style="cursor:pointer;"><input type="checkbox" class="backup-kind-cb" value="state" style="margin-right:4px;">state</label>
            <label class="chip" style="cursor:pointer;"><input type="checkbox" class="backup-kind-cb" value="log" style="margin-right:4px;">log</label>
            <label class="chip" style="cursor:pointer;"><input type="checkbox" class="backup-kind-cb" value="scratch" style="margin-right:4px;">scratch</label>
            <label class="chip" style="cursor:pointer;"><input type="checkbox" class="backup-kind-cb" value="review" style="margin-right:4px;">review</label>
            <label class="chip" style="cursor:pointer;"><input type="checkbox" class="backup-kind-cb" value="prompt" style="margin-right:4px;">prompt</label>
            <label class="chip" style="cursor:pointer;"><input type="checkbox" class="backup-kind-cb" value="session" style="margin-right:4px;">session</label>
          </div>
          <button type="button" id="btn-backups-filter" class="btn-primary" style="width:auto; margin-top:0; padding:6px 14px; margin-left:auto;">Apply Filters</button>
        </div>
      </div>

      <div class="helper-text" id="backup-helper" style="margin-bottom:8px;">Create Backup is enabled for all vaults or a single project — full vault snapshots require confirmation.</div>

      <div class="data-table-container">
        <table class="data-table" id="backups-table">
          <thead>
            <tr>
              <th>Filename</th>
              <th style="width:150px;">Created</th>
              <th style="width:80px;">Size</th>
              <th style="width:70px;">Entries</th>
              <th style="width:80px;">Scope</th>
              <th style="width:70px;">Enc</th>
              <th style="width:200px;">Actions</th>
            </tr>
          </thead>
          <tbody id="backups-tbody">
            <tr><td colspan="7" style="text-align:center; padding:30px; color:var(--muted);">Loading backups…</td></tr>
          </tbody>
        </table>
      </div>
      <div id="backups-empty" class="helper-text" style="display:none; text-align:center; padding:20px;">
        No backups match the current filters. Click <strong>Create Backup</strong> to persist a snapshot under <code>$SPEC_MEMO_ROOT/backups/</code>.
      </div>
    </div>
  </section>

  <!-- Slide-out Side Details Drawer -->
  <div class="drawer-overlay" id="drawer-overlay"></div>
  <div class="drawer" id="prompt-drawer">
    <div class="drawer-header">
      <h3 id="drawer-title">Prompt Details</h3>
      <button type="button" class="drawer-close" id="drawer-close-btn">&times;</button>
    </div>
    <div class="drawer-body">
      <div class="metadata-card" id="drawer-metadata"></div>
      <div class="drawer-actions">
        <button type="button" id="btn-drawer-session" class="btn-secondary">View Full Session Story</button>
        <button type="button" id="btn-drawer-export" class="btn-secondary">Export Markdown Story</button>
        <button type="button" id="btn-drawer-derive" class="btn-primary">Derive Rules</button>
      </div>
      <div>
        <h4 style="font-size:0.8rem; color:var(--muted); text-transform:uppercase; margin-bottom:6px;">Prompt Content</h4>
        <div class="markdown-body" id="drawer-markdown"></div>
      </div>
    </div>
  </div>

  <!-- Memory Details Drawer -->
  <div class="drawer-overlay" id="memory-drawer-overlay"></div>
  <div class="drawer" id="memory-drawer">
    <div class="drawer-header">
      <h3 id="memory-drawer-title">Memory Details</h3>
      <button type="button" class="drawer-close" id="memory-drawer-close-btn">&times;</button>
    </div>
    <div class="drawer-body">
      <div class="metadata-card" id="memory-drawer-metadata"></div>
      <div>
        <h4 style="font-size:0.8rem; color:var(--muted); text-transform:uppercase; margin-bottom:6px;">Record Body</h4>
        <div class="markdown-body" id="memory-drawer-body"></div>
      </div>
    </div>
  </div>

  <!-- Backup Details Drawer -->
  <div class="drawer-overlay" id="backup-drawer-overlay"></div>
  <div class="drawer" id="backup-drawer">
    <div class="drawer-header">
      <h3 id="backup-drawer-title">Backup Details</h3>
      <button type="button" class="drawer-close" id="backup-drawer-close">&times;</button>
    </div>
    <div class="drawer-body">
      <div class="metadata-card" id="backup-drawer-metadata"></div>
      <div class="drawer-actions">
        <button type="button" id="btn-backup-drawer-restore" class="btn-primary">Restore</button>
        <button type="button" id="btn-backup-drawer-download" class="btn-secondary">Download</button>
        <button type="button" id="btn-backup-drawer-delete" class="btn-secondary" style="border-color:var(--err); color:#ffb4b0;">Delete</button>
      </div>
      <div id="backup-drawer-password-row" style="display:none; margin-bottom:10px;">
        <label for="backup-inspect-password">Inspect password (encrypted archives):</label>
        <input type="password" id="backup-inspect-password" placeholder="Password" autocomplete="current-password" style="width:100%; margin-top:4px;">
        <button type="button" id="btn-backup-inspect-unlock" class="btn-secondary" style="width:auto; margin-top:6px;">Unlock details</button>
      </div>
      <div>
        <h4 style="font-size:0.8rem; color:var(--muted); text-transform:uppercase; margin-bottom:6px;">Records by kind</h4>
        <div id="backup-drawer-kinds" class="helper-text">—</div>
      </div>
      <div style="margin-top:12px;">
        <h4 style="font-size:0.8rem; color:var(--muted); text-transform:uppercase; margin-bottom:6px;">Manifest</h4>
        <pre id="backup-drawer-manifest" style="font-size:0.72rem; background:var(--code-bg); padding:10px; border-radius:6px; overflow:auto; max-height:240px;">—</pre>
      </div>
    </div>
  </div>

  <!-- Export Password Modal -->
  <div id="modal-export" class="modal-overlay">
    <div class="modal-card">
      <h3 id="modal-export-title">Export Vault</h3>
      <p id="modal-export-desc">Download a backup .zip archive containing all structured memories for this project.</p>
      <label for="export-password">Optional encryption password:</label>
      <input type="password" id="export-password" placeholder="Leave empty for unencrypted" autocomplete="new-password">
      <div class="helper-text">If set, records are encrypted with AES-256-GCM before packaging.</div>
      <div class="modal-actions">
        <button type="button" id="btn-export-cancel" class="btn-secondary">Cancel</button>
        <button type="button" id="btn-export-confirm" class="btn-primary">Download Backup</button>
      </div>
    </div>
  </div>

  <!-- Full Backup Confirmation Modal -->
  <div id="modal-full-backup" class="modal-overlay">
    <div class="modal-card">
      <h3>Confirm Full Vault Backup</h3>
      <p id="modal-full-backup-desc" style="font-size: 0.85rem; color: var(--text); line-height: 1.4; margin-bottom: 10px;">
        This will snapshot <strong>all</strong> project vaults under the vault root.
      </p>
      <label for="full-backup-password">Optional encryption password:</label>
      <input type="password" id="full-backup-password" placeholder="Leave empty for unencrypted" autocomplete="new-password">
      <div class="modal-actions">
        <button type="button" id="btn-full-backup-cancel" class="btn-secondary">Cancel</button>
        <button type="button" id="btn-full-backup-confirm" class="btn-primary">Create Full Backup</button>
      </div>
    </div>
  </div>

  <!-- Project Backup Password Modal -->
  <div id="modal-create-backup" class="modal-overlay">
    <div class="modal-card">
      <h3 id="modal-create-backup-title">Create Project Backup</h3>
      <p id="modal-create-backup-desc" style="font-size: 0.85rem; color: var(--text); line-height: 1.4; margin-bottom: 10px;"></p>
      <label for="create-backup-password">Optional encryption password:</label>
      <input type="password" id="create-backup-password" placeholder="Leave empty for unencrypted" autocomplete="new-password">
      <div class="modal-actions">
        <button type="button" id="btn-create-backup-cancel" class="btn-secondary">Cancel</button>
        <button type="button" id="btn-create-backup-confirm" class="btn-primary">Create Backup</button>
      </div>
    </div>
  </div>

  <!-- Delete Backup Modal -->
  <div id="modal-delete-backup" class="modal-overlay">
    <div class="modal-card" style="border-color: var(--err);">
      <h3 style="color: var(--err);">Delete Backup</h3>
      <p style="font-size: 0.85rem; margin-bottom: 10px;">Type the exact filename to confirm deletion. This only removes the archive file — live vault records are not affected.</p>
      <p id="modal-delete-backup-fn" style="font-family:monospace; font-size:0.8rem; color:var(--bright); word-break:break-all; margin-bottom:8px;"></p>
      <label for="delete-backup-confirm-input">Filename:</label>
      <input type="text" id="delete-backup-confirm-input" placeholder="YYYY-MM-DD-HH-mm-ss-backup.zip" autocomplete="off">
      <div class="modal-actions">
        <button type="button" id="btn-delete-backup-cancel" class="btn-secondary">Cancel</button>
        <button type="button" id="btn-delete-backup-confirm" class="btn-primary" style="background:#da3633; border-color:#f85149;" disabled>Delete</button>
      </div>
    </div>
  </div>

  <!-- Import Confirmation Modal -->
  <div id="modal-import" class="modal-overlay">
    <div class="modal-card">
      <h3>Confirm Vault Import</h3>
      <p id="modal-import-summary">Target vault root: local vault.</p>
      <p style="color: #ffb4b0; font-size: 0.8rem;">Import will merge records from the archive into the local vault and overwrite existing records with the same paths. Continue?</p>
      <label for="import-password">Password (if archive is encrypted):</label>
      <input type="password" id="import-password" placeholder="Password (if encrypted)" autocomplete="current-password">
      <div class="modal-actions">
        <button type="button" id="btn-import-cancel" class="btn-secondary">Cancel</button>
        <button type="button" id="btn-import-confirm" class="btn-primary">Confirm & Restore</button>
      </div>
    </div>
  </div>

  <!-- Reset Modal -->
  <div id="modal-reset" class="modal-overlay">
    <div class="modal-card" style="border-color: var(--err);">
      <h3 style="color: var(--err);">Confirm Vault Reset</h3>
      <p style="font-size: 0.85rem; color: var(--text); line-height: 1.4; margin-bottom: 10px;">
        This action will <strong>completely wipe all memory records and SQLite search databases</strong>.
      </p>
      <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid #10b981; border-radius: 6px; padding: 8px 10px; margin-bottom: 12px; font-size: 0.78rem; color: #a7f3d0;">
        <strong>Safety Guarantee:</strong> An automatic pre-wipe backup snapshot (<code>YYYY-MM-DD-HH-mm-ss-backup.zip</code>) will be created in <code>$SPEC_MEMO_ROOT/backups/</code> before wiping.
      </div>
      <label for="reset-password">Archive Encryption Password (optional):</label>
      <input type="password" id="reset-password" placeholder="Leave empty for unencrypted backup" autocomplete="new-password">
      <div class="modal-actions">
        <button type="button" id="btn-reset-cancel" class="btn-secondary">Cancel</button>
        <button type="button" id="btn-reset-confirm" class="btn-primary" style="background: #da3633; border-color: #f85149;">Confirm & Reset</button>
      </div>
    </div>
  </div>

  <!-- Restore Named Backup Modal -->
  <div id="modal-restore-named" class="modal-overlay">
    <div class="modal-card">
      <h3 id="modal-restore-named-title">Restore Backup</h3>
      <p id="modal-restore-named-desc" style="font-size: 0.85rem; color: var(--text); line-height: 1.4; margin-bottom: 10px;">
        Restore this backup archive into the local vault?
      </p>
      <label for="restore-named-password">Decryption Password (if encrypted):</label>
      <input type="password" id="restore-named-password" placeholder="Password (if encrypted)" autocomplete="current-password">
      <div class="modal-actions">
        <button type="button" id="btn-restore-named-cancel" class="btn-secondary">Cancel</button>
        <button type="button" id="btn-restore-named-confirm" class="btn-primary">Restore</button>
      </div>
    </div>
  </div>

  <script>
    const STORAGE_KEY = "spec-memo-status-project";
    const urlParams = new URLSearchParams(window.location.search);
    let vaults = [];
    let selectedProject = "";
    let lastSeq = 0;
    let eventSource = null;
    let pauseScroll = false;
    let reconnectTimer = null;

    // Prompts Explorer State
    let promptOffset = 0;
    let promptLimit = 20;
    let promptTotal = 0;
    let selectedIde = "";
    let selectedSessionId = "";
    let activePromptRecord = null;
    let lastDerivedRules = [];

    function showBanner(message, type = "info", timeoutMs = 6000) {
      const container = document.getElementById("banner-container");
      const banner = document.createElement("div");
      banner.className = "banner " + type;
      banner.innerHTML = '<span>' + escapeHtml(message) + '</span>' +
        '<button type="button" class="close-banner">&times;</button>';
      
      const closeBtn = banner.querySelector(".close-banner");
      let timer = null;
      function remove() {
        if (timer) clearTimeout(timer);
        if (banner.parentNode) banner.parentNode.removeChild(banner);
      }
      closeBtn.addEventListener("click", remove);
      if (timeoutMs > 0) timer = setTimeout(remove, timeoutMs);
      container.appendChild(banner);
    }

    function apiHeaders() {
      return {};
    }

    async function apiFetch(input, init = {}) {
      const headers = Object.assign({}, apiHeaders(), init.headers || {});
      const res = await fetch(input, Object.assign({}, init, {
        credentials: "same-origin",
        headers
      }));
      if (res.status === 401) {
        const probe = res.clone();
        try {
          const body = await probe.json();
          const msg = String(body && body.error ? body.error : "").toLowerCase();
          if (msg.indexOf("decryption failed") !== -1 || msg.indexOf("incorrect password") !== -1) {
            return res;
          }
        } catch {
          // fall through to auth redirect
        }
        const qs = new URLSearchParams(window.location.search);
        qs.delete("token");
        qs.delete("authToken");
        const rest = qs.toString();
        const next = window.location.pathname + (rest ? "?" + rest : "");
        const safeNext =
          next.startsWith("/") && !next.startsWith("//") && next.indexOf("\\\\") === -1
            ? next
            : "/";
        window.location.href = "/login?next=" + encodeURIComponent(safeNext);
        throw new Error("Unauthorized");
      }
      return res;
    }

    function streamUrl() {
      let u = "/api/events/stream?afterSeq=" + lastSeq;
      if (selectedProject) u += "&project=" + encodeURIComponent(selectedProject);
      return u;
    }

    function setStreamBadge(state) {
      const el = document.getElementById("stream-badge");
      el.className = "badge " + state;
      el.textContent = state === "live" ? "Live" : state === "reconnecting" ? "Reconnecting" : "Offline";
    }

    function formatUptime(ms) {
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const h = Math.floor(m / 60);
      if (h > 0) return h + "h " + (m % 60) + "m";
      if (m > 0) return m + "m " + (s % 60) + "s";
      return s + "s";
    }

    function clientFilterEvent(ev) {
      if (!selectedProject) return true;
      return !ev.projectId || ev.projectId === selectedProject;
    }

    function displayNameForProject(id) {
      const v = vaults.find(x => x.id === id);
      return v ? (v.displayName || v.id) : id;
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }

    function renderClients(clients) {
      const listEl = document.getElementById("client-list");
      const countEl = document.getElementById("client-count");
      if (!clients || clients.length === 0) {
        listEl.innerHTML = '<div class="helper-text">No clients connected yet</div>';
        countEl.textContent = "0";
        return;
      }
      const activeList = clients.filter(c => c.active);
      countEl.textContent = String(activeList.length);
      listEl.innerHTML = "";
      for (const c of clients) {
        const card = document.createElement("div");
        card.className = "client-card";
        const typeClass = c.clientType ? "badge-" + c.clientType : "badge-unknown";
        const typeLabel = c.clientType === "proxy" ? "PROXY" : c.clientType === "direct-remote" ? "DIRECT REMOTE" : (c.clientType || "CLIENT").toUpperCase();
        const dotClass = c.active ? "active" : "idle";
        const targetVault = c.projectId ? displayNameForProject(c.projectId) : "All vaults";
        const lastOp = c.lastOperation || "connected";
        card.innerHTML =
          '<div class="client-card-header">' +
            '<div><span class="status-dot ' + dotClass + '"></span><span class="client-name">' + escapeHtml(c.clientName || "MCP Client") + '</span></div>' +
            '<span class="badge ' + typeClass + '" style="font-size:0.62rem; padding:1px 6px;">' + escapeHtml(typeLabel) + '</span>' +
          '</div>' +
          '<div class="client-detail">' +
            '<span>IP: <code>' + escapeHtml(c.ip || "127.0.0.1") + '</code></span>' +
            '<span>Vault: <b>' + escapeHtml(targetVault) + '</b></span>' +
          '</div>' +
          '<div class="client-detail" style="color:var(--bright);">' +
            '<span>Op: <code>' + escapeHtml(lastOp) + '</code></span>' +
            (c.requestCount ? '<span>Reqs: ' + c.requestCount + '</span>' : '') +
            (c.lastSeenAt ? '<span>Seen: <code>' + escapeHtml(c.lastSeenAt.length >= 19 ? c.lastSeenAt.slice(0, 19).replace('T', ' ') : c.lastSeenAt) + '</code></span>' : '') +
          '</div>';
        listEl.appendChild(card);
      }
    }

    function renderLogLine(ev) {
      const line = document.createElement("div");
      const kindClass = ev.kind === "write" ? "write" : ev.type === "http" ? "http" : "";
      line.className = "log-line " + kindClass + (ev.ok ? " ok-line" : " error");
      const time = ev.ts ? (ev.ts.length >= 19 ? ev.ts.slice(0, 19).replace('T', ' ') : ev.ts) : "";
      const kind = ev.kind || ev.type;
      const typeClass = ev.clientType ? "badge-" + ev.clientType : "";
      const clientBadge = ev.clientName
        ? '<span class="badge ' + typeClass + '" style="font-size:0.65rem; padding:1px 6px; margin-right:4px;">' +
          escapeHtml(ev.clientName) +
          (ev.clientIp ? " (" + escapeHtml(ev.clientIp) + ")" : "") +
          '</span>'
        : (ev.clientIp ? '<span class="client-ip" style="margin-right:4px;">[' + escapeHtml(ev.clientIp) + ']</span>' : '');
      const detail = ev.tool
        ? ev.tool
        : (ev.method && ev.path ? ev.method + " " + ev.path : ev.type);
      const proj = ev.projectId && !selectedProject
        ? displayNameForProject(ev.projectId)
        : "";
      const opText = ev.operation && ev.operation !== detail ? " · op: " + escapeHtml(ev.operation) : "";
      line.innerHTML =
        '<span class="time" title="' + escapeHtml(ev.ts || "") + '">' + escapeHtml(time) + '</span>' +
        '<span class="kind-tag">' + kind + '</span>' +
        '<span class="ok-tag">' + (ev.ok ? "ok" : "err") + '</span>' +
        '<div>' +
        '<div class="log-summary" style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;">' + clientBadge + '<span>' + escapeHtml(ev.summary || "") + '</span></div>' +
        '<div class="log-meta">' + escapeHtml(detail) +
        opText +
        (ev.durationMs != null ? " · " + ev.durationMs + "ms" : "") +
        (proj ? " · " + escapeHtml(proj) : "") + '</div></div>';
      return line;
    }

    function appendEvent(ev) {
      if (!clientFilterEvent(ev)) return;
      if (ev.seq > lastSeq) lastSeq = ev.seq;
      const log = document.getElementById("activity-log");
      log.appendChild(renderLogLine(ev));
      if (!pauseScroll) log.scrollTop = log.scrollHeight;
    }

    function hydrateEvents(events) {
      for (const ev of events) {
        if (ev.seq > lastSeq) appendEvent(ev);
      }
    }

    function updateFilterContext() {
      const el = document.getElementById("filter-context");
      const backupHelper = document.getElementById("backup-helper");
      if (!selectedProject) {
        el.textContent = "";
        if (backupHelper) {
          backupHelper.textContent = "All vaults — Create Backup includes every project (confirmation required). Select a vault to snapshot one project only.";
        }
        return;
      }
      const dName = displayNameForProject(selectedProject);
      el.textContent = "Showing: " + dName;
      if (backupHelper) {
        backupHelper.textContent = "Vault filter: " + dName + " — Create Backup on the Backups tab snapshots the selected vault only.";
      }
    }

    function renderVaultList() {
      const ul = document.getElementById("vault-list");
      ul.innerHTML = "";
      for (const v of vaults) {
        const li = document.createElement("li");
        if (v.id === selectedProject) li.classList.add("active");
        li.innerHTML = '<span class="name">' + escapeHtml(v.displayName || v.id) + '</span>' +
          '<span class="id">' + escapeHtml(v.id) + '</span>';
        li.addEventListener("click", () => setProjectFilter(v.id));
        ul.appendChild(li);
      }
    }

    function populateVaultSelectors() {
      const selectors = [
        document.getElementById("vault-filter"),
        document.getElementById("prompt-vault-select"),
        document.getElementById("memory-vault-select"),
        document.getElementById("invoicing-vault-select"),
        document.getElementById("rules-vault-select"),
        document.getElementById("backup-vault-select")
      ];
      for (const sel of selectors) {
        if (!sel) continue;
        const currentVal = sel.value;
        const allLabel = sel.id === "memory-vault-select" ? "All Vaults" : "All vaults";
        const allValue = sel.id === "memory-vault-select" ? "all" : "";
        sel.innerHTML = '<option value="' + allValue + '">' + allLabel + "</option>";
        for (const v of vaults) {
          const opt = document.createElement("option");
          opt.value = v.id;
          opt.textContent = v.displayName || v.id;
          if (v.id === currentVal) opt.selected = true;
          sel.appendChild(opt);
        }
      }
      const wikiSel = document.getElementById("wiki-vault-select");
      if (wikiSel) {
        const currentVal = wikiSel.value;
        wikiSel.innerHTML = '<option value="">Select a project</option>';
        for (const v of vaults) {
          const opt = document.createElement("option");
          opt.value = v.id;
          opt.textContent = v.displayName || v.id;
          if (v.id === currentVal) opt.selected = true;
          wikiSel.appendChild(opt);
        }
      }
    }

    function setProjectFilter(projectId) {
      selectedProject = projectId;
      sessionStorage.setItem(STORAGE_KEY, selectedProject);
      const sel = document.getElementById("vault-filter");
      if (sel) sel.value = selectedProject;
      const pSel = document.getElementById("prompt-vault-select");
      if (pSel) pSel.value = selectedProject;
      renderVaultList();
      updateFilterContext();
      lastSeq = 0;
      document.getElementById("activity-log").innerHTML = "";
      reconnectStream(false);
    }

    function reconnectStream(initial = false) {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      setStreamBadge(initial ? "reconnecting" : "reconnecting");
      const es = new EventSource(streamUrl(), { withCredentials: true });
      eventSource = es;

      es.addEventListener("open", () => {
        setStreamBadge("live");
      });

      es.addEventListener("snapshot", (e) => {
        try {
          const data = JSON.parse(e.data);
          hydrateEvents(data);
        } catch {}
      });

      es.addEventListener("activity", (e) => {
        try {
          const ev = JSON.parse(e.data);
          appendEvent(ev);
        } catch {}
      });

      es.onerror = () => {
        setStreamBadge("reconnecting");
        es.close();
        eventSource = null;
        reconnectTimer = setTimeout(() => reconnectStream(false), 2000);
      };
    }

    async function loadVaults() {
      try {
        const res = await apiFetch("/api/vaults", {
          headers: apiHeaders()
        });
        if (!res.ok) return;
        const data = await res.json();
        vaults = Array.isArray(data) ? data : (data.vaults || []);
        populateVaultSelectors();
        renderVaultList();
        updateFilterContext();
      } catch {}
    }

    async function refreshStatus() {
      try {
        const res = await apiFetch("/api/status", {
          headers: apiHeaders()
        });
        if (!res.ok) {
          document.getElementById("server-badge").textContent = "Error";
          document.getElementById("server-badge").className = "badge offline";
          return;
        }
        const st = await res.json();
        document.getElementById("server-badge").textContent = "MCP :" + st.port;
        document.getElementById("server-badge").className = "badge live";
        document.getElementById("stat-status").textContent = st.status;
        document.getElementById("stat-mcp").textContent = st.mcp && st.mcp.available ? "Listening" : "Unavailable";
        document.getElementById("stat-vaults").textContent = String(st.projectsCount != null ? st.projectsCount : vaults.length);
        document.getElementById("stat-uptime").textContent = formatUptime(st.uptimeMs || 0);
        document.getElementById("stat-buffered").textContent = String(st.eventsBuffered || 0);
        document.getElementById("stat-clients").textContent = String(st.activeClientsCount || 0);
        renderClients(st.clients || []);

        if (st.topology) {
          const t = st.topology;
          const topBadge = document.getElementById("topology-badge");
          if (topBadge) {
            topBadge.className = "badge " + (
              t.role === 'final-remote' ? 'badge-indigo' :
              t.role === 'intermediary-proxy' ? 'badge-amber' :
              'badge-emerald'
            );
            if (t.role === 'intermediary-proxy' && t.upstreamRemoteUrl) {
              topBadge.textContent = "INTERMEDIARY PROXY → " + t.upstreamRemoteUrl.replace("https://", "").replace("http://", "");
            } else if (t.role === 'final-remote') {
              topBadge.textContent = "FINAL REMOTE MASTER VAULT";
            } else {
              topBadge.textContent = "LOCAL VAULT (Standalone)";
            }
          }

          const tierLocal = document.getElementById("tier-local");
          const tierProxy = document.getElementById("tier-proxy");
          const tierRemote = document.getElementById("tier-remote");
          const topSummary = document.getElementById("topology-summary");

          if (tierLocal) tierLocal.classList.toggle("active", t.role === 'local-vault');
          if (tierProxy) tierProxy.classList.toggle("active", t.role === 'intermediary-proxy');
          if (tierRemote) tierRemote.classList.toggle("active", t.role === 'final-remote');
          if (topSummary) topSummary.textContent = t.description + (t.syncSummary ? " (" + t.syncSummary + ")" : "");
          const statRole = document.getElementById("stat-role");
          if (statRole) statRole.textContent = t.roleLabel || t.role;
        }
      } catch {
        document.getElementById("server-badge").textContent = "Offline";
        document.getElementById("server-badge").className = "badge offline";
      }
    }

    function activateTab(tabId) {
      document.querySelectorAll(".tab-btn").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-tab") === tabId);
      });
      document.querySelectorAll(".tab-content").forEach((c) => {
        c.classList.toggle("active", c.id === tabId);
      });
      if (tabId === "tab-memory") {
        loadMemoryRecords();
      } else if (tabId === "tab-prompts") {
        loadPrompts();
      } else if (tabId === "tab-invoicing") {
        loadActivityReport();
      } else if (tabId === "tab-backups") {
        loadBackups();
      } else if (tabId === "tab-wiki") {
        loadWiki();
      } else if (tabId === "tab-vaults") {
        loadVaultsManager();
      }
    }

    // Tab Switching
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetId = btn.getAttribute("data-tab");
        if (targetId) activateTab(targetId);
      });
    });

    // --- MEMORY TAB LOGIC ---
    let memoryRecordsCache = [];

    function formatIsoShort(iso) {
      if (!iso) return "-";
      const s = String(iso);
      return s.length >= 19 ? s.slice(0, 19).replace("T", " ") : s;
    }

    async function loadMemoryRecords() {
      const tbody = document.getElementById("memory-tbody");
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--muted);">Loading memory…</td></tr>';
      try {
        const params = new URLSearchParams();
        const vault = document.getElementById("memory-vault-select").value;
        if (vault && vault !== "all") params.set("project", vault);
        const kind = document.getElementById("memory-kind-select").value;
        if (kind) params.set("kind", kind);
        const sort = document.getElementById("memory-sort-select").value || "hits";
        params.set("sort", sort);
        params.set("limit", "200");

        const res = await apiFetch("/api/records?" + params.toString(), { headers: apiHeaders() });
        const data = await res.json();
        const records = data.records || [];
        memoryRecordsCache = records;
        document.getElementById("memory-count-badge").textContent = records.length + " record(s)";

        if (records.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--muted);">No memory records match the current filters.</td></tr>';
          return;
        }

        tbody.innerHTML = "";
        for (const r of records) {
          const tr = document.createElement("tr");
          tr.className = "master-row";
          tr.dataset.id = r.id;
          tr.innerHTML =
            "<td><code>" + escapeHtml(r.kind) + "</code></td>" +
            "<td>" + escapeHtml(r.title || r.id) + "</td>" +
            "<td>" + escapeHtml(String(r.hits != null ? r.hits : 0)) + "</td>" +
            "<td>" + escapeHtml(String(r.occurrences != null ? r.occurrences : 0)) + "</td>" +
            "<td>" + escapeHtml(formatIsoShort(r.lastHit)) + "</td>" +
            "<td>" + escapeHtml(formatIsoShort(r.updated)) + "</td>";
          tr.addEventListener("click", () => openMemoryDrawer(r));
          tbody.appendChild(tr);
        }
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--err);">Failed to load memory records.</td></tr>';
      }
    }

    function openMemoryDrawer(record) {
      document.getElementById("memory-drawer-title").textContent = record.title || record.id || "Memory";
      const meta = document.getElementById("memory-drawer-metadata");
      meta.innerHTML =
        '<div class="meta-item"><span class="meta-label">Title</span><span class="meta-val">' + escapeHtml(record.title || record.id) + "</span></div>" +
        '<div class="meta-item"><span class="meta-label">Kind</span><span class="meta-val">' + escapeHtml(record.kind) + "</span></div>" +
        '<div class="meta-item"><span class="meta-label">Status</span><span class="meta-val">' + escapeHtml(record.status || "-") + "</span></div>" +
        '<div class="meta-item"><span class="meta-label">Hits</span><span class="meta-val">' + escapeHtml(String(record.hits != null ? record.hits : 0)) + "</span></div>" +
        '<div class="meta-item"><span class="meta-label">Occurrences</span><span class="meta-val">' + escapeHtml(String(record.occurrences != null ? record.occurrences : 0)) + "</span></div>" +
        '<div class="meta-item"><span class="meta-label">Last hit</span><span class="meta-val">' + escapeHtml(record.lastHit || "-") + "</span></div>" +
        '<div class="meta-item"><span class="meta-label">Updated</span><span class="meta-val">' + escapeHtml(record.updated || "-") + "</span></div>" +
        '<div class="meta-item"><span class="meta-label">Project</span><span class="meta-val">' + escapeHtml(displayNameForProject(record.projectId)) + "</span></div>";
      const bodyEl = document.getElementById("memory-drawer-body");
      bodyEl.textContent = record.snippet || "(no body snippet)";
      document.getElementById("memory-drawer-overlay").classList.add("open");
      document.getElementById("memory-drawer").classList.add("open");
    }

    function closeMemoryDrawer() {
      document.getElementById("memory-drawer-overlay").classList.remove("open");
      document.getElementById("memory-drawer").classList.remove("open");
    }

    document.getElementById("memory-drawer-close-btn").addEventListener("click", closeMemoryDrawer);
    document.getElementById("memory-drawer-overlay").addEventListener("click", closeMemoryDrawer);
    document.getElementById("btn-memory-refresh").addEventListener("click", () => loadMemoryRecords());
    document.getElementById("memory-kind-select").addEventListener("change", () => loadMemoryRecords());
    document.getElementById("memory-sort-select").addEventListener("change", () => loadMemoryRecords());
    document.getElementById("memory-vault-select").addEventListener("change", () => loadMemoryRecords());

    // --- PROMPTS TAB LOGIC ---
    async function loadPrompts() {
      const tbody = document.getElementById("prompts-tbody");
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--muted);">Loading prompts…</td></tr>';
      
      const vault = document.getElementById("prompt-vault-select").value;
      const query = document.getElementById("prompt-query-input").value.trim();
      const model = document.getElementById("prompt-model-input").value.trim();
      const agent = document.getElementById("prompt-agent-input").value.trim();
      const client = document.getElementById("prompt-client-input").value.trim();
      const since = document.getElementById("prompt-since-input").value;
      const until = document.getElementById("prompt-until-input").value;

      const params = new URLSearchParams();
      if (vault && vault !== "all") params.set("project", vault);
      else params.set("crossProject", "true");
      if (query) params.set("query", query);
      if (selectedIde) params.set("ide", selectedIde);
      if (selectedSessionId) params.set("sessionId", selectedSessionId);
      if (model) params.set("model", model);
      if (agent) params.set("agent", agent);
      if (client) params.set("client", client);
      if (since) params.set("since", since);
      if (until) params.set("until", until);
      params.set("limit", String(promptLimit));
      params.set("offset", String(promptOffset));

      try {
        const res = await apiFetch("/api/prompts?" + params.toString(), { headers: apiHeaders() });
        const data = await res.json();
        promptTotal = data.total || 0;
        document.getElementById("prompt-count-badge").textContent = promptTotal + " prompt(s) found";

        const curPage = Math.floor(promptOffset / promptLimit) + 1;
        const totalPages = Math.max(1, Math.ceil(promptTotal / promptLimit));
        document.getElementById("prompt-page-indicator").textContent = "Page " + curPage + " of " + totalPages;
        document.getElementById("btn-prompt-prev").disabled = promptOffset === 0;
        document.getElementById("btn-prompt-next").disabled = !data.hasMore;

        const items = data.items || [];
        if (items.length === 0) {
          tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--muted);">No prompts match the current filters.</td></tr>';
          return;
        }

        tbody.innerHTML = "";
        for (const p of items) {
          const fm = p.frontmatter;
          const time = fm.created ? fm.created.slice(0, 19).replace('T', ' ') : '-';
          const ide = (fm.ide || 'generic').toUpperCase();
          const model = fm.model || '-';
          const sess = fm.sessionId ? fm.sessionId.slice(0, 16) : '-';
          const turn = fm.turn != null ? String(fm.turn) : '-';
          const snippet = p.body.replace(/\\n+/g, ' ').slice(0, 75);

          const tr = document.createElement("tr");
          tr.className = "master-row";
          tr.dataset.id = fm.id;

          tr.innerHTML =
            '<td><button type="button" class="expand-btn" data-id="' + escapeHtml(fm.id) + '">+</button></td>' +
            '<td><span style="font-family:monospace; font-size:0.75rem;">' + escapeHtml(time) + '</span></td>' +
            '<td><span class="badge" style="font-size:0.65rem;">' + escapeHtml(displayNameForProject(fm.project)) + '</span></td>' +
            '<td><span class="badge badge-cli" style="font-size:0.65rem;">' + escapeHtml(ide) + '</span></td>' +
            '<td><span style="color:var(--bright); font-size:0.75rem;">' + escapeHtml(model) + '</span></td>' +
            '<td><span style="font-family:monospace; font-size:0.72rem; color:var(--accent);">' + escapeHtml(sess) + '</span></td>' +
            '<td><span style="font-size:0.75rem;">' + escapeHtml(turn) + '</span></td>' +
            '<td><span style="color:var(--bright);">' + escapeHtml(snippet) + (p.body.length > 75 ? '…' : '') + '</span></td>' +
            '<td><button type="button" class="btn-secondary btn-inspect" style="padding:2px 8px; font-size:0.7rem; width:auto; margin:0;">Inspect</button></td>';

          const previewTr = document.createElement("tr");
          previewTr.className = "preview-row";
          previewTr.id = "prev-" + fm.id;
          previewTr.innerHTML = '<td colspan="9"><div class="preview-box">' + escapeHtml(p.body) + '</div></td>';

          tr.querySelector(".expand-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            const isOpen = previewTr.classList.toggle("open");
            e.target.textContent = isOpen ? "-" : "+";
          });

          tr.addEventListener("click", () => {
            openDrawer(p);
          });

          tbody.appendChild(tr);
          tbody.appendChild(previewTr);
        }
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--err);">Failed to load prompts: ' + escapeHtml(err.message || String(err)) + '</td></tr>';
      }
    }

    async function openDrawer(record) {
      activePromptRecord = record;
      const fm = record.frontmatter || {};
      document.getElementById("drawer-title").textContent = fm.id || "Prompt";
      document.getElementById("drawer-markdown").innerHTML = '<p style="color:var(--muted)">Loading full record…</p>';
      document.getElementById("drawer-overlay").classList.add("open");
      document.getElementById("prompt-drawer").classList.add("open");

      let full = record;
      let renderedHtml = null;
      let secretsRedacted = false;
      try {
        const params = new URLSearchParams();
        if (fm.project) params.set("project", fm.project);
        const res = await apiFetch("/api/prompts/" + encodeURIComponent(fm.id) + "?" + params.toString(), { headers: apiHeaders() });
        if (res.ok) {
          const data = await res.json();
          if (data.record) full = data.record;
          renderedHtml = data.renderedHtml || null;
          secretsRedacted = Boolean(data.secretsRedacted);
        }
      } catch (_) { /* keep list snippet */ }

      activePromptRecord = full;
      const ffm = full.frontmatter || fm;
      const tags = (ffm.tags || []).join(", ") || "-";
      const linked = (ffm.linkedPaths || []).join(", ") || "-";

      const metaContainer = document.getElementById("drawer-metadata");
      metaContainer.innerHTML =
        '<div class="meta-item"><span class="meta-label">Project</span><span class="meta-val">' + escapeHtml(displayNameForProject(ffm.project)) + '</span></div>' +
        '<div class="meta-item"><span class="meta-label">Session ID</span><span class="meta-val">' + escapeHtml(ffm.sessionId || '-') + '</span></div>' +
        '<div class="meta-item"><span class="meta-label">Turn #</span><span class="meta-val">' + escapeHtml(ffm.turn != null ? String(ffm.turn) : '-') + '</span></div>' +
        '<div class="meta-item"><span class="meta-label">Created</span><span class="meta-val">' + escapeHtml(ffm.created || '-') + '</span></div>' +
        '<div class="meta-item"><span class="meta-label">IDE / Model</span><span class="meta-val">' + escapeHtml((ffm.ide || 'generic').toUpperCase() + ' / ' + (ffm.model || 'default')) + '</span></div>' +
        '<div class="meta-item"><span class="meta-label">Client / Billable</span><span class="meta-val">' + escapeHtml((ffm.client || 'internal') + (ffm.billable !== false ? ' (Billable)' : ' (Non-billable)')) + '</span></div>' +
        '<div class="meta-item"><span class="meta-label">Task Slug</span><span class="meta-val">' + escapeHtml(ffm.taskSlug || '-') + '</span></div>' +
        '<div class="meta-item"><span class="meta-label">Branch / SHA</span><span class="meta-val">' + escapeHtml((ffm.branch || '-') + ' @ ' + (ffm.gitSha ? ffm.gitSha.slice(0, 7) : '-')) + '</span></div>' +
        '<div class="meta-item"><span class="meta-label">Tags</span><span class="meta-val">' + escapeHtml(tags) + '</span></div>' +
        '<div class="meta-item"><span class="meta-label">Linked Paths</span><span class="meta-val">' + escapeHtml(linked) + '</span></div>';

      const body = full.body || record.body || "";
      if (!secretsRedacted) secretsRedacted = body.includes("[REDACTED");
      const badge = secretsRedacted ? '<div class="secret-badge" id="drawer-secret-badge">Secrets redacted</div>' : '';
      const markdownContainer = document.getElementById("drawer-markdown");
      markdownContainer.innerHTML = badge + (renderedHtml || ('<pre>' + escapeHtml(body) + '</pre>'));

      document.getElementById("btn-drawer-session").disabled = !ffm.sessionId;
      document.getElementById("btn-drawer-export").disabled = !ffm.sessionId;
    }

    function closeDrawer() {
      document.getElementById("drawer-overlay").classList.remove("open");
      document.getElementById("prompt-drawer").classList.remove("open");
      activePromptRecord = null;
    }

    document.getElementById("drawer-close-btn").addEventListener("click", closeDrawer);
    document.getElementById("drawer-overlay").addEventListener("click", closeDrawer);

    document.getElementById("btn-drawer-session").addEventListener("click", () => {
      if (!activePromptRecord || !activePromptRecord.frontmatter.sessionId) return;
      document.getElementById("prompt-query-input").value = "";
      document.getElementById("prompt-vault-select").value = activePromptRecord.frontmatter.project;
      selectedSessionId = String(activePromptRecord.frontmatter.sessionId);
      promptOffset = 0;
      closeDrawer();
      loadPrompts();
    });

    document.getElementById("btn-drawer-export").addEventListener("click", () => {
      if (!activePromptRecord || !activePromptRecord.frontmatter.sessionId) return;
      const sessId = activePromptRecord.frontmatter.sessionId;
      const exportParams = new URLSearchParams();
      if (activePromptRecord.frontmatter.project) {
        exportParams.set("project", activePromptRecord.frontmatter.project);
      }
      const exportUrl =
        "/api/prompts/sessions/" + encodeURIComponent(sessId) + "/export" +
        (exportParams.toString() ? "?" + exportParams.toString() : "");
      window.open(exportUrl, "_blank");
    });

    document.getElementById("btn-drawer-derive").addEventListener("click", async () => {
      if (!activePromptRecord) return;
      const btn = document.getElementById("btn-drawer-derive");
      btn.disabled = true;
      btn.textContent = "Deriving…";
      try {
        const res = await apiFetch("/api/prompts/derive-rules", {
          method: "POST",
          headers: { ...apiHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: activePromptRecord.frontmatter.project,
            sessionId: activePromptRecord.frontmatter.sessionId
          })
        });
        const data = await res.json();
        if (data.ok && data.result) {
          showBanner("Derived " + data.result.rules.length + " candidate rules from prompt session", "success");
          // Switch to rules tab and render
          document.querySelector('.tab-btn[data-tab="tab-rules"]').click();
          renderDerivedRules(data.result.rules);
        }
      } catch (err) {
        showBanner("Derive failed: " + (err.message || String(err)), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Derive Rules";
      }
    });

    document.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        selectedIde = chip.getAttribute("data-ide") || "";
        promptOffset = 0;
        loadPrompts();
      });
    });

    document.getElementById("btn-prompts-refresh").addEventListener("click", () => {
      promptOffset = 0;
      loadPrompts();
    });

    document.getElementById("btn-prompts-clear").addEventListener("click", () => {
      document.getElementById("prompt-query-input").value = "";
      document.getElementById("prompt-model-input").value = "";
      document.getElementById("prompt-agent-input").value = "";
      document.getElementById("prompt-client-input").value = "";
      document.getElementById("prompt-since-input").value = "";
      document.getElementById("prompt-until-input").value = "";
      document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      document.querySelector('.chip[data-ide=""]').classList.add("active");
      selectedIde = "";
      selectedSessionId = "";
      promptOffset = 0;
      loadPrompts();
    });

    document.getElementById("prompt-limit-select").addEventListener("change", (e) => {
      promptLimit = Number(e.target.value);
      promptOffset = 0;
      loadPrompts();
    });

    document.getElementById("btn-prompt-prev").addEventListener("click", () => {
      promptOffset = Math.max(0, promptOffset - promptLimit);
      loadPrompts();
    });

    document.getElementById("btn-prompt-next").addEventListener("click", () => {
      promptOffset += promptLimit;
      loadPrompts();
    });

    // --- ACTIVITY & INVOICING TAB LOGIC ---
    async function loadActivityReport() {
      const tbody = document.getElementById("invoicing-tbody");
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:20px; color:var(--muted);">Calculating activity report…</td></tr>';

      const vault = document.getElementById("invoicing-vault-select").value;
      const client = document.getElementById("invoicing-client-input").value.trim();
      const since = document.getElementById("invoicing-since-input").value;
      const until = document.getElementById("invoicing-until-input").value;

      const params = new URLSearchParams();
      if (vault && vault !== "all") params.set("project", vault);
      else params.set("crossProject", "true");
      if (client) params.set("client", client);
      if (since) params.set("since", since);
      if (until) params.set("until", until);

      try {
        const res = await apiFetch("/api/activity?" + params.toString(), { headers: apiHeaders() });
        const data = await res.json();
        
        document.getElementById("inv-total-hours").textContent = (data.totalBillableHours || 0) + " hrs";
        document.getElementById("inv-total-sessions").textContent = String(data.totalSessions || 0);
        document.getElementById("inv-total-prompts").textContent = String(data.totalPrompts || 0);
        document.getElementById("inv-total-duration").textContent = (data.totalDurationMinutes || 0) + " min";

        const sessions = data.sessions || [];
        if (sessions.length === 0) {
          tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:20px; color:var(--muted);">No sessions recorded in this date range.</td></tr>';
          return;
        }

        tbody.innerHTML = "";
        for (const s of sessions) {
          const tr = document.createElement("tr");
          const delivs = s.deliverables || [];
          const delivHtml = delivs.length > 0
            ? delivs.map(d => '<span class="badge" style="font-size:0.65rem;">' + escapeHtml(d.type.toUpperCase()) + (d.url ? ' <a href="' + escapeHtml(d.url) + '" target="_blank" style="color:var(--accent);">Link</a>' : '') + '</span>').join(' ')
            : '-';

          tr.innerHTML =
            '<td><code style="color:var(--accent);">' + escapeHtml(s.sessionId) + '</code></td>' +
            '<td>' + escapeHtml(displayNameForProject(s.projectId)) + '</td>' +
            '<td>' + escapeHtml(s.client || 'internal') + '</td>' +
            '<td><b>' + escapeHtml(s.taskSlug || '-') + '</b></td>' +
            '<td>' + escapeHtml(s.startTime.slice(0, 16).replace('T', ' ')) + '</td>' +
            '<td>' + escapeHtml(s.durationMinutes + ' min') + '</td>' +
            '<td>' + delivHtml + '</td>' +
            '<td><span class="badge ' + (s.billable ? 'badge-cli' : '') + '" style="font-size:0.65rem;">' + (s.billable ? 'Billable' : 'Internal') + '</span></td>' +
            '<td style="color:var(--muted); font-size:0.75rem;">' + escapeHtml(s.summary || '-') + '</td>';
          tbody.appendChild(tr);
        }
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:20px; color:var(--err);">Failed to generate report: ' + escapeHtml(err.message || String(err)) + '</td></tr>';
      }
    }

    document.getElementById("btn-invoicing-run").addEventListener("click", loadActivityReport);

    // --- DERIVED RULES TAB LOGIC ---
    function renderDerivedRules(rules) {
      lastDerivedRules = rules || [];
      const grid = document.getElementById("rules-grid");
      const saveBtn = document.getElementById("btn-rules-save-traps");
      saveBtn.disabled = lastDerivedRules.length === 0;

      if (lastDerivedRules.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--muted);">No candidate rules identified in prompt history.</div>';
        return;
      }

      grid.innerHTML = "";
      for (const r of lastDerivedRules) {
        const card = document.createElement("div");
        card.className = "rule-card";
        const confBadge = r.confidence >= 0.85 ? "badge-cli" : "badge-unknown";
        card.innerHTML =
          '<div class="rule-header">' +
            '<span class="rule-title">' + escapeHtml(r.ruleTitle) + '</span>' +
            '<span class="badge ' + confBadge + '" style="font-size:0.68rem;">' + Math.round(r.confidence * 100) + '% match</span>' +
          '</div>' +
          '<div style="font-size:0.72rem; color:var(--muted);">Category: <span class="badge" style="font-size:0.65rem;">' + escapeHtml(r.category) + '</span> · ' + (r.sourcePromptIds ? r.sourcePromptIds.length : 1) + ' signal(s)</div>' +
          '<div class="rule-pattern">' + escapeHtml(r.pattern) + '</div>' +
          '<div style="font-size:0.72rem; color:var(--muted); margin-top:auto;">Sources: ' + (r.sourcePromptIds ? r.sourcePromptIds.map(id => '<code>' + escapeHtml(id) + '</code>').join(', ') : '-') + '</div>';
        grid.appendChild(card);
      }
    }

    document.getElementById("btn-rules-scan").addEventListener("click", async () => {
      const btn = document.getElementById("btn-rules-scan");
      btn.disabled = true;
      btn.textContent = "Scanning prompts…";
      const vault = document.getElementById("rules-vault-select").value;
      const sess = document.getElementById("rules-session-input").value.trim();
      if (!vault || vault === "all") {
        showBanner("Select a specific vault/project before deriving rules.", "error");
        btn.disabled = false;
        btn.textContent = "Derive Rules from Prompts";
        return;
      }

      try {
        const res = await apiFetch("/api/prompts/derive-rules", {
          method: "POST",
          headers: { ...apiHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: vault,
            sessionId: sess || undefined
          })
        });
        const data = await res.json();
        if (!res.ok) {
          showBanner(data.error || "Scan failed", "error");
          return;
        }
        if (data.ok && data.result) {
          showBanner("Scan complete: " + data.result.rules.length + " candidate rules found across " + data.result.scannedPromptsCount + " prompts.", "success");
          renderDerivedRules(data.result.rules);
        }
      } catch (err) {
        showBanner("Scan failed: " + (err.message || String(err)), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Derive Rules from Prompts";
      }
    });

    document.getElementById("btn-rules-save-traps").addEventListener("click", async () => {
      const btn = document.getElementById("btn-rules-save-traps");
      btn.disabled = true;
      btn.textContent = "Saving to vault…";
      const vault = document.getElementById("rules-vault-select").value;
      if (!vault || vault === "all") {
        showBanner("Select a specific vault/project before saving traps.", "error");
        btn.disabled = false;
        btn.textContent = "Save High Confidence as Traps";
        return;
      }

      try {
        const res = await apiFetch("/api/prompts/derive-rules", {
          method: "POST",
          headers: { ...apiHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: vault,
            saveTraps: true
          })
        });
        const data = await res.json();
        if (!res.ok) {
          showBanner(data.error || "Save failed", "error");
          return;
        }
        if (data.ok && data.result) {
          const count = data.result.savedTraps ? data.result.savedTraps.length : 0;
          showBanner("Successfully saved " + count + " derived rule(s) as active traps in vault!", "success");
        }
      } catch (err) {
        showBanner("Save failed: " + (err.message || String(err)), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Save High Confidence as Traps";
      }
    });

    // --- BACKUPS TAB ---
    let backupInventory = [];
    let activeBackupFilename = null;
    let pendingDeleteFilename = null;

    function formatBytes(n) {
      if (n == null || n < 0) return "—";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
      return (n / (1024 * 1024)).toFixed(1) + " MB";
    }

    function localDateStartIso(ymd) {
      const parts = ymd.split("-").map(Number);
      return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0).toISOString();
    }
    function localDateEndIso(ymd) {
      const parts = ymd.split("-").map(Number);
      return new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999).toISOString();
    }

    function backupFilterParams() {
      const params = new URLSearchParams();
      const q = document.getElementById("backup-q-input").value.trim();
      if (q) params.set("q", q);
      const scope = document.getElementById("backup-scope-select").value;
      if (scope && scope !== "all") params.set("scope", scope);
      const vaultSel = document.getElementById("backup-vault-select");
      if (vaultSel && vaultSel.value) params.set("projectId", vaultSel.value);
      const enc = document.getElementById("backup-encrypted-select").value;
      if (enc) params.set("encrypted", enc);
      const since = document.getElementById("backup-since-input").value;
      if (since) params.set("since", localDateStartIso(since));
      const until = document.getElementById("backup-until-input").value;
      if (until) params.set("until", localDateEndIso(until));
      document.querySelectorAll(".backup-kind-cb:checked").forEach((cb) => {
        params.append("kind", cb.value);
      });
      return params;
    }

    async function loadBackups() {
      const tbody = document.getElementById("backups-tbody");
      const emptyEl = document.getElementById("backups-empty");
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:var(--muted);">Loading backups…</td></tr>';
      if (emptyEl) emptyEl.style.display = "none";
      try {
        const params = backupFilterParams();
        const qs = params.toString();
        const res = await apiFetch("/api/vaults/backups" + (qs ? "?" + qs : ""), { headers: apiHeaders() });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px; color:var(--err);">' + escapeHtml(err.error || "Failed to load backups") + '</td></tr>';
          return;
        }
        const data = await res.json();
        backupInventory = data.backups || [];
        if (backupInventory.length === 0) {
          tbody.innerHTML = "";
          if (emptyEl) emptyEl.style.display = "block";
          return;
        }
        if (emptyEl) emptyEl.style.display = "none";
        tbody.innerHTML = "";
        for (const b of backupInventory) {
          const tr = document.createElement("tr");
          tr.className = "backup-row";
          tr.setAttribute("data-fn", b.filename);
          const dateStr = b.createdAt ? (b.createdAt.length >= 19 ? b.createdAt.slice(0, 19).replace("T", " ") : b.createdAt) : "—";
          const entries = b.recordCount != null ? String(b.recordCount) : "—";
          const scope = b.scope || "—";
          const enc = b.encrypted ? "yes" : "no";
          tr.innerHTML =
            '<td style="font-family:monospace; font-size:0.78rem; word-break:break-all;">' + escapeHtml(b.filename) + '</td>' +
            '<td>' + escapeHtml(dateStr) + '</td>' +
            '<td>' + escapeHtml(formatBytes(b.size)) + '</td>' +
            '<td>' + escapeHtml(entries) + '</td>' +
            '<td>' + escapeHtml(scope) + '</td>' +
            '<td>' + escapeHtml(enc) + '</td>' +
            '<td class="backup-actions">' +
              '<button type="button" class="btn-secondary btn-backup-restore" data-fn="' + escapeHtml(b.filename) + '" style="width:auto; margin:0 4px 0 0; padding:2px 8px; font-size:0.7rem;">Restore</button>' +
              '<button type="button" class="btn-secondary btn-backup-delete" data-fn="' + escapeHtml(b.filename) + '" style="width:auto; margin:0 4px 0 0; padding:2px 8px; font-size:0.7rem;">Delete</button>' +
              '<button type="button" class="btn-secondary btn-backup-download" data-fn="' + escapeHtml(b.filename) + '" style="width:auto; margin:0; padding:2px 8px; font-size:0.7rem;">Download</button>' +
            '</td>';
          tr.addEventListener("click", (e) => {
            if (e.target.closest(".backup-actions")) return;
            openBackupDrawer(b.filename);
          });
          tbody.appendChild(tr);
        }
        tbody.querySelectorAll(".btn-backup-restore").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            openRestoreModal(btn.getAttribute("data-fn"));
          });
        });
        tbody.querySelectorAll(".btn-backup-delete").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            openDeleteBackupModal(btn.getAttribute("data-fn"));
          });
        });
        tbody.querySelectorAll(".btn-backup-download").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            downloadBackupFile(btn.getAttribute("data-fn"));
          });
        });
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px; color:var(--err);">Error loading backups</td></tr>';
      }
    }

    function closeBackupDrawer() {
      document.getElementById("backup-drawer").classList.remove("open");
      document.getElementById("backup-drawer-overlay").classList.remove("open");
      activeBackupFilename = null;
    }

    async function openBackupDrawer(filename, password) {
      if (!filename) return;
      activeBackupFilename = filename;
      const titleEl = document.getElementById("backup-drawer-title");
      const metaEl = document.getElementById("backup-drawer-metadata");
      const kindsEl = document.getElementById("backup-drawer-kinds");
      const manifestEl = document.getElementById("backup-drawer-manifest");
      const pwRow = document.getElementById("backup-drawer-password-row");
      titleEl.textContent = filename;
      metaEl.innerHTML = '<div class="helper-text">Loading…</div>';
      kindsEl.textContent = "—";
      manifestEl.textContent = "—";
      document.getElementById("backup-drawer").classList.add("open");
      document.getElementById("backup-drawer-overlay").classList.add("open");
      try {
        const res = await apiFetch("/api/vaults/backups/" + encodeURIComponent(filename) + "/inspect", {
          method: "POST",
          headers: Object.assign({}, apiHeaders(), { "Content-Type": "application/json" }),
          body: JSON.stringify(password ? { password: password } : {})
        });
        const data = await res.json();
        if (!res.ok) {
          showBanner(data.error || "Inspect failed", "error");
          if (res.status === 401 && pwRow) pwRow.style.display = "block";
          return;
        }
        if (data.encrypted && data.inspectable === false) {
          if (pwRow) pwRow.style.display = "block";
          metaEl.innerHTML =
            '<div><strong>Encrypted:</strong> yes</div>' +
            '<div><strong>Size:</strong> ' + escapeHtml(formatBytes(data.size)) + '</div>' +
            '<div class="helper-text" style="margin-top:6px;">Enter password to view record counts and manifest.</div>';
          return;
        }
        if (pwRow) pwRow.style.display = "none";
        metaEl.innerHTML =
          '<div><strong>Created:</strong> ' + escapeHtml(data.createdAt || "—") + '</div>' +
          '<div><strong>Size:</strong> ' + escapeHtml(formatBytes(data.size)) + '</div>' +
          '<div><strong>Entries:</strong> ' + escapeHtml(data.recordCount != null ? String(data.recordCount) : "—") + '</div>' +
          '<div><strong>Scope:</strong> ' + escapeHtml(data.scope || "—") + '</div>' +
          '<div><strong>Encrypted:</strong> ' + (data.encrypted ? "yes" : "no") + '</div>' +
          '<div><strong>Projects:</strong> ' + escapeHtml((data.projectIds || []).join(", ") || "—") + '</div>';
        const byKind = data.recordsByKind || {};
        const kindLines = Object.keys(byKind).sort().map((k) => k + ": " + byKind[k]).join(", ");
        kindsEl.textContent = kindLines || "—";
        manifestEl.textContent = JSON.stringify(data.manifest || { projects: data.projectIds, recordCount: data.recordCount }, null, 2);
      } catch (err) {
        showBanner("Inspect failed: " + (err.message || String(err)), "error");
      }
    }

    function downloadBackupFile(filename) {
      if (!filename) return;
      window.location.href = "/api/vaults/backups/" + encodeURIComponent(filename);
    }

    function openRestoreModal(filename) {
      if (!filename) return;
      selectedRestoreBackup = filename;
      const modal = document.getElementById("modal-restore-named");
      document.getElementById("modal-restore-named-title").textContent = "Restore " + filename;
      document.getElementById("modal-restore-named-desc").textContent =
        "Restore backup archive " + filename + " into the local vault? Records with matching paths will be overwritten.";
      document.getElementById("restore-named-password").value = "";
      modal.classList.add("open");
      document.getElementById("restore-named-password").focus();
    }

    function openDeleteBackupModal(filename) {
      pendingDeleteFilename = filename;
      document.getElementById("modal-delete-backup-fn").textContent = filename;
      const input = document.getElementById("delete-backup-confirm-input");
      input.value = "";
      document.getElementById("btn-delete-backup-confirm").disabled = true;
      document.getElementById("modal-delete-backup").classList.add("open");
      input.focus();
    }

    async function persistBackup(payload, btn) {
      const origText = btn ? btn.textContent : "";
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Creating…";
      }
      try {
        const res = await apiFetch("/api/vaults/backups", {
          method: "POST",
          headers: { ...apiHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          showBanner(data.error || "Backup failed", "error");
          return;
        }
        showBanner("Backup created: " + data.filename + " (" + data.recordCount + " records)", "success");
        await loadBackups();
      } catch (err) {
        showBanner("Backup failed: " + (err.message || String(err)), "error");
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = origText;
        }
      }
    }

    document.getElementById("btn-create-backup").addEventListener("click", () => {
      const vaultSel = document.getElementById("backup-vault-select");
      const projectId = vaultSel ? vaultSel.value : "";
      if (!projectId) {
        document.getElementById("modal-full-backup-desc").innerHTML =
          "This will snapshot <strong>all " + vaults.length + " project vault(s)</strong> under the vault root into <code>$SPEC_MEMO_ROOT/backups/</code>.";
        document.getElementById("full-backup-password").value = "";
        document.getElementById("modal-full-backup").classList.add("open");
        return;
      }
      const dName = displayNameForProject(projectId);
      document.getElementById("modal-create-backup-title").textContent = "Create Backup — " + dName;
      document.getElementById("modal-create-backup-desc").textContent = "Persist a complete snapshot for project " + projectId + ".";
      document.getElementById("create-backup-password").value = "";
      document.getElementById("modal-create-backup").classList.add("open");
    });

    document.getElementById("btn-full-backup-cancel").addEventListener("click", () => {
      document.getElementById("modal-full-backup").classList.remove("open");
    });
    document.getElementById("btn-full-backup-confirm").addEventListener("click", async () => {
      const btn = document.getElementById("btn-full-backup-confirm");
      document.getElementById("modal-full-backup").classList.remove("open");
      const password = document.getElementById("full-backup-password").value || undefined;
      await persistBackup({ confirmFullBackup: true, password }, btn);
    });

    document.getElementById("btn-create-backup-cancel").addEventListener("click", () => {
      document.getElementById("modal-create-backup").classList.remove("open");
    });
    document.getElementById("btn-create-backup-confirm").addEventListener("click", async () => {
      const btn = document.getElementById("btn-create-backup-confirm");
      const vaultSel = document.getElementById("backup-vault-select");
      const projectId = vaultSel ? vaultSel.value : "";
      document.getElementById("modal-create-backup").classList.remove("open");
      if (!projectId) return;
      const password = document.getElementById("create-backup-password").value || undefined;
      await persistBackup({ projectId, password }, btn);
    });

    document.getElementById("btn-backups-refresh").addEventListener("click", () => loadBackups());
    document.getElementById("btn-backups-filter").addEventListener("click", () => loadBackups());

    document.getElementById("backup-drawer-close").addEventListener("click", closeBackupDrawer);
    document.getElementById("backup-drawer-overlay").addEventListener("click", closeBackupDrawer);
    document.getElementById("btn-backup-drawer-restore").addEventListener("click", () => {
      if (activeBackupFilename) openRestoreModal(activeBackupFilename);
    });
    document.getElementById("btn-backup-drawer-download").addEventListener("click", () => {
      if (activeBackupFilename) downloadBackupFile(activeBackupFilename);
    });
    document.getElementById("btn-backup-drawer-delete").addEventListener("click", () => {
      if (activeBackupFilename) openDeleteBackupModal(activeBackupFilename);
    });
    document.getElementById("btn-backup-inspect-unlock").addEventListener("click", () => {
      const pw = document.getElementById("backup-inspect-password").value;
      if (activeBackupFilename) openBackupDrawer(activeBackupFilename, pw);
    });

    document.getElementById("delete-backup-confirm-input").addEventListener("input", (e) => {
      const match = e.target.value === pendingDeleteFilename;
      document.getElementById("btn-delete-backup-confirm").disabled = !match;
    });
    document.getElementById("btn-delete-backup-cancel").addEventListener("click", () => {
      document.getElementById("modal-delete-backup").classList.remove("open");
      pendingDeleteFilename = null;
    });
    document.getElementById("btn-delete-backup-confirm").addEventListener("click", async () => {
      if (!pendingDeleteFilename) return;
      const btn = document.getElementById("btn-delete-backup-confirm");
      btn.disabled = true;
      btn.textContent = "Deleting…";
      document.getElementById("modal-delete-backup").classList.remove("open");
      try {
        const res = await apiFetch("/api/vaults/backups/" + encodeURIComponent(pendingDeleteFilename), {
          method: "DELETE",
          headers: { ...apiHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: true })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          showBanner(data.error || "Delete failed", "error");
          return;
        }
        showBanner("Deleted backup " + pendingDeleteFilename, "success");
        if (activeBackupFilename === pendingDeleteFilename) closeBackupDrawer();
        await loadBackups();
      } catch (err) {
        showBanner("Delete failed: " + (err.message || String(err)), "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Delete";
        pendingDeleteFilename = null;
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.getElementById("backup-drawer").classList.contains("open")) {
        closeBackupDrawer();
      }
    });

    let selectedRestoreBackup = null;

    // Reset Vault Modal & Confirmation
    const modalReset = document.getElementById("modal-reset");
    const btnOpenReset = document.getElementById("btn-open-reset");
    const btnResetCancel = document.getElementById("btn-reset-cancel");
    const btnResetConfirm = document.getElementById("btn-reset-confirm");
    const resetPasswordInput = document.getElementById("reset-password");

    if (btnOpenReset) {
      btnOpenReset.addEventListener("click", () => {
        resetPasswordInput.value = "";
        modalReset.classList.add("open");
        resetPasswordInput.focus();
      });
    }
    if (btnResetCancel) {
      btnResetCancel.addEventListener("click", () => {
        modalReset.classList.remove("open");
      });
    }
    if (btnResetConfirm) {
      btnResetConfirm.addEventListener("click", async () => {
        btnResetConfirm.disabled = true;
        btnResetConfirm.textContent = "Resetting…";
        modalReset.classList.remove("open");
        try {
          const res = await apiFetch("/api/vaults/reset", {
            method: "POST",
            headers: { ...apiHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({
              confirm: true,
              password: resetPasswordInput.value || undefined
            })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            showBanner(data.error || "Vault reset failed", "error");
            return;
          }
          showBanner(
            "Vault reset complete: pre-wipe backup saved as " + data.backupFilename + " (wiped " + data.wipedRecordsCount + " records across " + data.wipedProjectsCount + " projects)",
            "success"
          );
          await loadVaults();
          await loadBackups();
          await refreshStatus();
        } catch (err) {
          showBanner("Reset failed: " + (err.message || String(err)), "error");
        } finally {
          btnResetConfirm.disabled = false;
          btnResetConfirm.textContent = "Confirm & Reset";
        }
      });
    }

    // Restore Named Backup Modal Handlers
    const modalRestoreNamed = document.getElementById("modal-restore-named");
    const btnRestoreNamedCancel = document.getElementById("btn-restore-named-cancel");
    const btnRestoreNamedConfirm = document.getElementById("btn-restore-named-confirm");
    const restoreNamedPassword = document.getElementById("restore-named-password");

    if (btnRestoreNamedCancel) {
      btnRestoreNamedCancel.addEventListener("click", () => {
        modalRestoreNamed.classList.remove("open");
        selectedRestoreBackup = null;
      });
    }
    if (btnRestoreNamedConfirm) {
      btnRestoreNamedConfirm.addEventListener("click", async () => {
        if (!selectedRestoreBackup) return;
        btnRestoreNamedConfirm.disabled = true;
        btnRestoreNamedConfirm.textContent = "Restoring…";
        modalRestoreNamed.classList.remove("open");
        try {
          const res = await apiFetch("/api/vaults/restore", {
            method: "POST",
            headers: { ...apiHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({
              backupFilename: selectedRestoreBackup,
              password: restoreNamedPassword.value || undefined
            })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            showBanner(data.error || "Restore failed", "error");
            return;
          }
          showBanner(
            "Restore successful: restored " + data.restoredRecordsCount + " records across " + data.restoredProjectsCount + " project(s)",
            "success"
          );
          await loadVaults();
          await loadBackups();
          await refreshStatus();
        } catch (err) {
          showBanner("Restore failed: " + (err.message || String(err)), "error");
        } finally {
          btnRestoreNamedConfirm.disabled = false;
          btnRestoreNamedConfirm.textContent = "Restore";
          selectedRestoreBackup = null;
        }
      });
    }

    document.getElementById("vault-filter").addEventListener("change", (e) => {
      setProjectFilter(e.target.value);
    });
    document.getElementById("prompt-vault-select").addEventListener("change", (e) => {
      promptOffset = 0;
      loadPrompts();
    });
    document.getElementById("btn-pause").addEventListener("click", () => {
      pauseScroll = !pauseScroll;
      document.getElementById("btn-pause").textContent = pauseScroll ? "Resume scroll" : "Pause scroll";
    });
    document.getElementById("btn-clear").addEventListener("click", () => {
      document.getElementById("activity-log").innerHTML = "";
    });

    function renderPromptMarkdownHtml(body) {
      const escaped = String(body || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      const lines = escaped.split(String.fromCharCode(10));
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.indexOf("## ") === 0) {
          out.push("<h2>" + line.slice(3) + "</h2>");
        } else if (line.indexOf("# ") === 0) {
          out.push("<h1>" + line.slice(2) + "</h1>");
        } else if (!line.trim()) {
          out.push("");
        } else {
          out.push("<p>" + line + "</p>");
        }
      }
      return out.join("");
    }

    function wrapWikiH2(html) {
      const parts = String(html || "").split("<h2>");
      if (parts.length < 2) return html;
      let out = parts[0];
      for (let i = 1; i < parts.length; i++) {
        const rest = parts[i];
        const closeIdx = rest.indexOf("</h2>");
        const title = closeIdx >= 0 ? rest.slice(0, closeIdx) : rest;
        const body = closeIdx >= 0 ? rest.slice(closeIdx + 5) : "";
        out += "<details><summary><h2>" + title + "</h2></summary>" + body + "</details>";
      }
      return out;
    }

    async function loadWiki() {
      const sel = document.getElementById("wiki-vault-select");
      const view = document.getElementById("wiki-view");
      const empty = document.getElementById("wiki-empty");
      const projectId = sel ? sel.value : "";
      if (!projectId || projectId === "all") {
        if (view) view.innerHTML = "";
        if (empty) {
          empty.style.display = "block";
          empty.textContent = "Select a project to view its wiki.";
        }
        return;
      }
      try {
        const res = await apiFetch("/api/wiki?project=" + encodeURIComponent(projectId), { headers: apiHeaders() });
        if (!res.ok) {
          if (view) view.innerHTML = "";
          if (empty) {
            empty.style.display = "block";
            empty.textContent = "Unable to load wiki for this project.";
          }
          return;
        }
        const data = await res.json();
        if (!data.exists) {
          if (view) view.innerHTML = "";
          if (empty) {
            empty.style.display = "block";
            empty.textContent = "No wiki has been generated for this project yet. Click Regenerate to create one.";
          }
          return;
        }
        if (empty) empty.style.display = "none";
        if (view) view.innerHTML = data.renderedHtml || wrapWikiH2(renderPromptMarkdownHtml(data.markdown || ""));
      } catch {
        if (view) view.innerHTML = "";
        if (empty) {
          empty.style.display = "block";
          empty.textContent = "Unable to load wiki for this project.";
        }
      }
    }

    const wikiSelEl = document.getElementById("wiki-vault-select");
    if (wikiSelEl) {
      wikiSelEl.addEventListener("change", () => { loadWiki(); });
    }
    const wikiRegenBtn = document.getElementById("btn-wiki-regenerate");
    if (wikiRegenBtn) {
      wikiRegenBtn.addEventListener("click", async () => {
        const sel = document.getElementById("wiki-vault-select");
        const projectId = sel ? sel.value : "";
        if (!projectId || projectId === "all") return;
        wikiRegenBtn.disabled = true;
        try {
          const res = await apiFetch("/api/wiki/regenerate", {
            method: "POST",
            headers: Object.assign({ "Content-Type": "application/json" }, apiHeaders()),
            body: JSON.stringify({ projectId: projectId })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            showBanner((data && data.error) || "Wiki regenerate failed", "error");
            return;
          }
          if (data.aiError) {
            showBanner("Wiki saved (AI polish skipped: " + data.aiError + ")", "info");
          } else {
            showBanner("Wiki regenerated for " + data.projectId, "success");
          }
          await loadWiki();
        } catch (err) {
          showBanner("Wiki regenerate failed: " + (err.message || String(err)), "error");
        } finally {
          wikiRegenBtn.disabled = false;
        }
      });
    }

    let vaultsManagerBusy = false;

    function setVaultsManagerBusy(busy) {
      vaultsManagerBusy = busy;
      document.querySelectorAll("#tab-vaults button[data-vault-action]").forEach((btn) => {
        btn.disabled = busy;
      });
    }

    async function vaultManagerApi(path, body, method) {
      const httpMethod = method || (body ? "POST" : "GET");
      const res = await apiFetch(path, {
        method: httpMethod,
        headers: Object.assign({}, apiHeaders(), body ? { "Content-Type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || res.statusText || "Request failed");
      }
      return data;
    }

    function renderVaultsManagerTable() {
      const tbody = document.getElementById("vaults-manager-tbody");
      if (!tbody) return;
      if (!vaults.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--muted);">No vault projects found</td></tr>';
        return;
      }
      tbody.innerHTML = vaults.map((v) => {
        const alias = v.aliasOf ? String(v.aliasOf) : "-";
        const count = v.recordCount != null ? String(v.recordCount) : "0";
        const safeId = String(v.id).replace(/"/g, "");
        return '<tr>' +
          '<td><code>' + safeId + '</code></td>' +
          '<td>' + (v.displayName || v.id) + '</td>' +
          '<td>' + alias + '</td>' +
          '<td>' + count + '</td>' +
          '<td>' +
            '<button type="button" class="btn-secondary" data-vault-action="edit" data-id="' + safeId + '" style="padding:4px 8px; margin-right:4px;">Edit</button>' +
            '<button type="button" class="btn-secondary" data-vault-action="alias" data-id="' + safeId + '" style="padding:4px 8px; margin-right:4px;">Alias</button>' +
            '<button type="button" class="btn-secondary" data-vault-action="merge" data-id="' + safeId + '" style="padding:4px 8px; margin-right:4px;">Merge</button>' +
            (v.aliasOf ? '<button type="button" class="btn-secondary" data-vault-action="unalias" data-id="' + safeId + '" style="padding:4px 8px; margin-right:4px;">Remove alias</button>' : '') +
            '<button type="button" class="btn-secondary" data-vault-action="delete" data-id="' + safeId + '" style="padding:4px 8px;">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join("");
    }

    async function loadVaultsManager() {
      await loadVaults();
      renderVaultsManagerTable();
    }

    const vaultsTbody = document.getElementById("vaults-manager-tbody");
    if (vaultsTbody) {
      vaultsTbody.addEventListener("click", async (ev) => {
        const btn = ev.target.closest("button[data-vault-action]");
        if (!btn || vaultsManagerBusy) return;
        const action = btn.getAttribute("data-vault-action");
        const id = btn.getAttribute("data-id");
        if (!action || !id) return;
        try {
          setVaultsManagerBusy(true);
          if (action === "edit") {
            const name = window.prompt("Display name for " + id + ":", vaults.find((v) => v.id === id)?.displayName || id);
            if (name == null) return;
            await vaultManagerApi("/api/vaults/update", { id, displayName: name });
            showBanner("Updated display name for " + id, "success");
          } else if (action === "alias") {
            const to = window.prompt("Canonical target id for alias from " + id + ":");
            if (!to) return;
            await vaultManagerApi("/api/vaults/alias", { from: id, to });
            showBanner("Alias set: " + id + " → " + to, "success");
          } else if (action === "unalias") {
            await vaultManagerApi("/api/vaults/alias", { from: id }, "DELETE");
            showBanner("Alias removed for " + id, "success");
          } else if (action === "merge") {
            const sourcesRaw = window.prompt("Source ids to merge into " + id + " (comma-separated):");
            if (!sourcesRaw) return;
            const sources = sourcesRaw.split(",").map((s) => s.trim()).filter(Boolean);
            const copyRecords = window.confirm("Copy records from sources into " + id + "? Cancel = alias only.");
            await vaultManagerApi("/api/vaults/merge", { sources, target: id, copyRecords });
            showBanner("Merged " + sources.length + " source(s) into " + id, "success");
          } else if (action === "delete") {
            const typed = window.prompt('Type project id "' + id + '" to confirm delete:');
            if (typed !== id) {
              showBanner("Delete cancelled — id did not match", "error");
              return;
            }
            await vaultManagerApi("/api/vaults/delete", { id, confirm: true });
            showBanner("Deleted project " + id, "success");
          }
          await loadVaultsManager();
        } catch (err) {
          showBanner(String(err.message || err), "error");
        } finally {
          setVaultsManagerBusy(false);
        }
      });
    }

    const btnVaultsRefresh = document.getElementById("btn-vaults-refresh");
    if (btnVaultsRefresh) {
      btnVaultsRefresh.addEventListener("click", () => loadVaultsManager());
    }
    const btnVaultCreate = document.getElementById("btn-vault-create");
    if (btnVaultCreate) {
      btnVaultCreate.addEventListener("click", async () => {
        if (vaultsManagerBusy) return;
        const newId = window.prompt("New project id (filesystem-safe):");
        if (!newId) return;
        const displayName = window.prompt("Display name:", newId) || newId;
        try {
          setVaultsManagerBusy(true);
          await vaultManagerApi("/api/vaults/create", { id: newId, displayName });
          showBanner("Created project " + newId, "success");
          await loadVaultsManager();
        } catch (err) {
          showBanner(String(err.message || err), "error");
        } finally {
          setVaultsManagerBusy(false);
        }
      });
    }

    loadVaults().then(() => {
      const tabParam = urlParams.get("tab");
      const hashTab = (window.location.hash || "").replace("#", "");
      if (tabParam === "backups" || hashTab === "tab-backups") {
        activateTab("tab-backups");
      }
      if (tabParam === "wiki" || hashTab === "tab-wiki") {
        const wikiSel = document.getElementById("wiki-vault-select");
        const projectParam = urlParams.get("project");
        if (wikiSel && projectParam && vaults.some((v) => v.id === projectParam)) {
          wikiSel.value = projectParam;
        }
        activateTab("tab-wiki");
      }
      if (tabParam === "vaults" || hashTab === "tab-vaults") {
        activateTab("tab-vaults");
      }
      reconnectStream(true);
      refreshStatus();
      setInterval(refreshStatus, 3000);
    });
  </script>
</body>
</html>`;
}

export function startStatusServer(options: StatusServerOptions): Promise<StatusServerInstance> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const config = ensureVaultStructure(vaultRoot);
  const configuredPorts = resolveConfiguredPorts(vaultRoot, config);
  const port = options.port ?? configuredPorts.status;
  const host = options.host || "127.0.0.1";
  const authToken =
    options.authToken ||
    process.env.SPEC_MEMO_AUTH_TOKEN ||
    process.env.SPEC_MEMO_STATUS_TOKEN ||
    process.env.SPEC_MEMO_SSE_TOKEN;
  const bus = options.activityBus;
  const errorLogPath = options.errorLogPath;

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !authToken) {
    const err = new Error(
      "Refusing to bind status monitor to a non-loopback host without authentication token (--auth-token or SPEC_MEMO_AUTH_TOKEN / SPEC_MEMO_STATUS_TOKEN / SPEC_MEMO_SSE_TOKEN)."
    );
    logErrorReport({
      subsystem: "status-server",
      port,
      host,
      error: err,
      level: "FATAL"
    }, { vaultRoot, logPath: errorLogPath });
    throw err;
  }

  const packageVersion = getPackageVersion();
  const html = generateStatusHtml(packageVersion);
  const loginHtml = generateLoginHtml(packageVersion);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const started = Date.now();
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const pathname = url.pathname;
      const method = req.method || "GET";

      setCorsHeaders(res);

      res.on("finish", () => {
        const durationMs = Date.now() - started;
        const statusCode = res.statusCode || 500;
        recordTelemetry({
          category: 'http_endpoint',
          operation: `${method} ${pathname}`,
          durationMs,
          success: statusCode < 400,
          errorCode: statusCode >= 400 ? `HTTP_${statusCode}` : undefined,
          vaultRoot,
          metadata: {
            method,
            path: pathname,
            statusCode
          }
        });
      });

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && pathname === "/login") {
        if (!authToken) {
          res.writeHead(302, { Location: "/" });
          res.end();
          return;
        }
        if (isAuthorized(req, url, authToken)) {
          res.writeHead(302, { Location: "/" });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(loginHtml);
        return;
      }

      if (req.method === "POST" && pathname === "/api/auth/login") {
        if (!authToken) {
          writeJson(res, 200, { ok: true, authRequired: false });
          return;
        }
        let submitted = "";
        try {
          const buf = await readBodyBuffer(req, 64 * 1024);
          const raw = buf.toString("utf8").trim();
          const ct = String(req.headers["content-type"] || "");
          if (raw && ct.includes("application/json")) {
            const parsed = JSON.parse(raw) as { token?: string; password?: string };
            submitted = String(parsed.token || parsed.password || "").trim();
          } else if (raw) {
            const params = new URLSearchParams(raw);
            submitted = String(params.get("password") || params.get("token") || "").trim();
          }
        } catch {
          submitted = "";
        }
        const wantsJson = String(req.headers.accept || "").includes("application/json")
          || String(req.headers["content-type"] || "").includes("application/json");
        if (submitted === authToken) {
          if (wantsJson) {
            res.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
              "Set-Cookie": statusAuthCookie(submitted)
            });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(302, {
              Location: "/",
              "Set-Cookie": statusAuthCookie(submitted)
            });
            res.end();
          }
          return;
        }
        if (wantsJson) {
          writeJson(res, 401, { error: "Unauthorized", ok: false });
        } else {
          res.writeHead(302, { Location: "/login?error=1" });
          res.end();
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/auth/logout") {
        const wantsJson = String(req.headers.accept || "").includes("application/json");
        if (wantsJson) {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Set-Cookie": clearStatusAuthCookie()
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(302, {
            Location: "/login",
            "Set-Cookie": clearStatusAuthCookie()
          });
          res.end();
        }
        return;
      }

      if (pathname.startsWith("/api/")) {
        if (!isAuthorized(req, url, authToken)) {
          logErrorReport({
            subsystem: "status-server",
            port,
            host,
            method: req.method,
            endpoint: pathname,
            error: "Unauthorized request: missing or invalid authorization token",
            level: "WARN",
            context: {
              headers: req.headers,
              query: Object.fromEntries(url.searchParams.entries())
            }
          }, { vaultRoot, logPath: errorLogPath });
          writeJson(res, 401, { error: "Unauthorized" });
          return;
        }
      }

      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        if (authToken && !isAuthorized(req, url, authToken)) {
          const base = pathname === "/index.html" ? "/index.html" : "/";
          const cleanParams = new URLSearchParams(url.searchParams);
          cleanParams.delete("token");
          cleanParams.delete("authToken");
          const qs = cleanParams.toString();
          const next = safeStatusNextPath(base + (qs ? `?${qs}` : ""));
          res.writeHead(302, { Location: "/login?next=" + encodeURIComponent(next) });
          res.end();
          return;
        }
        // Optional: promote ?token= into a cookie and strip from URL on next navigation
        const queryToken = url.searchParams.get("token") || url.searchParams.get("authToken");
        if (authToken && queryToken && queryToken === authToken) {
          const cleanParams = new URLSearchParams(url.searchParams);
          cleanParams.delete("token");
          cleanParams.delete("authToken");
          const qs = cleanParams.toString();
          res.writeHead(302, {
            Location: "/" + (qs ? `?${qs}` : ""),
            "Set-Cookie": statusAuthCookie(queryToken)
          });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && pathname === "/api/status") {
        const projects = getVaultProjectList(vaultRoot);
        const mcp = options.getMcp?.();
        const clients = bus.listClients();
        const config = ensureVaultStructure(vaultRoot);
        const mode = (config.mode as 'local' | 'hybrid' | 'remote') || 'local';
        const isProxy = Boolean(options.isProxy || mode === 'remote');
        const isRemoteDaemon = Boolean(options.isDaemon || (mode === 'local' && mcp?.available));

        let role: TopologyRole;
        let roleLabel: string;
        let description: string;
        let upstreamRemoteUrl: string | null = null;
        let syncSummary: string | undefined;

        if (mode === 'remote' || isProxy) {
          role = 'intermediary-proxy';
          roleLabel = 'Intermediary Proxy / Client Node';
          upstreamRemoteUrl = config.remote?.url || null;
          description = 'Intermediary proxy node forwarding MCP requests to upstream master daemon.';
          syncSummary = upstreamRemoteUrl ? `Forwarding to ${upstreamRemoteUrl}` : 'Upstream remote not configured';
        } else if (mode === 'hybrid') {
          role = 'intermediary-proxy';
          roleLabel = 'Intermediary Proxy / Sync Node';
          upstreamRemoteUrl = config.remote?.url || null;
          description = 'Hybrid node caching memory locally and synchronizing deltas with remote master daemon.';
          syncSummary = upstreamRemoteUrl ? `Syncing with ${upstreamRemoteUrl}` : 'Upstream sync origin not configured';
        } else {
          if (options.isDaemon) {
            role = 'final-remote';
            roleLabel = 'Final Remote Master Vault';
            description = 'Authoritative central master repository and ultimate backup source of memory.';
          } else {
            role = 'local-vault';
            roleLabel = 'Local Vault (Standalone)';
            description = 'Self-contained local filesystem store with local FTS5 indexing.';
          }
        }

        const topology: TopologyInfo = {
          mode,
          role,
          roleLabel,
          upstreamRemoteUrl,
          isProxy,
          isRemoteDaemon,
          syncSummary,
          description
        };

        writeJson(res, 200, {
          status: "ok",
          service: "spec-memo-status-monitor",
          version: packageVersion,
          host,
          port: (server.address() as { port: number } | null)?.port ?? port,
          mode,
          role,
          topology,
          mcp: mcp?.available
            ? {
                host: mcp.host,
                port: mcp.port,
                activeTransports: mcp.activeTransports,
                available: true
              }
            : { available: false, disconnected: true },
          projectsCount: projects.length,
          uptimeMs: Date.now() - bus.startedAt,
          eventsBuffered: bus.list().length,
          clients,
          activeClientsCount: clients.filter((c) => c.active).length
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/clients") {
        writeJson(res, 200, {
          clients: bus.listClients()
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/vaults") {
        writeJson(res, 200, getVaultProjectList(vaultRoot));
        return;
      }

      if (req.method === "POST" && pathname === "/api/vaults/alias") {
        const startTime = Date.now();
        try {
          const rawBody = await readBodyBuffer(req, 64 * 1024);
          let parsed: { from?: string; to?: string } = {};
          if (rawBody.length > 0) {
            try {
              parsed = JSON.parse(rawBody.toString("utf8"));
            } catch {
              writeJson(res, 400, sanitizeToolOutput({ error: "Invalid JSON body" }));
              return;
            }
          }
          const result = await setProjectAlias(String(parsed.from || ""), String(parsed.to || ""), vaultRoot);
          bus.capture({
            type: "system",
            kind: "write",
            ok: true,
            durationMs: Date.now() - startTime,
            summary: `vault alias ${result.from} -> ${result.to}`,
            method: "POST",
            path: "/api/vaults/alias",
            statusCode: 200
          });
          writeJson(res, 200, sanitizeToolOutput({ ok: true, ...result }));
        } catch (err: unknown) {
          const status = err instanceof VaultManagerError ? err.httpStatus : 500;
          const msg = err instanceof Error ? err.message : String(err);
          writeJson(res, status, sanitizeToolOutput({ error: msg }));
        }
        return;
      }

      if (req.method === "DELETE" && pathname === "/api/vaults/alias") {
        const startTime = Date.now();
        try {
          const rawBody = await readBodyBuffer(req, 64 * 1024);
          let parsed: { from?: string } = {};
          if (rawBody.length > 0) {
            try {
              parsed = JSON.parse(rawBody.toString("utf8"));
            } catch {
              writeJson(res, 400, sanitizeToolOutput({ error: "Invalid JSON body" }));
              return;
            }
          }
          const result = await removeProjectAlias(String(parsed.from || ""), vaultRoot);
          bus.capture({
            type: "system",
            kind: "write",
            ok: true,
            durationMs: Date.now() - startTime,
            summary: `vault alias removed ${result.from}`,
            method: "DELETE",
            path: "/api/vaults/alias",
            statusCode: 200
          });
          writeJson(res, 200, sanitizeToolOutput({ ok: true, ...result }));
        } catch (err: unknown) {
          const status = err instanceof VaultManagerError ? err.httpStatus : 500;
          const msg = err instanceof Error ? err.message : String(err);
          writeJson(res, status, sanitizeToolOutput({ error: msg }));
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/vaults/merge") {
        const startTime = Date.now();
        try {
          const rawBody = await readBodyBuffer(req, 256 * 1024);
          let parsed: { sources?: string[]; target?: string; copyRecords?: boolean } = {};
          if (rawBody.length > 0) {
            try {
              parsed = JSON.parse(rawBody.toString("utf8"));
            } catch {
              writeJson(res, 400, sanitizeToolOutput({ error: "Invalid JSON body" }));
              return;
            }
          }
          const result = await mergeVaultProjects({
            sources: Array.isArray(parsed.sources) ? parsed.sources : [],
            target: String(parsed.target || ""),
            copyRecords: parsed.copyRecords === true,
            vaultRoot
          });
          bus.capture({
            type: "system",
            kind: "write",
            ok: true,
            durationMs: Date.now() - startTime,
            summary: `vault merge -> ${result.target}`,
            method: "POST",
            path: "/api/vaults/merge",
            statusCode: 200
          });
          writeJson(res, 200, sanitizeToolOutput(result));
        } catch (err: unknown) {
          const status = err instanceof VaultManagerError ? err.httpStatus : 500;
          const msg = err instanceof Error ? err.message : String(err);
          writeJson(res, status, sanitizeToolOutput({ error: msg }));
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/vaults/create") {
        const startTime = Date.now();
        try {
          const rawBody = await readBodyBuffer(req, 64 * 1024);
          let parsed: { id?: string; displayName?: string } = {};
          if (rawBody.length > 0) {
            try {
              parsed = JSON.parse(rawBody.toString("utf8"));
            } catch {
              writeJson(res, 400, sanitizeToolOutput({ error: "Invalid JSON body" }));
              return;
            }
          }
          const result = await createVaultProject(
            String(parsed.id || ""),
            String(parsed.displayName || parsed.id || ""),
            vaultRoot
          );
          bus.capture({
            type: "system",
            kind: "write",
            ok: true,
            durationMs: Date.now() - startTime,
            summary: `vault create ${result.id}`,
            method: "POST",
            path: "/api/vaults/create",
            statusCode: 201
          });
          writeJson(res, 201, sanitizeToolOutput({ ok: true, ...result }));
        } catch (err: unknown) {
          const status = err instanceof VaultManagerError ? err.httpStatus : 500;
          const msg = err instanceof Error ? err.message : String(err);
          writeJson(res, status, sanitizeToolOutput({ error: msg }));
        }
        return;
      }

      if (
        (req.method === "PATCH" && pathname.startsWith("/api/vaults/")) ||
        (req.method === "POST" && pathname === "/api/vaults/update")
      ) {
        const startTime = Date.now();
        try {
          const rawBody = await readBodyBuffer(req, 64 * 1024);
          let parsed: { id?: string; displayName?: string } = {};
          if (rawBody.length > 0) {
            try {
              parsed = JSON.parse(rawBody.toString("utf8"));
            } catch {
              writeJson(res, 400, sanitizeToolOutput({ error: "Invalid JSON body" }));
              return;
            }
          }
          let projectId = parsed.id;
          if (!projectId && req.method === "PATCH") {
            const parts = pathname.split("/").filter(Boolean);
            if (parts.length >= 3) projectId = decodeURIComponent(parts[2]);
          }
          const result = await updateVaultProject(
            String(projectId || ""),
            String(parsed.displayName || ""),
            vaultRoot
          );
          bus.capture({
            type: "system",
            kind: "write",
            ok: true,
            durationMs: Date.now() - startTime,
            summary: `vault update ${result.id}`,
            method: req.method || "POST",
            path: pathname,
            statusCode: 200
          });
          writeJson(res, 200, sanitizeToolOutput({ ok: true, ...result }));
        } catch (err: unknown) {
          const status = err instanceof VaultManagerError ? err.httpStatus : 500;
          const msg = err instanceof Error ? err.message : String(err);
          writeJson(res, status, sanitizeToolOutput({ error: msg }));
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/vaults/delete") {
        const startTime = Date.now();
        try {
          const rawBody = await readBodyBuffer(req, 64 * 1024);
          let parsed: { id?: string; confirm?: boolean; force?: boolean } = {};
          if (rawBody.length > 0) {
            try {
              parsed = JSON.parse(rawBody.toString("utf8"));
            } catch {
              writeJson(res, 400, sanitizeToolOutput({ error: "Invalid JSON body" }));
              return;
            }
          }
          const result = await deleteVaultProject({
            id: String(parsed.id || ""),
            confirm: parsed.confirm === true,
            force: parsed.force === true,
            vaultRoot
          });
          bus.capture({
            type: "system",
            kind: "write",
            ok: true,
            durationMs: Date.now() - startTime,
            summary: `vault delete ${result.id}`,
            method: "POST",
            path: "/api/vaults/delete",
            statusCode: 200
          });
          writeJson(res, 200, sanitizeToolOutput(result));
        } catch (err: unknown) {
          const status = err instanceof VaultManagerError ? err.httpStatus : 500;
          const msg = err instanceof Error ? err.message : String(err);
          writeJson(res, status, sanitizeToolOutput({ error: msg }));
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/records") {
        const project = url.searchParams.get("project") || undefined;
        const kind = url.searchParams.get("kind") || undefined;
        const sortRaw = url.searchParams.get("sort") || "hits";
        const sort =
          sortRaw === "occurrences" || sortRaw === "updated" || sortRaw === "hits"
            ? sortRaw
            : "hits";
        const limit = url.searchParams.get("limit")
          ? Number(url.searchParams.get("limit"))
          : 200;
        const records = listMemoryRecords({
          vaultRoot,
          projectId: project && project !== "all" ? project : undefined,
          kind: kind || undefined,
          sort,
          limit: Number.isFinite(limit) && limit > 0 ? limit : 200
        });
        writeJson(res, 200, sanitizeToolOutput({ records }));
        return;
      }

      if (req.method === "GET" && pathname === "/api/wiki") {
        try {
          const project = url.searchParams.get("project");
          const payload = readWikiFile(project, vaultRoot);
          const renderedHtml = payload.exists
            ? wrapWikiH2Html(renderPromptMarkdownHtml(payload.markdown))
            : "";
          writeJson(res, 200, sanitizeToolOutput({ ...payload, renderedHtml }));
        } catch (err: unknown) {
          if (err instanceof WikiError) {
            writeJson(res, err.httpStatus, sanitizeToolOutput({ error: err.message }));
            return;
          }
          writeJson(res, 500, sanitizeToolOutput({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/wiki/section") {
        try {
          const project = url.searchParams.get("project");
          const sectionId = url.searchParams.get("id");
          const payload = readWikiSection(project, sectionId, vaultRoot);
          writeJson(res, 200, sanitizeToolOutput(payload));
        } catch (err: unknown) {
          if (err instanceof WikiError) {
            writeJson(res, err.httpStatus, sanitizeToolOutput({ error: err.message }));
            return;
          }
          writeJson(res, 500, sanitizeToolOutput({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/wiki/regenerate") {
        const startTime = Date.now();
        try {
          const rawBody = await readBodyBuffer(req, 1024 * 1024);
          let parsed: { projectId?: string } = {};
          if (rawBody.length > 0) {
            try {
              parsed = JSON.parse(rawBody.toString("utf8"));
            } catch {
              writeJson(res, 400, sanitizeToolOutput({ error: "Invalid JSON body" }));
              return;
            }
          }
          const result = await regenerateWiki({
            projectId: parsed.projectId as string,
            vaultRoot
          });
          bus.capture({
            type: "system",
            kind: "write",
            ok: true,
            durationMs: Date.now() - startTime,
            summary: `wiki regenerated ${result.projectId}`,
            projectId: result.projectId,
            method: "POST",
            path: "/api/wiki/regenerate",
            statusCode: 200
          });
          writeJson(res, 200, sanitizeToolOutput(result));
        } catch (err: unknown) {
          if (err instanceof WikiError) {
            writeJson(res, err.httpStatus, sanitizeToolOutput({ error: err.message }));
            return;
          }
          writeJson(res, 500, sanitizeToolOutput({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/vaults/export") {
        const startTime = Date.now();
        let targetProjectId = "";
        try {
          const rawBody = await readBodyBuffer(req, 1024 * 1024);
          let parsed: { projectId?: string; password?: string; confirmFullBackup?: boolean } = {};
          if (rawBody.length > 0) {
            try {
              parsed = JSON.parse(rawBody.toString("utf8"));
            } catch {
              logErrorReport({
                subsystem: "status-server",
                port,
                host,
                method: "POST",
                endpoint: "/api/vaults/export",
                error: "Invalid JSON body"
              }, { vaultRoot, logPath: errorLogPath });
              writeJson(res, 400, { error: "Invalid JSON body" });
              return;
            }
          }

          targetProjectId = parsed.projectId || "";
          if (!targetProjectId) {
            if (parsed.confirmFullBackup !== true) {
              writeJson(res, 400, { error: "confirmFullBackup required for full backup" });
              return;
            }
            const exportResult = await exportVault({
              vaultRoot,
              password: parsed.password || undefined
            });
            if (!exportResult.payload) {
              throw new Error("Export yielded empty payload");
            }
            const zipBuffer = packVaultZip(exportResult.payload);
            const timestamp = backupTimestampSuffix();
            const filename = `spec-memo-vault-full-${timestamp}.zip`;
            bus.capture({
              type: "system",
              kind: "write",
              ok: true,
              durationMs: Date.now() - startTime,
              summary: `export full vault (${exportResult.recordsCount} records, ${exportResult.projectsCount} projects)`
            });
            setCorsHeaders(res);
            res.writeHead(200, {
              "Content-Type": "application/zip",
              "Content-Disposition": `attachment; filename="${filename}"`,
              "Content-Length": zipBuffer.length
            });
            res.end(zipBuffer);
            return;
          }

          if (typeof targetProjectId !== "string") {
            writeJson(res, 400, { error: "Unknown projectId" });
            return;
          }

          const projects = getVaultProjectList(vaultRoot);
          if (!projects.some((p) => p.id === targetProjectId)) {
            logErrorReport({
              subsystem: "status-server",
              port,
              host,
              method: "POST",
              endpoint: "/api/vaults/export",
              error: `Unknown projectId: ${targetProjectId}`,
              projectId: targetProjectId
            }, { vaultRoot, logPath: errorLogPath });
            writeJson(res, 400, { error: "Unknown projectId" });
            return;
          }

          const exportResult = await exportVault({
            vaultRoot,
            projectId: targetProjectId,
            password: parsed.password || undefined
          });

          if (!exportResult.payload) {
            throw new Error("Export yielded empty payload");
          }

          const zipBuffer = packVaultZip(exportResult.payload);
          const timestamp = backupTimestampSuffix();
          const filename = `spec-memo-vault-${targetProjectId}-${timestamp}.zip`;

          bus.capture({
            type: "system",
            kind: "write",
            ok: true,
            durationMs: Date.now() - startTime,
            summary: `export vault ${targetProjectId} (${exportResult.recordsCount} records)`,
            projectId: targetProjectId
          });

          setCorsHeaders(res);
          res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Content-Length": zipBuffer.length
          });
          res.end(zipBuffer);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logErrorReport({
            subsystem: "status-server",
            port,
            host,
            method: "POST",
            endpoint: "/api/vaults/export",
            error: err,
            projectId: targetProjectId || undefined
          }, { vaultRoot, logPath: errorLogPath });
          bus.capture({
            type: "system",
            kind: "write",
            ok: false,
            durationMs: Date.now() - startTime,
            summary: `export vault ${targetProjectId || "unknown"} failed: ${msg}`,
            projectId: targetProjectId || undefined
          });
          writeJson(res, 500, { error: msg });
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/vaults/import") {
        const startTime = Date.now();
        const maxImportBytes = 64 * 1024 * 1024; // 64 MiB

        const contentType = req.headers["content-type"] || "";
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        if (!boundaryMatch) {
          logErrorReport({
            subsystem: "status-server",
            port,
            host,
            method: "POST",
            endpoint: "/api/vaults/import",
            error: "Content-Type must be multipart/form-data with boundary."
          }, { vaultRoot, logPath: errorLogPath });
          writeJson(res, 400, { ok: false, error: "Content-Type must be multipart/form-data with boundary." });
          return;
        }

        const boundary = (boundaryMatch[1] || boundaryMatch[2]).trim();

        try {
          const rawBody = await readBodyBuffer(req, maxImportBytes);
          const parsed = parseMultipartFormData(rawBody, boundary);

          const archiveFile = parsed.files["archive"];
          if (!archiveFile || !archiveFile.data || archiveFile.data.length === 0) {
            logErrorReport({
              subsystem: "status-server",
              port,
              host,
              method: "POST",
              endpoint: "/api/vaults/import",
              error: "Missing archive file"
            }, { vaultRoot, logPath: errorLogPath });
            writeJson(res, 400, { ok: false, error: "Missing archive file" });
            return;
          }

          const archiveBuf = archiveFile.data;
          if (
            archiveBuf.length < 4 ||
            archiveBuf[0] !== 0x50 ||
            archiveBuf[1] !== 0x4b ||
            archiveBuf[2] !== 0x03 ||
            archiveBuf[3] !== 0x04
          ) {
            logErrorReport({
              subsystem: "status-server",
              port,
              host,
              method: "POST",
              endpoint: "/api/vaults/import",
              error: "Invalid archive format: expected ZIP file"
            }, { vaultRoot, logPath: errorLogPath });
            writeJson(res, 400, { ok: false, error: "Invalid archive format: expected ZIP file" });
            return;
          }

          let jsonPayload: string;
          try {
            jsonPayload = unpackVaultZip(archiveBuf);
          } catch (e: unknown) {
            const unpackMsg = e instanceof Error ? e.message : String(e);
            logErrorReport({
              subsystem: "status-server",
              port,
              host,
              method: "POST",
              endpoint: "/api/vaults/import",
              error: unpackMsg
            }, { vaultRoot, logPath: errorLogPath });
            writeJson(res, 400, { ok: false, error: unpackMsg });
            return;
          }

          const password = parsed.fields["password"] || undefined;
          const importResult = await importVault({
            vaultRoot,
            payload: jsonPayload,
            password,
            overwrite: true
          });

          const isSingle = importResult.restoredProjects.length === 1;
          const targetProj = isSingle ? importResult.restoredProjects[0] : undefined;

          bus.capture({
            type: "system",
            kind: "write",
            ok: true,
            durationMs: Date.now() - startTime,
            summary: `import vault (${importResult.restoredRecordsCount} records, ${importResult.restoredProjectsCount} projects)`,
            projectId: targetProj
          });

          writeJson(res, 200, {
            ok: true,
            restoredProjectsCount: importResult.restoredProjectsCount,
            restoredRecordsCount: importResult.restoredRecordsCount,
            restoredProjects: importResult.restoredProjects
          });
        } catch (err: unknown) {
          const statusCode = (err as any)?.statusCode === 413 ? 413 : 400;
          const msg = err instanceof Error ? err.message : String(err);

          logErrorReport({
            subsystem: "status-server",
            port,
            host,
            method: "POST",
            endpoint: "/api/vaults/import",
            error: err
          }, { vaultRoot, logPath: errorLogPath });

          bus.capture({
            type: "system",
            kind: "write",
            ok: false,
            durationMs: Date.now() - startTime,
            summary: `import vault failed: ${msg}`
          });

          writeJson(res, statusCode, { ok: false, error: msg });
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/vaults/backups") {
        try {
          const parsedFilters = parseBackupListFilters(url);
          if ("error" in parsedFilters) {
            writeJson(res, 400, { ok: false, error: parsedFilters.error });
            return;
          }
          const backups = listBackups(vaultRoot, parsedFilters);
          writeJson(res, 200, sanitizeToolOutput({ ok: true, backups }));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          writeJson(res, 500, { ok: false, error: msg });
        }
        return;
      }

      const backupFileMatch = pathname.match(/^\/api\/vaults\/backups\/([^/]+)(\/inspect)?$/);
      if (backupFileMatch) {
        const rawFilename = decodeURIComponent(backupFileMatch[1]);
        const isInspect = backupFileMatch[2] === "/inspect";

        if ((req.method === "GET" || req.method === "POST") && isInspect) {
          try {
            let password: string | undefined;
            if (req.method === "POST") {
              const rawBody = await readBodyBuffer(req, 64 * 1024);
              if (rawBody.length > 0) {
                let parsed: { password?: unknown };
                try {
                  parsed = JSON.parse(rawBody.toString("utf8"));
                } catch {
                  writeJson(res, 400, { ok: false, error: "Invalid JSON body" });
                  return;
                }
                if (typeof parsed.password === "string" && parsed.password) {
                  password = parsed.password;
                }
              }
            } else if (url.searchParams.has("password")) {
              writeJson(res, 400, { ok: false, error: "Password must be sent in the POST JSON body, not the query string." });
              return;
            }
            const result = inspectBackup(rawFilename, { vaultRoot, password });
            writeJson(res, 200, sanitizeToolOutput(result));
          } catch (err: unknown) {
            const code = (err as Error & { code?: string }).code;
            const msg = err instanceof Error ? err.message : String(err);
            if (code === "BACKUP_DECRYPT_FAILED") {
              writeJson(res, 401, { ok: false, error: msg });
              return;
            }
            if (code === "BACKUP_NOT_FOUND") {
              writeJson(res, 404, { ok: false, error: msg });
              return;
            }
            if (msg.includes("Invalid backup filename") || msg.includes("escapes")) {
              writeJson(res, 400, { ok: false, error: msg });
              return;
            }
            writeJson(res, 400, { ok: false, error: msg });
          }
          return;
        }

        if (req.method === "GET" && !isInspect) {
          try {
            const fullPath = resolveBackupPath(vaultRoot, rawFilename);
            if (!fs.existsSync(fullPath)) {
              writeJson(res, 404, { ok: false, error: "Backup not found" });
              return;
            }
            const safeName = path.basename(fullPath);
            const contentType = safeName.endsWith(".json")
              ? "application/json"
              : "application/zip";
            setCorsHeaders(res);
            res.writeHead(200, {
              "Content-Type": contentType,
              "Content-Disposition": `attachment; filename="${safeName}"`
            });
            fs.createReadStream(fullPath).pipe(res);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            writeJson(res, 400, { ok: false, error: msg });
          }
          return;
        }

        if (req.method === "DELETE" && !isInspect) {
          const startTime = Date.now();
          try {
            const rawBody = await readBodyBuffer(req, 64 * 1024);
            let parsed: { confirm?: boolean } = {};
            if (rawBody.length > 0) {
              try {
                parsed = JSON.parse(rawBody.toString("utf8"));
              } catch {
                writeJson(res, 400, { ok: false, error: "Invalid JSON body" });
                return;
              }
            }
            if (parsed.confirm !== true) {
              writeJson(res, 400, { ok: false, error: "Delete confirmation required (confirm: true)." });
              return;
            }
            const result = await deleteBackup(rawFilename, vaultRoot);
            bus.capture({
              type: "system",
              kind: "write",
              ok: true,
              durationMs: Date.now() - startTime,
              summary: `backup deleted ${result.filename}`
            });
            writeJson(res, 200, sanitizeToolOutput({ ok: true, filename: result.filename }));
          } catch (err: unknown) {
            const code = (err as Error & { code?: string }).code;
            const msg = err instanceof Error ? err.message : String(err);
            if (code === "BACKUP_NOT_FOUND") {
              writeJson(res, 404, { ok: false, error: msg });
              return;
            }
            writeJson(res, 400, { ok: false, error: msg });
          }
          return;
        }
      }

      if (req.method === "POST" && pathname === "/api/vaults/backups") {
        const startTime = Date.now();
        try {
          const rawBody = await readBodyBuffer(req, 1024 * 1024);
          let parsed: { projectId?: string; password?: string; confirmFullBackup?: boolean } = {};
          if (rawBody.length > 0) {
            try {
              parsed = JSON.parse(rawBody.toString("utf8"));
            } catch {
              writeJson(res, 400, { ok: false, error: "Invalid JSON body" });
              return;
            }
          }

          const targetProjectId = parsed.projectId || "";
          if (!targetProjectId) {
            if (parsed.confirmFullBackup !== true) {
              writeJson(res, 400, { error: "confirmFullBackup required for full backup" });
              return;
            }
          } else {
            const projects = getVaultProjectList(vaultRoot);
            if (!projects.some((p) => p.id === targetProjectId)) {
              writeJson(res, 400, { error: "Unknown projectId" });
              return;
            }
          }

          const result = await persistVaultBackup({
            vaultRoot,
            projectId: targetProjectId || undefined,
            password: parsed.password || undefined
          });

          bus.capture({
            type: "system",
            kind: "write",
            ok: true,
            durationMs: Date.now() - startTime,
            summary: `backup created ${result.filename} (${result.recordCount} records, ${result.projectIds.length} projects)`
          });

          writeJson(res, 200, sanitizeToolOutput({
            ok: true,
            filename: result.filename,
            size: result.size,
            recordCount: result.recordCount,
            projectIds: result.projectIds,
            encrypted: result.encrypted
          }));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logErrorReport({
            subsystem: "status-server",
            port,
            host,
            method: "POST",
            endpoint: "/api/vaults/backups",
            error: err
          }, { vaultRoot, logPath: errorLogPath });
          bus.capture({
            type: "system",
            kind: "write",
            ok: false,
            durationMs: Date.now() - startTime,
            summary: `backup create failed: ${msg}`
          });
          writeJson(res, 500, { ok: false, error: msg });
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/vaults/reset") {
        const startTime = Date.now();
        try {
          const rawBody = await readBodyBuffer(req, 1024 * 1024);
          let parsed: { projectId?: string; password?: string; confirm?: boolean; all?: boolean } = {};
          if (rawBody.length > 0) {
            try {
              parsed = JSON.parse(rawBody.toString("utf8"));
            } catch {
              writeJson(res, 400, { ok: false, error: "Invalid JSON body" });
              return;
            }
          }

          if (parsed.confirm !== true) {
            writeJson(res, 400, { ok: false, error: "Reset confirmation required (confirm: true)." });
            return;
          }

          const resetResult = await resetVault({
            vaultRoot,
            projectId: parsed.projectId || undefined,
            all: parsed.all ?? (!parsed.projectId),
            password: parsed.password || undefined
          });

          bus.capture({
            type: "system",
            kind: "write",
            ok: true,
            durationMs: Date.now() - startTime,
            summary: `vault reset: created backup ${resetResult.backupFilename}, wiped ${resetResult.wipedRecordsCount} records across ${resetResult.wipedProjectsCount} projects`,
            projectId: resetResult.projectId
          });

          writeJson(res, 200, sanitizeToolOutput({
            ok: true,
            projectId: resetResult.projectId,
            backupFilename: resetResult.backupFilename,
            backupPath: resetResult.backupPath,
            wipedProjectsCount: resetResult.wipedProjectsCount,
            wipedRecordsCount: resetResult.wipedRecordsCount,
            rebuiltFts: resetResult.rebuiltFts
          }));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logErrorReport({
            subsystem: "status-server",
            port,
            host,
            method: "POST",
            endpoint: "/api/vaults/reset",
            error: err
          }, { vaultRoot, logPath: errorLogPath });

          bus.capture({
            type: "system",
            kind: "write",
            ok: false,
            durationMs: Date.now() - startTime,
            summary: `vault reset failed: ${msg}`
          });

          writeJson(res, 500, { ok: false, error: msg });
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/vaults/restore") {
        const startTime = Date.now();
        try {
          const ct = String(req.headers["content-type"] || "");
          let archivePath: string | undefined;
          let payload: string | undefined;
          let password: string | undefined;
          let overwrite = true;

          if (ct.includes("multipart/form-data")) {
            const boundaryMatch = ct.match(/boundary=([^;]+)/i);
            if (!boundaryMatch) {
              writeJson(res, 400, { ok: false, error: "Missing multipart boundary" });
              return;
            }
            const bodyBuf = await readBodyBuffer(req, 50 * 1024 * 1024);
            const parsed = parseMultipartFormData(bodyBuf, boundaryMatch[1]);
            const fileEntry = parsed.files["archive"] || parsed.files["file"] || Object.values(parsed.files)[0];
            if (!fileEntry) {
              writeJson(res, 400, { ok: false, error: "Missing archive file in multipart form" });
              return;
            }
            const fileBuf = fileEntry.data;
            if (
              (fileBuf.length >= 4 && fileBuf[0] === 0x50 && fileBuf[1] === 0x4b && fileBuf[2] === 0x03 && fileBuf[3] === 0x04) ||
              (fileEntry.filename && fileEntry.filename.toLowerCase().endsWith(".zip"))
            ) {
              payload = unpackVaultZip(fileBuf);
            } else {
              payload = fileBuf.toString("utf8");
            }
            password = parsed.fields["password"] || undefined;
            if (parsed.fields["overwrite"] !== undefined) {
              overwrite = parsed.fields["overwrite"] !== "false";
            }
          } else {
            const rawBody = await readBodyBuffer(req, 1024 * 1024);
            let parsed: { backupFilename?: string; archivePath?: string; password?: string; overwrite?: boolean } = {};
            if (rawBody.length > 0) {
              try {
                parsed = JSON.parse(rawBody.toString("utf8"));
              } catch {
                writeJson(res, 400, { ok: false, error: "Invalid JSON body" });
                return;
              }
            }

            if (parsed.backupFilename) {
              const safeFn = path.basename(parsed.backupFilename);
              const backupsDir = path.join(vaultRoot, "backups");
              archivePath = path.join(backupsDir, safeFn);
            } else if (parsed.archivePath) {
              const resolved = path.resolve(parsed.archivePath);
              const allowedRoots = [
                path.join(vaultRoot, "backups"),
                vaultRoot
              ];
              if (!allowedRoots.some((root) => isPathInside(resolved, root))) {
                writeJson(res, 400, { ok: false, error: "archivePath must be inside the vault or backups directory" });
                return;
              }
              archivePath = resolved;
            } else {
              writeJson(res, 400, { ok: false, error: "Either backupFilename, archivePath, or multipart file must be provided." });
              return;
            }
            password = parsed.password || undefined;
            if (parsed.overwrite !== undefined) {
              overwrite = parsed.overwrite;
            }
          }

          const importResult = await importVault({
            vaultRoot,
            archivePath,
            payload,
            password,
            overwrite
          });

          bus.capture({
            type: "system",
            kind: "write",
            ok: true,
            durationMs: Date.now() - startTime,
            summary: `restore vault (${importResult.restoredRecordsCount} records across ${importResult.restoredProjectsCount} projects)`
          });

          writeJson(res, 200, {
            ok: true,
            restoredProjectsCount: importResult.restoredProjectsCount,
            restoredRecordsCount: importResult.restoredRecordsCount,
            restoredProjects: importResult.restoredProjects,
            rebuiltFts: importResult.rebuiltFts
          });
        } catch (err: unknown) {
          const statusCode = (err as any)?.statusCode === 413 ? 413 : 400;
          const msg = err instanceof Error ? err.message : String(err);

          logErrorReport({
            subsystem: "status-server",
            port,
            host,
            method: "POST",
            endpoint: "/api/vaults/restore",
            error: err
          }, { vaultRoot, logPath: errorLogPath });

          bus.capture({
            type: "system",
            kind: "write",
            ok: false,
            durationMs: Date.now() - startTime,
            summary: `restore vault failed: ${msg}`
          });

          writeJson(res, statusCode, { ok: false, error: msg });
        }
        return;
      }

      if (req.method === "GET" && pathname === "/api/events") {
        const projectFilter = url.searchParams.get("project") || undefined;
        const events = bus.list(projectFilter ? { projectId: projectFilter } : undefined);
        const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
        writeJson(res, 200, { events, nextSeq: maxSeq + 1 });
        return;
      }

      if (req.method === "GET" && pathname === "/api/events/stream") {
        const projectFilter = url.searchParams.get("project") || undefined;
        const afterSeq = parseAfterSeq(url.searchParams.get("afterSeq"));
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive"
        });
        res.write("\n");

        const snapshot = filterEventsForSnapshot(
          bus.list(projectFilter ? { projectId: projectFilter } : undefined),
          projectFilter,
          afterSeq
        );
        res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

        const unsubscribe = bus.subscribe(
          (event) => {
            if (event.seq <= afterSeq) return;
            if (!eventMatchesProjectFilter(event, projectFilter)) return;
            try {
              res.write(`event: activity\ndata: ${JSON.stringify(event)}\n\n`);
            } catch (streamErr: unknown) {
              logErrorReport({
                subsystem: "status-server",
                port,
                host,
                endpoint: "/api/events/stream",
                error: streamErr,
                context: { phase: "sse_client_write" }
              }, { vaultRoot, logPath: errorLogPath });
              unsubscribe();
            }
          },
          projectFilter ? { projectId: projectFilter } : undefined
        );

        req.on("close", () => {
          unsubscribe();
        });
        return;
      }

      // --- Prompt, Session, Activity & Rule Derivation Endpoints ---
      if (req.method === "GET" && pathname === "/api/prompts") {
        const project = url.searchParams.get("project") || undefined;
        const query = url.searchParams.get("query") || undefined;
        const ide = url.searchParams.get("ide") || undefined;
        const model = url.searchParams.get("model") || undefined;
        const agent = url.searchParams.get("agent") || undefined;
        const sessionId = url.searchParams.get("sessionId") || url.searchParams.get("session") || undefined;
        const taskSlug = url.searchParams.get("taskSlug") || url.searchParams.get("slug") || undefined;
        const client = url.searchParams.get("client") || undefined;
        const billable = url.searchParams.has("billable") ? url.searchParams.get("billable") === "true" : undefined;
        const since = url.searchParams.get("since") || undefined;
        const until = url.searchParams.get("until") || undefined;
        const tag = url.searchParams.get("tag") || undefined;
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 20;
        const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : 0;
        const sort = (url.searchParams.get("sort") as any) || "date-desc";
        const crossProject = url.searchParams.get("crossProject") === "true" || !project || project === "all";

        const listOpts = {
          vaultRoot,
          projectId: project && project !== "all" ? project : undefined,
          crossProject,
          query,
          ide,
          model,
          agent,
          sessionId,
          taskSlug,
          client,
          billable,
          since,
          until,
          tags: tag ? [tag] : undefined,
          limit,
          offset,
          sort
        };
        const result = query && query.trim() ? searchPrompts(listOpts) : listPrompts(listOpts);
        writeJson(res, 200, sanitizeToolOutput(result));
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/prompts/sessions/") && pathname.endsWith("/export")) {
        const parts = pathname.slice("/api/prompts/sessions/".length).split("/");
        const sessionId = parts[0];
        const project = url.searchParams.get("project") || undefined;
        if (!project || project === "all") {
          writeJson(res, 400, { error: "project query parameter is required for session export" });
          return;
        }
        const story = await exportSessionStory({
          sessionId,
          vaultRoot,
          projectId: project
        });
        setCorsHeaders(res);
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="session-${sessionId}-story.md"`
        });
        res.end(story.markdown);
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/prompts/sessions/")) {
        const sessionId = pathname.slice("/api/prompts/sessions/".length);
        const project = url.searchParams.get("project") || undefined;
        if (!project || project === "all") {
          writeJson(res, 400, { error: "project query parameter is required for session turns" });
          return;
        }
        const turns = getSessionTurns({
          sessionId,
          vaultRoot,
          projectId: project
        });
        writeJson(res, 200, sanitizeToolOutput({ sessionId, turns }));
        return;
      }

      if (
        req.method === "GET" &&
        pathname.startsWith("/api/prompts/") &&
        !pathname.startsWith("/api/prompts/sessions") &&
        pathname !== "/api/prompts/derive-rules"
      ) {
        const id = pathname.slice("/api/prompts/".length);
        const project = url.searchParams.get("project") || undefined;
        if (!project || project === "all") {
          writeJson(res, 400, { error: "project query parameter is required for prompt detail" });
          return;
        }
        const record =
          (await getRecord({ id, kind: "prompt", vaultRoot, projectId: project })) ||
          (await getRecord({ id, kind: "session", vaultRoot, projectId: project }));
        if (!record) {
          writeJson(res, 404, { error: `Prompt or session '${id}' not found` });
          return;
        }
        const redacted = typeof record.body === "string" && record.body.includes("[REDACTED");
        writeJson(res, 200, {
          ok: true,
          record: sanitizeToolOutput(record),
          renderedHtml: renderPromptMarkdownHtml(record.body || ""),
          secretsRedacted: redacted
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/sessions") {
        const project = url.searchParams.get("project") || undefined;
        const client = url.searchParams.get("client") || undefined;
        const taskSlug = url.searchParams.get("taskSlug") || url.searchParams.get("slug") || undefined;
        const since = url.searchParams.get("since") || undefined;
        const until = url.searchParams.get("until") || undefined;
        const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 20;
        const offset = url.searchParams.get("offset") ? Number(url.searchParams.get("offset")) : 0;
        const crossProject = url.searchParams.get("crossProject") === "true" || !project || project === "all";

        const result = listSessions({
          vaultRoot,
          projectId: project && project !== "all" ? project : undefined,
          crossProject,
          client,
          taskSlug,
          since,
          until,
          limit,
          offset
        });
        writeJson(res, 200, sanitizeToolOutput(result));
        return;
      }

      if (req.method === "GET" && pathname === "/api/activity") {
        const project = url.searchParams.get("project") || undefined;
        const client = url.searchParams.get("client") || undefined;
        const since = url.searchParams.get("since") || undefined;
        const until = url.searchParams.get("until") || undefined;
        const crossProject = url.searchParams.get("crossProject") === "true" || !project || project === "all";

        const result = generateActivityReport({
          vaultRoot,
          projectId: project && project !== "all" ? project : undefined,
          crossProject,
          client,
          since,
          until
        });
        writeJson(res, 200, sanitizeToolOutput(result));
        return;
      }

      if (req.method === "POST" && pathname === "/api/prompts/derive-rules") {
        const rawBody = await readBodyBuffer(req, 1024 * 1024);
        let parsed: any = {};
        if (rawBody.length > 0) {
          try {
            parsed = JSON.parse(rawBody.toString("utf8"));
          } catch {
            writeJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
        }
        if (!parsed.projectId || typeof parsed.projectId !== "string") {
          writeJson(res, 400, { error: "projectId is required for derive-rules" });
          return;
        }
        const meta = getProjectMetadata(parsed.projectId, vaultRoot);
        if (!meta?.lastSeenRoot) {
          writeJson(res, 400, {
            error: "Project metadata missing lastSeenRoot; bind project via bootstrap first"
          });
          return;
        }
        const result = await deriveRulesFromPrompts({
          vaultRoot,
          projectId: parsed.projectId,
          cwd: meta.lastSeenRoot,
          sessionId: parsed.sessionId,
          saveTraps: parsed.saveTraps,
          promote: parsed.promote,
          format: parsed.format
        });
        if (result.savedTraps?.length) {
          scheduleHybridPush(vaultRoot, parsed.projectId);
        }
        writeJson(res, 200, { ok: true, result: sanitizeToolOutput(result) });
        return;
      }

      logErrorReport({
        subsystem: "status-server",
        port,
        host,
        method: req.method,
        endpoint: pathname,
        error: `Route not found: ${req.method} ${pathname}`,
        level: "WARN"
      }, { vaultRoot, logPath: errorLogPath });
      writeJson(res, 404, { error: "Not found" });
    });

    server.on("error", (err) => {
      logErrorReport({
        subsystem: "status-server",
        port,
        host,
        error: err,
        level: "FATAL",
        context: { phase: "server_listen_error" }
      }, { vaultRoot, logPath: errorLogPath });
      reject(err);
    });

    server.listen(port, host, () => {
      const actualPort = (server.address() as { port: number }).port;
      const serverUrl = `http://${host}:${actualPort}`;
      resolve({
        server,
        port: actualPort,
        host,
        url: serverUrl,
        close: () =>
          new Promise<void>((res) => {
            if (typeof (server as any).closeAllConnections === "function") {
              (server as any).closeAllConnections();
            }
            server.close(() => res());
          })
      });
    });
  });
}
