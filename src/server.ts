import http from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./mcp.js";
import { getVaultRoot, withVaultLockSync } from "./vault.js";
import { getVaultProjectList } from "./canvas.js";
import { ActivityBus, createActivityBus } from "./activity.js";
import { startStatusServer, StatusServerInstance } from "./status.js";
import { exportChangeset, applyChangeset } from "./sync.js";
import { ClientType } from "./types.js";
import { logErrorReport } from "./error-logger.js";
import { recordTelemetry, flushTelemetrySync, closeTelemetry } from "./telemetry.js";

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export interface SseServerOptions {
  port?: number;
  host?: string;
  vaultRoot?: string;
  authToken?: string;
  statusPort?: number;
  statusHost?: string;
  statusAuthToken?: string;
  enableStatus?: boolean;
  activityBus?: ActivityBus;
  errorLogPath?: string;
}

export interface SseServerInstance {
  server: http.Server;
  port: number;
  host: string;
  url: string;
  statusUrl?: string;
  statusPort?: number;
  activityBus: ActivityBus;
  close: () => Promise<void>;
}

export function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "127.0.0.1";
}

export function parseClientInfo(
  req: http.IncomingMessage,
  pathname?: string
): { clientName: string; clientType: ClientType } {
  const customClient = (req.headers["x-spec-memo-client"] || req.headers["x-client-name"]) as string | undefined;
  const modeHeader = req.headers["x-spec-memo-mode"] as string | undefined;
  const rawUa = (req.headers["user-agent"] || "").trim();
  const ua = rawUa.toLowerCase();

  if (customClient) {
    const isProxy = modeHeader === "remote" || customClient.includes("proxy");
    return {
      clientName: customClient,
      clientType: isProxy ? "proxy" : modeHeader === "hybrid" ? "cli" : "direct-remote"
    };
  }

  if (ua.includes("spec-memo-remote-proxy") || ua.includes("proxy")) {
    return { clientName: "spec-memo-remote-proxy", clientType: "proxy" };
  }
  if (ua.includes("spec-memo-hybrid-sync") || ua.includes("hybrid-sync")) {
    return { clientName: "spec-memo-hybrid-sync", clientType: "cli" };
  }
  if (ua.includes("cursor")) {
    return { clientName: "Cursor IDE", clientType: "direct-remote" };
  }
  if (ua.includes("claude")) {
    return { clientName: "Claude Desktop", clientType: "direct-remote" };
  }
  if (ua.includes("antigravity")) {
    return { clientName: "Antigravity IDE", clientType: "direct-remote" };
  }
  if (ua.includes("vscode")) {
    return { clientName: "VS Code", clientType: "direct-remote" };
  }
  if (ua.includes("mozilla") || ua.includes("chrome") || ua.includes("safari")) {
    return { clientName: "Web Browser", clientType: "web" };
  }
  if (
    ua.includes("curl") ||
    ua.includes("postman") ||
    ua.includes("insomnia") ||
    ua.includes("node-fetch") ||
    ua.includes("undici")
  ) {
    return { clientName: rawUa.split("/")[0] || "CLI/HTTP", clientType: "cli" };
  }
  return { clientName: rawUa ? rawUa.slice(0, 50) : "MCP Client", clientType: "direct-remote" };
}

export function resolveRequestOperation(method: string, pathname: string): string {
  if (pathname === "/health") return "health_check";
  if (pathname === "/sse" || pathname === "/") return "sse_connect";
  if (pathname === "/message") return "mcp_message";
  if (pathname === "/api/sync/pull") return "sync_pull";
  if (pathname === "/api/sync/push") return "sync_push";
  if (pathname === "/api/sync") return "sync_bidirectional";
  if (pathname.startsWith("/api/vaults/export")) return "vault_export";
  if (pathname.startsWith("/api/vaults/import")) return "vault_import";
  if (pathname.startsWith("/api/")) return "status_api";
  return `${method} ${pathname}`;
}

function captureHttpEvent(
  bus: ActivityBus,
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
  clientIp?: string,
  clientName?: string,
  clientType?: ClientType,
  operation?: string,
  projectId?: string
): void {
  const opLabel = operation || `${method} ${path}`;
  const clientLabel = clientName ? ` [${clientName}]` : "";
  bus.capture({
    type: "http",
    kind: "meta",
    ok: statusCode < 400,
    durationMs,
    summary: `${method} ${path} ${statusCode}${clientLabel}`,
    method,
    path,
    statusCode,
    clientIp,
    clientName,
    clientType,
    operation: opLabel,
    projectId
  });
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
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, mcp-session-id, X-Requested-With");
  res.setHeader("Access-Control-Expose-Headers", "*");
}

