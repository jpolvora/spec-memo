import http from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./mcp.js";
import { getVaultRoot } from "./vault.js";
import { getVaultProjectList } from "./canvas.js";
import { ActivityBus, createActivityBus } from "./activity.js";
import { startStatusServer, StatusServerInstance } from "./status.js";

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

function captureHttpEvent(
  bus: ActivityBus,
  method: string,
  path: string,
  statusCode: number,
  durationMs: number
): void {
  bus.capture({
    type: "http",
    kind: "meta",
    ok: statusCode < 400,
    durationMs,
    summary: `${method} ${path} ${statusCode}`,
    method,
    path,
    statusCode
  });
}

export function startSseServer(options: SseServerOptions = {}): Promise<SseServerInstance> {
  const port = options.port ?? 3000;
  const host = options.host || "127.0.0.1";
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const authToken = options.authToken || process.env.SPEC_MEMO_AUTH_TOKEN || process.env.SPEC_MEMO_SSE_TOKEN;
  const enableStatus = options.enableStatus !== false;
  const bus = options.activityBus ?? createActivityBus({ capacity: 200 });

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !authToken) {
    throw new Error("Refusing to bind SSE MCP server to a non-loopback host without authentication token (--auth-token or SPEC_MEMO_SSE_TOKEN).");
  }

  const transports = new Map<string, SSEServerTransport>();
  let statusInstance: StatusServerInstance | undefined;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const started = Date.now();
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const pathname = url.pathname;
      const method = req.method || "GET";

      const finishCapture = (statusCode: number) => {
        if (pathname === "/health" || pathname === "/sse" || pathname === "/message") {
          captureHttpEvent(bus, method, pathname, statusCode, Date.now() - started);
        }
      };

      res.on("finish", () => {
        finishCapture(res.statusCode || 500);
      });

      if (authToken) {
        const authHeader = req.headers.authorization;
        const authorized = authHeader === `Bearer ${authToken}`;
        if (!authorized) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }

      if (req.method === "GET" && pathname === "/health") {
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

      if (req.method === "GET" && pathname === "/sse") {
        const transport = new SSEServerTransport("/message", res);
        const mcpServer = createMcpServer({ defaultVaultRoot: vaultRoot, activityBus: bus });
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          transports.delete(transport.sessionId);
          void mcpServer.close().catch(() => {
            // ignore cleanup error
          });
        };

        transports.set(transport.sessionId, transport);
        transport.onclose = cleanup;
        res.on("close", cleanup);

        await mcpServer.connect(transport);
        return;
      }

      if (req.method === "POST" && pathname === "/message") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId || !transports.has(sessionId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Valid sessionId required" }));
          return;
        }

        const transport = transports.get(sessionId)!;
        await transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    server.on("error", reject);

    server.listen(port, host, async () => {
      const actualPort = (server.address() as { port: number }).port;
      const serverUrl = `http://${host}:${actualPort}`;

      let statusUrl: string | undefined;
      let statusPort: number | undefined;

      if (enableStatus) {
        try {
          const statusHost = options.statusHost || host;
          const statusAuth = options.statusAuthToken || authToken;
          statusInstance = await startStatusServer({
            port: options.statusPort ?? 3001,
            host: statusHost,
            vaultRoot,
            authToken: statusAuth,
            activityBus: bus,
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
          await new Promise<void>((res) => {
            server.close(() => res());
          });
        }
      });
    });
  });
}
