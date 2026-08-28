import http from "node:http";
import { getVaultRoot, getProjectMetadata } from "./vault.js";
import { getVaultProjectList } from "./canvas.js";
import { ActivityBus, ActivityEvent, eventMatchesProjectFilter } from "./activity.js";
import { getPackageVersion } from "./version.js";
import { exportVault, importVault } from "./backup.js";
import { packVaultZip, unpackVaultZip, parseMultipartFormData } from "./status-backup.js";
import { logErrorReport } from "./error-logger.js";
import { recordTelemetry } from "./telemetry.js";
import { getRecord } from "./store.js";
import { sanitizeToolOutput } from "./safety.js";
import { scheduleHybridPush } from "./hybrid-sync.js";
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
  const lines = html.split(/\n/);
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
      <span id="stream-badge" class="badge offline">Offline</span>
      <span id="server-badge" class="badge">Checking…</span>
    </div>
  </header>

  <nav class="nav-tabs">
    <button class="tab-btn active" data-tab="tab-activity">Activity & Status</button>
    <button class="tab-btn" data-tab="tab-prompts">Prompts & Intent Stories</button>
    <button class="tab-btn" data-tab="tab-invoicing">Activity & Invoicing</button>
    <button class="tab-btn" data-tab="tab-rules">Derived Rules</button>
  </nav>

  <div class="banner-container" id="banner-container"></div>

  <!-- TAB 1: Activity & Status -->
  <main id="tab-activity" class="tab-content active">
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
      const exportBtn = document.getElementById("btn-export");
      const exportHelper = document.getElementById("export-helper");
      if (!selectedProject) {
        el.textContent = "";
        if(exportBtn) exportBtn.disabled = true;
        if(exportHelper) exportHelper.textContent = "Select a vault above to export";
        return;
      }
      const dName = displayNameForProject(selectedProject);
      el.textContent = "Showing: " + dName;
      if(exportBtn) exportBtn.disabled = false;
      if(exportHelper) exportHelper.textContent = "Exporting: " + dName;
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
        document.getElementById("invoicing-vault-select"),
        document.getElementById("rules-vault-select")
      ];
      for (const sel of selectors) {
        if (!sel) continue;
        const currentVal = sel.value;
        sel.innerHTML = '<option value="">All vaults</option>';
        for (const v of vaults) {
          const opt = document.createElement("option");
          opt.value = v.id;
          opt.textContent = v.displayName || v.id;
          if (v.id === currentVal) opt.selected = true;
          sel.appendChild(opt);
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
      const es = new EventSource(streamUrl());
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
        const res = await fetch("/api/vaults" + (authToken ? "?token=" + encodeURIComponent(authToken) : ""), {
          headers: apiHeaders()
        });
        if (!res.ok) return;
        const data = await res.json();
        vaults = data.vaults || [];
        populateVaultSelectors();
        renderVaultList();
        updateFilterContext();
      } catch {}
    }

    async function refreshStatus() {
      try {
        const res = await fetch("/api/status" + (authToken ? "?token=" + encodeURIComponent(authToken) : ""), {
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
      } catch {
        document.getElementById("server-badge").textContent = "Offline";
        document.getElementById("server-badge").className = "badge offline";
      }
    }

    // Tab Switching
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
        btn.classList.add("active");
        const targetId = btn.getAttribute("data-tab");
        const targetTab = document.getElementById(targetId);
        if (targetTab) targetTab.classList.add("active");

        if (targetId === "tab-prompts") {
          loadPrompts();
        } else if (targetId === "tab-invoicing") {
          loadActivityReport();
        }
      });
    });

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
      if (authToken) params.set("token", authToken);

      try {
        const res = await fetch("/api/prompts?" + params.toString(), { headers: apiHeaders() });
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
          const snippet = p.body.replace(/\n+/g, ' ').slice(0, 75);

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
        if (authToken) params.set("token", authToken);
        const res = await fetch("/api/prompts/" + encodeURIComponent(fm.id) + "?" + params.toString(), { headers: apiHeaders() });
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
      let exportUrl = "/api/prompts/sessions/" + encodeURIComponent(sessId) + "/export";
      if (authToken) exportUrl += "?token=" + encodeURIComponent(authToken);
      window.open(exportUrl, "_blank");
    });

    document.getElementById("btn-drawer-derive").addEventListener("click", async () => {
      if (!activePromptRecord) return;
      const btn = document.getElementById("btn-drawer-derive");
      btn.disabled = true;
      btn.textContent = "Deriving…";
      try {
        const res = await fetch("/api/prompts/derive-rules", {
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
      if (authToken) params.set("token", authToken);

      try {
        const res = await fetch("/api/activity?" + params.toString(), { headers: apiHeaders() });
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
        const res = await fetch("/api/prompts/derive-rules", {
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
        const res = await fetch("/api/prompts/derive-rules", {
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

    // Vault Backup / Import Modals & Events
    const modalExport = document.getElementById("modal-export");
    const exportPasswordInput = document.getElementById("export-password");
    const btnExport = document.getElementById("btn-export");
    const btnExportCancel = document.getElementById("btn-export-cancel");
    const btnExportConfirm = document.getElementById("btn-export-confirm");

    btnExport.addEventListener("click", () => {
      if (!selectedProject) return;
      document.getElementById("modal-export-title").textContent = "Export " + displayNameForProject(selectedProject);
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
      modalExport.classList.remove("open");

      try {
        const payload = {
          projectId: selectedProject,
          password: exportPasswordInput.value || undefined
        };

        let exportUrl = "/api/vaults/export";
        if (authToken) exportUrl += "?token=" + encodeURIComponent(authToken);

        const res = await fetch(exportUrl, {
          method: "POST",
          headers: {
            ...apiHeaders(),
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          showBanner(errData.error || ("Export failed (" + res.status + ")"), "error");
          return;
        }

        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.style.display = "none";
        a.href = url;
        const disp = res.headers.get("content-disposition");
        let fname = "spec-memo-vault-" + selectedProject + ".zip";
        if (disp && disp.includes("filename=")) {
          const match = disp.match(/filename="?([^"]+)"?/);
          if (match && match[1]) fname = match[1];
        }
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove();
        showBanner("Export completed: downloaded " + fname, "success");
      } catch (err) {
        showBanner("Export failed: " + (err.message || String(err)), "error");
      } finally {
        btnExportConfirm.disabled = false;
        btnExportConfirm.textContent = "Download Backup";
      }
    });

    const fileInput = document.getElementById("input-import-file");
    const btnChooseFile = document.getElementById("btn-choose-file");
    const filenameDisplay = document.getElementById("import-filename");
    const btnRunImport = document.getElementById("btn-run-import");
    const modalImport = document.getElementById("modal-import");
    const importPasswordInput = document.getElementById("import-password");
    const btnImportCancel = document.getElementById("btn-import-cancel");
    const btnImportConfirm = document.getElementById("btn-import-confirm");

    btnChooseFile.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0]) {
        selectedImportFile = fileInput.files[0];
        filenameDisplay.textContent = selectedImportFile.name + " (" + Math.round(selectedImportFile.size / 1024) + " KB)";
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
        const story = await exportSessionStory({
          sessionId,
          vaultRoot,
          projectId: project && project !== "all" ? project : undefined
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
        const turns = getSessionTurns({
          sessionId,
          vaultRoot,
          projectId: project && project !== "all" ? project : undefined
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
        const record =
          (await getRecord({ id, kind: "prompt", vaultRoot, projectId: project && project !== "all" ? project : undefined })) ||
          (await getRecord({ id, kind: "session", vaultRoot, projectId: project && project !== "all" ? project : undefined }));
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
        writeJson(res, 200, result);
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
