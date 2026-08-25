import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { getVaultRoot, RECORD_SUBDIRS, getProjectMetadata } from "./vault.js";
import { getRecord } from "./store.js";
import { parseRecord } from "./schema.js";
import { searchIndex } from "./indexer.js";
import { sanitizeToolOutput, isPathInside } from "./safety.js";
import { MemoRecord, RecordKind, RecordStatus } from "./types.js";

export interface GraphNode {
  id: string;
  kind: RecordKind;
  slug?: string;
  title: string;
  status: RecordStatus;
  severity?: string;
  updated: string;
  project: string;
  pathPatterns?: string[];
  tags?: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: "supersedes" | "related" | "links" | "shares-tag";
}

export interface ProjectGraph {
  projectId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function listProjectRecordsInternal(vaultRoot: string, projectId: string): MemoRecord[] {
  const projectsDir = path.resolve(vaultRoot, "projects");
  const projPath = path.resolve(projectsDir, projectId);
  const records: MemoRecord[] = [];
  if (!isPathInside(projPath, projectsDir)) return records;
  if (!fs.existsSync(projPath)) return records;

  for (const dirName of RECORD_SUBDIRS) {
    const subDir = path.join(projPath, dirName);
    if (fs.existsSync(subDir)) {
      const files = fs.readdirSync(subDir);
      for (const file of files) {
        if (file.endsWith(".md") && !file.includes(".conflict.")) {
          try {
            const content = fs.readFileSync(path.join(subDir, file), "utf8");
            const parsed = parseRecord(content);
            records.push(parsed);
          } catch {
            // Ignore malformed files
          }
        }
      }
    }
  }

  return records;
}

export function getVaultProjectList(vaultRoot: string): Array<{ id: string; displayName?: string }> {
  const projectsDir = path.join(vaultRoot, "projects");
  const list: Array<{ id: string; displayName?: string }> = [];
  if (!fs.existsSync(projectsDir)) return list;

  const entries = fs.readdirSync(projectsDir);
  for (const entry of entries) {
    const projPath = path.join(projectsDir, entry);
    if (fs.statSync(projPath).isDirectory()) {
      const meta = getProjectMetadata(entry, vaultRoot);
      list.push({
        id: entry,
        displayName: meta?.displayName || entry
      });
    }
  }
  return list;
}

export function generateProjectGraph(vaultRoot: string, projectId: string): ProjectGraph {
  const projectsDir = path.resolve(vaultRoot, "projects");
  const projPath = path.resolve(projectsDir, projectId);
  if (!isPathInside(projPath, projectsDir)) {
    return { projectId, nodes: [], edges: [] };
  }
  const records = listProjectRecordsInternal(vaultRoot, projectId);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const idMap = new Set<string>();
  const slugMap = new Map<string, string>();

  for (const rec of records) {
    const recId = String(rec.frontmatter.id);
    idMap.add(recId);
    if (rec.frontmatter.slug) {
      slugMap.set(String(rec.frontmatter.slug), recId);
    }

    const titleStr = String(
      rec.frontmatter.title ||
      rec.body.split("\n").find((l: string) => l.startsWith("# "))?.replace("# ", "").trim() ||
      rec.frontmatter.slug ||
      recId
    );

    nodes.push({
      id: recId,
      kind: rec.frontmatter.kind,
      slug: rec.frontmatter.slug ? String(rec.frontmatter.slug) : undefined,
      title: titleStr,
      status: rec.frontmatter.status,
      severity: rec.frontmatter.severity ? String(rec.frontmatter.severity) : undefined,
      updated: String(rec.frontmatter.updated),
      project: String(rec.frontmatter.project),
      pathPatterns: rec.frontmatter.pathPatterns,
      tags: rec.frontmatter.tags
    });
  }

  for (const rec of records) {
    const srcId = String(rec.frontmatter.id);
    if (rec.frontmatter.supersedes) {
      edges.push({
        source: srcId,
        target: String(rec.frontmatter.supersedes),
        relation: "supersedes"
      });
    }

    if (rec.frontmatter.relatedSlug && slugMap.has(String(rec.frontmatter.relatedSlug))) {
      const targetId = slugMap.get(String(rec.frontmatter.relatedSlug))!;
      if (targetId !== srcId) {
        edges.push({
          source: srcId,
          target: targetId,
          relation: "related"
        });
      }
    }
  }

  return { projectId, nodes, edges };
}

export function generateCanvasHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>spec-memo — Visual Graph Canvas</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-bright: #f0f6fc;
      --accent: #58a6ff;
      --trap: #f85149;
      --decision: #a371f7;
      --spec: #3fb950;
      --plan: #d29922;
      --log: #8b949e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    #sidebar {
      width: 320px;
      background: var(--card-bg);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      padding: 16px;
      gap: 14px;
      z-index: 10;
    }
    #sidebar h1 { font-size: 1.1rem; color: var(--text-bright); display: flex; align-items: center; gap: 8px; }
    .badge { font-size: 0.75rem; padding: 2px 6px; border-radius: 12px; background: #21262d; border: 1px solid var(--border); }
    select, input {
      width: 100%;
      background: #0d1117;
      border: 1px solid var(--border);
      color: var(--text-bright);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 0.9rem;
      outline: none;
    }
    select:focus, input:focus { border-color: var(--accent); }
    .legend {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      font-size: 0.8rem;
    }
    .legend-item { display: flex; align-items: center; gap: 6px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot-trap { background: var(--trap); }
    .dot-decision { background: var(--decision); }
    .dot-spec { background: var(--spec); }
    .dot-plan { background: var(--plan); }
    .dot-log { background: var(--log); }
    #stats { font-size: 0.85rem; color: #8b949e; border-top: 1px solid var(--border); padding-top: 12px; }
    #canvas-container {
      flex: 1;
      position: relative;
      background: radial-gradient(circle, #1f242c 1px, transparent 1px);
      background-size: 24px 24px;
      overflow: hidden;
      cursor: grab;
    }
    #canvas-container:active { cursor: grabbing; }
    svg#graph-canvas {
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
    }
    .node-group { cursor: pointer; transition: transform 0.15s ease; }
    .node-group:hover { filter: brightness(1.25); }
    .node-rect { stroke-width: 1.5; rx: 8; ry: 8; fill: #161b22; }
    .node-label { font-size: 12px; fill: #f0f6fc; font-weight: 500; }
    .node-kind { font-size: 10px; fill: #8b949e; text-transform: uppercase; }
    .edge-line { stroke: #30363d; stroke-width: 1.5; stroke-dasharray: 4 2; }
    #detail-drawer {
      width: 380px;
      background: var(--card-bg);
      border-left: 1px solid var(--border);
      padding: 16px;
      display: none;
      flex-direction: column;
      gap: 12px;
      overflow-y: auto;
      z-index: 10;
    }
    #detail-drawer.open { display: flex; }
    .close-btn { align-self: flex-end; background: transparent; border: none; color: #8b949e; cursor: pointer; font-size: 1.2rem; }
    .close-btn:hover { color: var(--text-bright); }
    pre.code-body {
      background: #0d1117;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--border);
      font-family: monospace;
      font-size: 0.8rem;
      white-space: pre-wrap;
      max-height: 400px;
      overflow-y: auto;
    }
  </style>
</head>
<body>
  <div id="sidebar">
    <h1>spec-memo <span class="badge">Canvas</span></h1>
    <div>
      <label style="font-size: 0.8rem; color: #8b949e; margin-bottom: 4px; display: block;">Active Project</label>
      <select id="project-select"></select>
    </div>
    <div>
      <label style="font-size: 0.8rem; color: #8b949e; margin-bottom: 4px; display: block;">Search Vault</label>
      <input type="text" id="search-input" placeholder="Filter nodes...">
    </div>
    <div class="legend">
      <div class="legend-item"><span class="dot dot-trap"></span> Trap</div>
      <div class="legend-item"><span class="dot dot-decision"></span> Decision</div>
      <div class="legend-item"><span class="dot dot-spec"></span> Spec</div>
      <div class="legend-item"><span class="dot dot-plan"></span> Plan</div>
      <div class="legend-item"><span class="dot dot-log"></span> Log/Review</div>
    </div>
    <div id="stats">Loading topology...</div>
  </div>

  <div id="canvas-container">
    <svg id="graph-canvas">
      <g id="viewport">
        <g id="edges-layer"></g>
        <g id="nodes-layer"></g>
      </g>
    </svg>
  </div>

  <div id="detail-drawer">
    <button class="close-btn" id="close-drawer">&times;</button>
    <h2 id="detail-title" style="font-size: 1.1rem; color: var(--text-bright);"></h2>
    <div id="detail-meta" style="font-size: 0.8rem; color: #8b949e;"></div>
    <pre class="code-body" id="detail-body"></pre>
  </div>

  <script>
    let currentProject = "";
    let graphData = { nodes: [], edges: [] };
    let pan = { x: 50, y: 50 };
    let zoom = 1;
    let isDragging = false;
    let startPos = { x: 0, y: 0 };

    const pageToken = new URLSearchParams(window.location.search).get('token');
    const apiHeaders = pageToken ? { Authorization: 'Bearer ' + pageToken } : {};

    const kindColors = {
      trap: "#f85149",
      decision: "#a371f7",
      spec: "#3fb950",
      plan: "#d29922",
      state: "#d29922",
      log: "#8b949e",
      review: "#58a6ff",
      scratch: "#6e7681"
    };

    async function init() {
      const res = await fetch("/api/projects", { headers: apiHeaders });
      const projects = await res.json();
      const select = document.getElementById("project-select");
      select.innerHTML = projects.map(p => \`<option value="\${p.id}">\${p.id} (\${p.displayName || "vault"})\`\).join("");
      
      if (projects.length > 0) {
        currentProject = projects[0].id;
        loadGraph(currentProject);
      }
      
      select.addEventListener("change", (e) => {
        currentProject = e.target.value;
        loadGraph(currentProject);
      });

      document.getElementById("search-input").addEventListener("input", filterNodes);
      document.getElementById("close-drawer").addEventListener("click", () => {
        document.getElementById("detail-drawer").classList.remove("open");
      });

      setupPanZoom();
    }

    async function loadGraph(projectId) {
      const res = await fetch(\`/api/project/\${projectId}/graph\`, { headers: apiHeaders });
      graphData = await res.json();
      document.getElementById("stats").textContent = \`\${graphData.nodes.length} nodes · \${graphData.edges.length} connections\`;
      renderGraph();
    }

    function renderGraph() {
      const nodesLayer = document.getElementById("nodes-layer");
      const edgesLayer = document.getElementById("edges-layer");
      nodesLayer.innerHTML = "";
      edgesLayer.innerHTML = "";

      const cols = Math.max(3, Math.ceil(Math.sqrt(graphData.nodes.length)));
      const spacingX = 220;
      const spacingY = 120;
      const positions = new Map();

      graphData.nodes.forEach((n, idx) => {
        const x = (idx % cols) * spacingX + 40;
        const y = Math.floor(idx / cols) * spacingY + 40;
        positions.set(n.id, { x, y });
      });

      graphData.edges.forEach(e => {
        const src = positions.get(e.source);
        const tgt = positions.get(e.target);
        if (src && tgt) {
          const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("x1", src.x + 90);
          line.setAttribute("y1", src.y + 30);
          line.setAttribute("x2", tgt.x + 90);
          line.setAttribute("y2", tgt.y + 30);
          line.setAttribute("class", "edge-line");
          edgesLayer.appendChild(line);
        }
      });

      graphData.nodes.forEach((n) => {
        const pos = positions.get(n.id);
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("class", "node-group");
        g.setAttribute("transform", \`translate(\${pos.x}, \${pos.y})\`);
        g.setAttribute("data-id", n.id);

        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("width", "180");
        rect.setAttribute("height", "60");
        rect.setAttribute("class", "node-rect");
        rect.setAttribute("stroke", kindColors[n.kind] || "#30363d");

        const kindText = document.createElementNS("http://www.w3.org/2000/svg", "text");
        kindText.setAttribute("x", "10");
        kindText.setAttribute("y", "18");
        kindText.setAttribute("class", "node-kind");
        kindText.textContent = n.kind + (n.severity ? " · " + n.severity : "");

        const labelText = document.createElementNS("http://www.w3.org/2000/svg", "text");
        labelText.setAttribute("x", "10");
        labelText.setAttribute("y", "38");
        labelText.setAttribute("class", "node-label");
        const titleStr = n.title.length > 20 ? n.title.substring(0, 18) + "..." : n.title;
        labelText.textContent = titleStr;

        g.appendChild(rect);
        g.appendChild(kindText);
        g.appendChild(labelText);
        g.addEventListener("click", () => openDetail(n));
        nodesLayer.appendChild(g);
      });

      updateTransform();
    }

    function filterNodes(e) {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll(".node-group").forEach(el => {
        const id = el.getAttribute("data-id");
        const node = graphData.nodes.find(n => n.id === id);
        if (!node || node.title.toLowerCase().includes(q) || node.kind.toLowerCase().includes(q) || (node.slug && node.slug.toLowerCase().includes(q))) {
          el.style.opacity = "1";
        } else {
          el.style.opacity = "0.15";
        }
      });
    }

    async function openDetail(node) {
      const drawer = document.getElementById("detail-drawer");
      document.getElementById("detail-title").textContent = node.title;
      document.getElementById("detail-meta").textContent = \`ID: \${node.id} | Kind: \${node.kind} | Status: \${node.status}\`;
      drawer.classList.add("open");

      try {
        const res = await fetch(\`/api/record/\${currentProject}/\${node.kind}/\${node.id}\`, { headers: apiHeaders });
        const data = await res.json();
        document.getElementById("detail-body").textContent = data.record ? data.record.body : "No content body";
      } catch (err) {
        document.getElementById("detail-body").textContent = "Failed to load record content.";
      }
    }

    function setupPanZoom() {
      const container = document.getElementById("canvas-container");
      container.addEventListener("mousedown", (e) => {
        if (e.target.tagName === "svg" || e.target.id === "viewport") {
          isDragging = true;
          startPos = { x: e.clientX - pan.x, y: e.clientY - pan.y };
        }
      });
      window.addEventListener("mousemove", (e) => {
        if (isDragging) {
          pan.x = e.clientX - startPos.x;
          pan.y = e.clientY - startPos.y;
          updateTransform();
        }
      });
      window.addEventListener("mouseup", () => isDragging = false);
      container.addEventListener("wheel", (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        zoom = Math.min(Math.max(0.3, zoom * factor), 3.0);
        updateTransform();
      });
    }

    function updateTransform() {
      document.getElementById("viewport").setAttribute("transform", \`translate(\${pan.x}, \${pan.y}) scale(\${zoom})\`);
    }

    init();
  </script>
</body>
</html>`;
}

export interface CanvasServerOptions {
  vaultRoot?: string;
  port?: number;
  host?: string;
  project?: string;
  authToken?: string;
}

export interface CanvasServerInstance {
  server: http.Server;
  port: number;
  host: string;
  url: string;
  close: () => Promise<void>;
}

export function startCanvasServer(options: CanvasServerOptions = {}): Promise<CanvasServerInstance> {
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const host = options.host || "127.0.0.1";
  const port = options.port ?? 4100;
  const authToken = options.authToken || process.env.SPEC_MEMO_AUTH_TOKEN || process.env.SPEC_MEMO_CANVAS_TOKEN;

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !authToken) {
    throw new Error("Refusing to bind Canvas server to a non-loopback host without authentication token (--auth-token or SPEC_MEMO_AUTH_TOKEN).");
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const pathname = url.pathname;

      if (authToken) {
        const authHeader = req.headers.authorization;
        const queryToken = url.searchParams.get("token");
        const authorized = authHeader === `Bearer ${authToken}` || queryToken === authToken;
        if (!authorized) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }

      if (pathname === "/" || pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(generateCanvasHtml());
        return;
      }

      if (pathname === "/api/projects") {
        const projects = getVaultProjectList(vaultRoot);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(projects));
        return;
      }

      const graphMatch = pathname.match(/^\/api\/project\/([^\/]+)\/graph$/);
      if (graphMatch) {
        const projId = decodeURIComponent(graphMatch[1]);
        const graph = generateProjectGraph(vaultRoot, projId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(graph));
        return;
      }

      const recordMatch = pathname.match(/^\/api\/record\/([^\/]+)\/([^\/]+)\/([^\/]+)$/);
      if (recordMatch) {
        const projId = decodeURIComponent(recordMatch[1]);
        const kind = decodeURIComponent(recordMatch[2]) as RecordKind;
        const id = decodeURIComponent(recordMatch[3]);
        const record = await getRecord({ vaultRoot, projectId: projId, kind, id });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sanitizeToolOutput({ record })));
        return;
      }

      if (pathname === "/api/search") {
        const query = url.searchParams.get("q") || "";
        const projId = url.searchParams.get("project") || options.project;
        const results = searchIndex({ query, projectId: projId || undefined, vaultRoot });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(sanitizeToolOutput(results)));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    server.on("error", reject);

    server.listen(port, host, () => {
      const actualPort = (server.address() as any).port;
      const serverUrl = `http://${host}:${actualPort}`;
      resolve({
        server,
        port: actualPort,
        host,
        url: serverUrl,
        close: () => new Promise<void>((res) => server.close(() => res()))
      });
    });
  });
}
