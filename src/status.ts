import http from "node:http";
import { getVaultRoot } from "./vault.js";
import { getVaultProjectList } from "./canvas.js";
import { ActivityBus, ActivityEvent, eventMatchesProjectFilter } from "./activity.js";

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

export function generateStatusHtml(): string {
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
    main { display: grid; grid-template-columns: 280px 1fr; flex: 1; min-height: 0; }
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
    select, button {
      width: 100%;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 0.85rem;
    }
    button { cursor: pointer; margin-top: 6px; }
    button:hover { border-color: var(--accent); color: var(--bright); }
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
      grid-template-columns: 72px 56px 48px 1fr;
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
  </style>
</head>
<body>
  <header>
    <h1>spec-memo <span>Status Monitor</span></h1>
    <div class="badges">
      <span id="stream-badge" class="badge offline">Offline</span>
      <span id="server-badge" class="badge">Checking…</span>
    </div>
  </header>
  <main>
    <aside>
      <div class="panel">
        <h2>Server</h2>
        <div class="stat-grid">
          <div class="stat"><label>Status</label><div class="value" id="stat-status">—</div></div>
          <div class="stat"><label>MCP SSE</label><div class="value" id="stat-mcp">—</div></div>
          <div class="stat"><label>Vaults</label><div class="value" id="stat-vaults">—</div></div>
          <div class="stat"><label>Uptime</label><div class="value" id="stat-uptime">—</div></div>
          <div class="stat"><label>Buffered events</label><div class="value" id="stat-buffered">—</div></div>
        </div>
      </div>
      <div class="panel">
        <h2>Vault filter</h2>
        <select id="vault-filter"><option value="">All vaults</option></select>
        <div class="filter-context" id="filter-context"></div>
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

    function renderLogLine(ev) {
      const line = document.createElement("div");
      const kindClass = ev.kind === "write" ? "write" : ev.type === "http" ? "http" : "";
      line.className = "log-line " + kindClass + (ev.ok ? " ok-line" : " error");
      const time = ev.ts ? ev.ts.slice(11, 19) : "";
      const kind = ev.kind || ev.type;
      const detail = ev.tool
        ? ev.tool
        : (ev.method && ev.path ? ev.method + " " + ev.path : ev.type);
      const proj = ev.projectId && !selectedProject
        ? displayNameForProject(ev.projectId)
        : "";
      line.innerHTML =
        '<span class="time">' + time + '</span>' +
        '<span class="kind-tag">' + kind + '</span>' +
        '<span class="ok-tag">' + (ev.ok ? "ok" : "err") + '</span>' +
        '<div><div class="log-summary">' + escapeHtml(ev.summary || "") + '</div>' +
        '<div class="log-meta">' + escapeHtml(detail) +
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
      if (!selectedProject) {
        el.textContent = "";
        return;
      }
      el.textContent = "Showing: " + displayNameForProject(selectedProject);
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
        document.getElementById("stat-vaults").textContent = String(data.projectsCount ?? "—");
        document.getElementById("stat-buffered").textContent = String(data.eventsBuffered ?? "—");
        document.getElementById("stat-uptime").textContent = data.uptimeMs != null ? formatUptime(data.uptimeMs) : "—";
        const mcp = data.mcp;
        if (mcp && mcp.available) {
          document.getElementById("stat-mcp").textContent = mcp.host + ":" + mcp.port + " (" + mcp.activeTransports + " transports)";
        } else {
          document.getElementById("stat-mcp").textContent = "disconnected";
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
      setInterval(refreshStatus, 5000);
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
    process.env.SPEC_MEMO_STATUS_TOKEN;
  const bus = options.activityBus;

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !authToken) {
    throw new Error(
      "Refusing to bind status monitor to a non-loopback host without authentication token (--auth-token or SPEC_MEMO_AUTH_TOKEN / SPEC_MEMO_STATUS_TOKEN)."
    );
  }

  const html = generateStatusHtml();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const pathname = url.pathname;

      setCorsHeaders(res);

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (pathname.startsWith("/api/")) {
        if (!isAuthorized(req, url, authToken)) {
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
        writeJson(res, 200, {
          status: "ok",
          service: "spec-memo-status-monitor",
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
          eventsBuffered: bus.list().length
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/vaults") {
        writeJson(res, 200, getVaultProjectList(vaultRoot));
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
            } catch {
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

      writeJson(res, 404, { error: "Not found" });
    });

    server.on("error", reject);

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
            server.close(() => res());
          })
      });
    });
  });
}