export function startSseServer(options: SseServerOptions = {}): Promise<SseServerInstance> {
  const port = options.port ?? 3000;
  const host = options.host || "127.0.0.1";
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const authToken = options.authToken || process.env.SPEC_MEMO_AUTH_TOKEN || process.env.SPEC_MEMO_SSE_TOKEN;
  const enableStatus = options.enableStatus !== false;
  const bus = options.activityBus ?? createActivityBus({ capacity: 200 });
  const errorLogPath = options.errorLogPath;

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !authToken) {
    const err = new Error("Refusing to bind SSE MCP server to a non-loopback host without authentication token (--auth-token or SPEC_MEMO_SSE_TOKEN).");
    logErrorReport({
      subsystem: "sse-server",
      port,
      host,
      error: err,
      level: "FATAL"
    }, { vaultRoot, logPath: errorLogPath });
    throw err;
  }

  const transports = new Map<string, SSEServerTransport>();
  let statusInstance: StatusServerInstance | undefined;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const started = Date.now();
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const pathname = url.pathname;
      const method = req.method || "GET";
      const clientIp = getClientIp(req);
      const { clientName, clientType } = parseClientInfo(req, pathname);
      const defaultOp = resolveRequestOperation(method, pathname);
      let capturedOp: string = defaultOp;
      let targetProjectId: string | undefined =
        url.searchParams.get("project") || (req.headers["x-project-id"] as string) || undefined;

      setCorsHeaders(res);

      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const finishCapture = (statusCode: number) => {
        const duration = Date.now() - started;
        captureHttpEvent(
          bus,
          method,
          pathname,
          statusCode,
          duration,
          clientIp,
          clientName,
          clientType,
          capturedOp,
          targetProjectId
        );
        recordTelemetry({
          category: 'http_endpoint',
          operation: `${method} ${pathname}`,
          durationMs: duration,
          success: statusCode < 400,
          errorCode: statusCode >= 400 ? `HTTP_${statusCode}` : undefined,
          projectId: targetProjectId,
          vaultRoot,
          metadata: {
            method,
            path: pathname,
            statusCode,
            clientIp,
            clientName,
            clientType,
            operation: capturedOp
          }
        });
      };

      res.on("finish", () => {
        finishCapture(res.statusCode || 500);
      });

      if (!isAuthorized(req, url, authToken)) {
        capturedOp = "unauthorized_access";
        logErrorReport({
          subsystem: "sse-server",
          port,
          host,
          method,
          endpoint: pathname,
          error: "Unauthorized request: missing or invalid authorization token",
          level: "WARN",
          context: {
            headers: req.headers,
            query: Object.fromEntries(url.searchParams.entries()),
            clientIp
          }
        }, { vaultRoot, logPath: errorLogPath });
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      if (method === "GET" && pathname === "/health") {
        capturedOp = "health_check";
        bus.registerClient({
          id: `http::${clientIp}`,
          ip: clientIp,
          clientName,
          clientType,
          userAgent: req.headers["user-agent"],
          projectId: targetProjectId,
          lastOperation: "health_check"
        });
        const projects = getVaultProjectList(vaultRoot);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: "ok",
          service: "spec-memo-mcp-sse",
          port: (server.address() as { port: number } | null)?.port || port,
          host,
          projectsCount: projects.length,
          activeTransports: transports.size
        }));
        return;
      }

      // Authenticated HTTP changeset sync endpoints (deployment-modes AC16, AC17)
      if (method === "POST" && pathname === "/api/sync/pull") {
        capturedOp = "sync_pull";
        try {
          const body = await readJsonBody(req);
          if (typeof body.projectId === "string") {
            targetProjectId = body.projectId;
          }
          bus.registerClient({
            id: `sync::${clientIp}`,
            ip: clientIp,
            clientName,
            clientType,
            userAgent: req.headers["user-agent"],
            projectId: targetProjectId,
            lastOperation: "sync_pull"
          });
          const changeset = withVaultLockSync(vaultRoot, () =>
            exportChangeset(vaultRoot, {
              projectId: targetProjectId,
              since: typeof body.since === "string" ? body.since : undefined
            })
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(changeset));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logErrorReport({
            subsystem: "sse-server",
            port,
            host,
            method: "POST",
            endpoint: "/api/sync/pull",
            error: err,
            context: { headers: req.headers, clientIp }
          }, { vaultRoot, logPath: errorLogPath });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
        return;
      }

      if (method === "POST" && pathname === "/api/sync/push") {
        capturedOp = "sync_push";
        try {
          const body = await readJsonBody(req);
          const rawChangeset = body.changeset || body;
          const force = Boolean(body.force);
          const dryRun = Boolean(body.dryRun);
          bus.registerClient({
            id: `sync::${clientIp}`,
            ip: clientIp,
            clientName,
            clientType,
            userAgent: req.headers["user-agent"],
            projectId: targetProjectId,
            lastOperation: "sync_push"
          });
          const result = await applyChangeset(vaultRoot, rawChangeset, { force, dryRun });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logErrorReport({
            subsystem: "sse-server",
            port,
            host,
            method: "POST",
            endpoint: "/api/sync/push",
            error: err,
            context: { headers: req.headers, clientIp }
          }, { vaultRoot, logPath: errorLogPath });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
        return;
      }

      if (method === "POST" && pathname === "/api/sync") {
        capturedOp = "sync_bidirectional";
        try {
          const body = await readJsonBody(req);
          let appliedResult: import('./sync.js').SyncResult | undefined;
          if (body.push) {
            const rawChangeset = body.push.changeset || body.push;
            appliedResult = await applyChangeset(vaultRoot, rawChangeset, {
              force: Boolean(body.push.force),
              dryRun: Boolean(body.push.dryRun ?? body.dryRun)
            });
          }
          let pulledChangeset: import('./sync.js').Changeset | undefined;
          if (body.pull) {
            if (typeof body.pull.projectId === "string") {
              targetProjectId = body.pull.projectId;
            }
            pulledChangeset = withVaultLockSync(vaultRoot, () =>
              exportChangeset(vaultRoot, {
                projectId: targetProjectId,
                since: typeof body.pull.since === "string" ? body.pull.since : undefined
              })
            );
          }
          bus.registerClient({
            id: `sync::${clientIp}`,
            ip: clientIp,
            clientName,
            clientType,
            userAgent: req.headers["user-agent"],
            projectId: targetProjectId,
            lastOperation: "sync_bidirectional"
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ applied: appliedResult, changeset: pulledChangeset }));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logErrorReport({
            subsystem: "sse-server",
            port,
            host,
            method: "POST",
            endpoint: "/api/sync",
            error: err,
            context: { headers: req.headers, clientIp }
          }, { vaultRoot, logPath: errorLogPath });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
        return;
      }

      if (method === "GET" && (pathname === "/sse" || pathname === "/")) {
        capturedOp = "sse_connect";
        try {
          const tokenInQuery = url.searchParams.get("token") || url.searchParams.get("authToken");
          const messageEndpoint = tokenInQuery
            ? `/message?token=${encodeURIComponent(tokenInQuery)}`
            : "/message";
          const transport = new SSEServerTransport(messageEndpoint, res);
          const clientId = transport.sessionId;

          bus.registerClient({
            id: clientId,
            ip: clientIp,
            clientName,
            clientType,
            userAgent: req.headers["user-agent"],
            projectId: targetProjectId,
            lastOperation: "sse_connect",
            active: true
          });

          const mcpServer = createMcpServer({
            defaultVaultRoot: vaultRoot,
            activityBus: bus,
            errorLogPath,
            clientIp,
            clientName,
            clientType,
            clientId
          });
          let cleaned = false;
          const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            transports.delete(transport.sessionId);
            bus.disconnectClient(clientId);
            void mcpServer.close().catch((closeErr) => {
              logErrorReport({
                subsystem: "sse-server",
                port,
                host,
                endpoint: "/sse",
                error: closeErr,
                context: { phase: "mcpServer_close_cleanup", sessionId: transport.sessionId, clientIp }
              }, { vaultRoot, logPath: errorLogPath });
            });
          };

          transports.set(transport.sessionId, transport);
          transport.onclose = cleanup;
          res.on("close", cleanup);

          await mcpServer.connect(transport);
          return;
        } catch (sseErr: unknown) {
          logErrorReport({
            subsystem: "sse-server",
            port,
            host,
            endpoint: pathname,
            method: "GET",
            error: sseErr,
            context: { headers: req.headers, clientIp }
          }, { vaultRoot, logPath: errorLogPath });
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "SSE connection failed" }));
          }
          return;
        }
      }

      if (method === "POST" && pathname === "/message") {
        capturedOp = "mcp_message";
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId || !transports.has(sessionId)) {
          logErrorReport({
            subsystem: "sse-server",
            port,
            host,
            method: "POST",
            endpoint: "/message",
            error: `Valid sessionId required (received: ${sessionId || "none"})`,
            context: { sessionId, activeSessions: Array.from(transports.keys()), clientIp }
          }, { vaultRoot, logPath: errorLogPath });
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Valid sessionId required" }));
          return;
        }

        bus.updateClientActivity(sessionId, {
          operation: "mcp_message",
          projectId: targetProjectId,
          clientName
        });

        const transport = transports.get(sessionId)!;
        try {
          await transport.handlePostMessage(req, res);
        } catch (postErr: unknown) {
          logErrorReport({
            subsystem: "sse-server",
            port,
            host,
            method: "POST",
            endpoint: "/message",
            error: postErr,
            context: { sessionId, clientIp }
          }, { vaultRoot, logPath: errorLogPath });
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to handle post message" }));
          }
        }
        return;
      }

      capturedOp = "route_not_found";
      logErrorReport({
        subsystem: "sse-server",
        port,
        host,
        method,
        endpoint: pathname,
        error: `Route not found: ${method} ${pathname}`,
        level: "WARN"
      }, { vaultRoot, logPath: errorLogPath });
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    server.on("error", (err) => {
      logErrorReport({
        subsystem: "sse-server",
        port,
        host,
        error: err,
        level: "FATAL",
        context: { phase: "server_listen_error" }
      }, { vaultRoot, logPath: errorLogPath });
      reject(err);
    });

    server.listen(port, host, async () => {
      const actualPort = (server.address() as { port: number }).port;
      const serverUrl = `http://${host}:${actualPort}`;

      let statusUrl: string | undefined;
      let statusPort: number | undefined;

      if (enableStatus) {
        const statusHost = options.statusHost || host;
        const statusAuth = options.statusAuthToken || authToken;
        try {
          statusInstance = await startStatusServer({
            port: options.statusPort ?? 3001,
            host: statusHost,
            vaultRoot,
            authToken: statusAuth,
            activityBus: bus,
            errorLogPath,
            isDaemon: true,
            getMcp: () => ({
              host,
              port: actualPort,
              activeTransports: transports.size,
              available: true
            })
          });
          statusUrl = statusInstance.url;
          statusPort = statusInstance.port;
          bus.capture({
            type: "system",
            kind: "meta",
            ok: true,
            durationMs: 0,
            summary: `Status monitor listening at ${statusInstance.url}`
          });
        } catch (err) {
          logErrorReport({
            subsystem: "status-server",
            port: options.statusPort ?? 3001,
            host: statusHost,
            error: err,
            level: "FATAL",
            context: { phase: "status_server_start_rollback" }
          }, { vaultRoot, logPath: errorLogPath });
          bus.close();
          for (const transport of transports.values()) {
            try {
              transport.close();
            } catch {
              // ignore cleanup error
            }
          }
          transports.clear();
          await new Promise<void>((res) => {
            server.close(() => res());
          });
          reject(err);
          return;
        }
      }

      resolve({
        server,
        port: actualPort,
        host,
        url: serverUrl,
        statusUrl,
        statusPort,
        activityBus: bus,
        close: async () => {
          bus.close();
          if (statusInstance) {
            await statusInstance.close();
          }
          for (const transport of transports.values()) {
            try {
              transport.close();
            } catch {
              // ignore cleanup error
            }
          }
          transports.clear();
          if (typeof (server as any).closeAllConnections === 'function') {
            (server as any).closeAllConnections();
          }
          try {
            server.unref();
          } catch {
            // ignore
          }
          await new Promise<void>((res) => {
            server.close(() => res());
          });
          flushTelemetrySync(vaultRoot);
          await closeTelemetry(vaultRoot);
        }
      });
    });
  });
}
