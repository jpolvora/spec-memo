import http from "node:http";
import { getVaultRoot } from "./vault.js";
import { getVaultProjectList } from "./canvas.js";
import { ActivityBus, ActivityEvent, eventMatchesProjectFilter } from "./activity.js";
import { getPackageVersion } from "./version.js";
import { exportVault, importVault } from "./backup.js";
import { packVaultZip, unpackVaultZip, parseMultipartFormData } from "./status-backup.js";
import { logErrorReport } from "./error-logger.js";
import { recordTelemetry } from "./telemetry.js";

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

function isAuthorized(req: http.IncomingMessage, url: URL, authToken?: string): boolean {
  if (!authToken) return true;
  const header = req.headers.authorization;
  if (header) {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match && match[1].trim() === authToken) return true;
    if (header === authToken) return true;
  }
  const queryToken = url.searchParams.get("token") || url.searchParams.get("authToken");
  return queryToken === authToken;
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "*");
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
      --border: #30363d;
      --text: #c9d1d9;
      --bright: #f0f6fc;
      --muted: #8b949e;
      --accent: #58a6ff;
      --ok: #3fb950;
      --err: #f85149;
      --write: #d2a8ff;
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
      padding: 20px 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    header h1 { color: var(--bright); font-size: 1.35rem; font-weight: 600; }
    header h1 span { color: var(--accent); font-weight: 500; font-size: 0.85rem; margin-left: 8px; }
    header h1 .version-tag { color: var(--muted); font-weight: 400; font-size: 0.75rem; margin-left: 6px; }
    .badges { display: flex; gap: 8px; flex-wrap: wrap; }
    .badge {
      font-size: 0.75rem;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--card);
    }
    .badge.live { border-color: var(--ok); color: var(--ok); }
    .badge.reconnecting { border-color: #d29922; color: #d29922; }
    .badge.offline { border-color: var(--err); color: var(--err); }
    .badge-proxy { background: #2e1065; border-color: #a855f7; color: #d8b4fe; }
    .badge-direct-remote { background: #0c2d48; border-color: #38bdf8; color: #7dd3fc; }
    .badge-cli { background: #064e3b; border-color: #34d399; color: #6ee7b7; }
    .badge-web { background: #451a03; border-color: #f59e0b; color: #fcd34d; }
    .badge-unknown { background: var(--card); border-color: var(--border); color: var(--muted); }

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

    main { display: grid; grid-template-columns: 280px 1fr; flex: 1; min-height: 0; position: relative; }
    @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
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
    select, button, input[type="password"], input[type="text"] {
      width: 100%;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 0.85rem;
    }
    input[type="password"], input[type="text"] {
      margin-top: 6px;
      outline: none;
    }
    input[type="password"]:focus, input[type="text"]:focus {
      border-color: var(--accent);
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
      <span id="stream-badge" class="badge offline">Offline</span>
      <span id="server-badge" class="badge">Checking…</span>
    </div>
  </header>
  <main>
    <div class="banner-container" id="banner-container"></div>
    <aside>
      <div class="panel">
        <h2>Server</h2>
        <div class="stat-grid">
          <div class="stat"><label>Status</label><div class="value" id="stat-status">—</div></div>
          <div class="stat"><label>Version</label><div class="value" id="stat-version">${versionLabel}</div></div>
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
      <div class="panel">
        <h2>Vault backup</h2>
        <button type="button" id="btn-export" disabled>Export vault</button>
        <div class="helper-text" id="export-helper">Select a vault above to export</div>

        <div class="import-section" style="margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border);">
          <input type="file" id="input-import-file" accept=".zip,application/zip" style="display: none;">
          <button type="button" id="btn-choose-file" class="btn-secondary">Choose backup zip…</button>
          <div id="import-filename" class="helper-text" style="display: none; word-break: break-all;"></div>
          <button type="button" id="btn-run-import" class="btn-primary" style="display: none;" disabled>Run import</button>
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

  <script>
    const STORAGE_KEY = "spec-memo-status-project";
    const urlParams = new URLSearchParams(window.location.search);
    const authToken = urlParams.get("token") || "";
    let vaults = [];
    let selectedProject = "";
    let lastSeq = 0;
    let eventSource = null;
    let pauseScroll = false;
    let reconnectTimer = null;
    let selectedImportFile = null;

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
      const h = {};
      if (authToken) h["Authorization"] = "Bearer " + authToken;
      return h;
    }

    function streamUrl() {
      let u = "/api/events/stream?afterSeq=" + lastSeq;
      if (selectedProject) u += "&project=" + encodeURIComponent(selectedProject);
      if (authToken) u += "&token=" + encodeURIComponent(authToken);
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
          '</div>';
        listEl.appendChild(card);
      }
    }

    function renderLogLine(ev) {
      const line = document.createElement("div");
      const kindClass = ev.kind === "write" ? "write" : ev.type === "http" ? "http" : "";
      line.className = "log-line " + kindClass + (ev.ok ? " ok-line" : " error");
      const time = ev.ts ? ev.ts.slice(11, 19) : "";
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
        '<span class="time">' + time + '</span>' +
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

    function escapeHtml(s) {
      return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
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
      const exportBtn = document.getElementById("btn-export");
      const exportHelper = document.getElementById("export-helper");
      if (!selectedProject) {
        el.textContent = "";
        exportBtn.disabled = true;
        exportHelper.textContent = "Select a vault above to export";
        return;
      }
      const dName = displayNameForProject(selectedProject);
      el.textContent = "Showing: " + dName;
      exportBtn.disabled = false;
      exportHelper.textContent = "Exporting: " + dName;
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

    function renderVaultFilter() {
      const sel = document.getElementById("vault-filter");
      sel.innerHTML = '<option value="">All vaults</option>';
      for (const v of vaults) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = v.displayName || v.id;
        if (v.id === selectedProject) opt.selected = true;
        sel.appendChild(opt);
      }
    }

    function setProjectFilter(id, persist) {
      if (id && !vaults.some(v => v.id === id)) id = "";
      selectedProject = id || "";
      if (persist !== false) {
        if (selectedProject) sessionStorage.setItem(STORAGE_KEY, selectedProject);
        else sessionStorage.removeItem(STORAGE_KEY);
      }
      renderVaultFilter();
      renderVaultList();
      updateFilterContext();
      reconnectStream(true);
    }

    function reconnectStream(clearView) {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      if (clearView) {
        document.getElementById("activity-log").innerHTML = "";
        lastSeq = 0;
      }
      setStreamBadge("reconnecting");
      eventSource = new EventSource(streamUrl());
      eventSource.addEventListener("snapshot", (e) => {
        try {
          hydrateEvents(JSON.parse(e.data));
        } catch (_) {}
      });
      eventSource.addEventListener("activity", (e) => {
        try {
          appendEvent(JSON.parse(e.data));
        } catch (_) {}
      });
      eventSource.onopen = () => setStreamBadge("live");
      eventSource.onerror = () => {
        setStreamBadge("reconnecting");
        eventSource.close();
        eventSource = null;
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => reconnectStream(false), 3000);
      };
    }

    async function refreshStatus() {
      try {
        const res = await fetch("/api/status", { headers: apiHeaders() });
        const data = await res.json();
        document.getElementById("stat-status").textContent = data.status || "—";
        if (data.version) {
          document.getElementById("stat-version").textContent = "v" + data.version;
        }
        document.getElementById("stat-vaults").textContent = String(data.projectsCount ?? "—");
        document.getElementById("stat-buffered").textContent = String(data.eventsBuffered ?? "—");
        document.getElementById("stat-uptime").textContent = data.uptimeMs != null ? formatUptime(data.uptimeMs) : "—";
        document.getElementById("stat-clients").textContent = String(data.activeClientsCount ?? (data.clients ? data.clients.filter(c=>c.active).length : "0"));
        const mcp = data.mcp;
        if (mcp && mcp.available) {
          document.getElementById("stat-mcp").textContent = mcp.host + ":" + mcp.port + " (" + mcp.activeTransports + " transports)";
        } else {
          document.getElementById("stat-mcp").textContent = "disconnected";
        }
        if (Array.isArray(data.clients)) {
          renderClients(data.clients);
        }
        const badge = document.getElementById("server-badge");
        badge.textContent = data.status === "ok" ? "Server OK" : "Degraded";
        badge.style.borderColor = data.status === "ok" ? "var(--ok)" : "var(--err)";
        badge.style.color = data.status === "ok" ? "var(--ok)" : "var(--err)";
      } catch (_) {
        document.getElementById("server-badge").textContent = "Unreachable";
      }
    }

    async function loadVaults() {
      const res = await fetch("/api/vaults", { headers: apiHeaders() });
      vaults = await res.json();
      renderVaultFilter();
      renderVaultList();
      let initial = urlParams.get("project") || sessionStorage.getItem(STORAGE_KEY) || "";
      if (initial && vaults.some(v => v.id === initial)) {
        setProjectFilter(initial, false);
      } else {
        updateFilterContext();
      }
    }

    // Export flow
    const modalExport = document.getElementById("modal-export");
    const btnExport = document.getElementById("btn-export");
    const btnExportCancel = document.getElementById("btn-export-cancel");
    const btnExportConfirm = document.getElementById("btn-export-confirm");
    const exportPasswordInput = document.getElementById("export-password");

    btnExport.addEventListener("click", () => {
      if (!selectedProject) return;
      document.getElementById("modal-export-title").textContent = "Export Vault: " + displayNameForProject(selectedProject);
      exportPasswordInput.value = "";
      modalExport.classList.add("open");
      exportPasswordInput.focus();
    });

    btnExportCancel.addEventListener("click", () => {
      modalExport.classList.remove("open");
    });

    btnExportConfirm.addEventListener("click", async () => {
      if (!selectedProject) return;
      btnExportConfirm.disabled = true;
      btnExportConfirm.textContent = "Exporting…";
      const password = exportPasswordInput.value;
      modalExport.classList.remove("open");

      try {
        let exportUrl = "/api/vaults/export";
        if (authToken) exportUrl += "?token=" + encodeURIComponent(authToken);
        const res = await fetch(exportUrl, {
          method: "POST",
          headers: {
            ...apiHeaders(),
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ projectId: selectedProject, password: password || undefined })
        });

        if (!res.ok) {
          let errText = "Export failed (" + res.status + ")";
          try {
            const errJson = await res.json();
            if (errJson.error) errText = errJson.error;
          } catch (_) {}
          showBanner(errText, "error");
          return;
        }

        const blob = await res.blob();
        const contentDisp = res.headers.get("content-disposition") || "";
        let filename = "spec-memo-vault-" + selectedProject + ".zip";
        const fnMatch = contentDisp.match(/filename="?([^";]+)"?/i);
        if (fnMatch && fnMatch[1]) filename = fnMatch[1].trim();

        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
        showBanner("Export successful: downloaded " + filename, "success");
      } catch (err) {
        showBanner("Export failed: " + (err.message || String(err)), "error");
      } finally {
        btnExportConfirm.disabled = false;
        btnExportConfirm.textContent = "Download Backup";
      }
    });

    // Import flow
    const fileInput = document.getElementById("input-import-file");
    const btnChooseFile = document.getElementById("btn-choose-file");
    const filenameDisplay = document.getElementById("import-filename");
    const btnRunImport = document.getElementById("btn-run-import");
    const modalImport = document.getElementById("modal-import");
    const btnImportCancel = document.getElementById("btn-import-cancel");
    const btnImportConfirm = document.getElementById("btn-import-confirm");
    const importPasswordInput = document.getElementById("import-password");

    btnChooseFile.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0]) {
        selectedImportFile = fileInput.files[0];
        filenameDisplay.textContent = "Selected: " + selectedImportFile.name;
        filenameDisplay.style.display = "block";
        btnRunImport.style.display = "block";
        btnRunImport.disabled = false;
      } else {
        selectedImportFile = null;
        filenameDisplay.style.display = "none";
        btnRunImport.style.display = "none";
        btnRunImport.disabled = true;
      }
    });

    btnRunImport.addEventListener("click", () => {
      if (!selectedImportFile) return;
      document.getElementById("modal-import-summary").textContent =
        "Target vault root: local vault (" + vaults.length + " projects)";
      importPasswordInput.value = "";
      modalImport.classList.add("open");
      importPasswordInput.focus();
    });

    btnImportCancel.addEventListener("click", () => {
      modalImport.classList.remove("open");
    });

    btnImportConfirm.addEventListener("click", async () => {
      if (!selectedImportFile) return;
      btnImportConfirm.disabled = true;
      btnImportConfirm.textContent = "Importing…";
      btnRunImport.disabled = true;
      btnRunImport.textContent = "Importing…";
      modalImport.classList.remove("open");

      try {
        const formData = new FormData();
        formData.append("archive", selectedImportFile);
        const pass = importPasswordInput.value;
        if (pass) formData.append("password", pass);

        let importUrl = "/api/vaults/import";
        if (authToken) importUrl += "?token=" + encodeURIComponent(authToken);

        const res = await fetch(importUrl, {
          method: "POST",
          headers: apiHeaders(),
          body: formData
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          const errText = data.error || ("Import failed (" + res.status + ")");
          showBanner(errText, "error");
          return;
        }

        showBanner(
          "Import successful: restored " + data.restoredRecordsCount + " records across " + data.restoredProjectsCount + " project(s)",
          "success"
        );
        fileInput.value = "";
        selectedImportFile = null;
        filenameDisplay.style.display = "none";
        btnRunImport.style.display = "none";
        await loadVaults();
        await refreshStatus();
      } catch (err) {
        showBanner("Import failed: " + (err.message || String(err)), "error");
      } finally {
        btnImportConfirm.disabled = false;
        btnImportConfirm.textContent = "Confirm & Restore";
        btnRunImport.disabled = false;
        btnRunImport.textContent = "Run import";
      }
    });

    document.getElementById("vault-filter").addEventListener("change", (e) => {
      setProjectFilter(e.target.value);
    });
    document.getElementById("btn-pause").addEventListener("click", () => {
      pauseScroll = !pauseScroll;
      document.getElementById("btn-pause").textContent = pauseScroll ? "Resume scroll" : "Pause scroll";
    });
    document.getElementById("btn-clear").addEventListener("click", () => {
      document.getElementById("activity-log").innerHTML = "";
    });

    loadVaults().then(() => {
      reconnectStream(true);
      refreshStatus();
      setInterval(refreshStatus, 3000);
    });
  </script>
</body>
</html>`;
}

export function startStatusServer(options: StatusServerOptions): Promise<StatusServerInstance> {
  const port = options.port ?? 3001;
  const host = options.host || "127.0.0.1";
  const vaultRoot = getVaultRoot(options.vaultRoot);
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
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && pathname === "/api/status") {
        const projects = getVaultProjectList(vaultRoot);
        const mcp = options.getMcp?.();
        const clients = bus.listClients();
        writeJson(res, 200, {
          status: "ok",
          service: "spec-memo-status-monitor",
          version: packageVersion,
          host,
          port: (server.address() as { port: number } | null)?.port ?? port,
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

      if (req.method === "POST" && pathname === "/api/vaults/export") {
        const startTime = Date.now();
        let targetProjectId = "";
        try {
          const rawBody = await readBodyBuffer(req, 1024 * 1024);
          let parsed: { projectId?: string; password?: string } = {};
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
          if (!targetProjectId || typeof targetProjectId !== "string") {
            logErrorReport({
              subsystem: "status-server",
              port,
              host,
              method: "POST",
              endpoint: "/api/vaults/export",
              error: `Unknown projectId (missing or not a string)`
            }, { vaultRoot, logPath: errorLogPath });
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
          const now = new Date();
          const pad = (n: number) => String(n).padStart(2, "0");
          const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
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
