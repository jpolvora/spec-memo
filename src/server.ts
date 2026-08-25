import http from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpServer } from "./mcp.js";
import { getVaultRoot } from "./vault.js";
import { getVaultProjectList } from "./canvas.js";

export interface SseServerOptions {
  port?: number;
  host?: string;
  vaultRoot?: string;
  authToken?: string;
}

export interface SseServerInstance {
  server: http.Server;
  port: number;
  host: string;
  url: string;
  close: () => Promise<void>;
}

export function startSseServer(options: SseServerOptions = {}): Promise<SseServerInstance> {
  const port = options.port ?? 3000;
  const host = options.host || "127.0.0.1";
  const vaultRoot = getVaultRoot(options.vaultRoot);
  const authToken = options.authToken || process.env.SPEC_MEMO_AUTH_TOKEN || process.env.SPEC_MEMO_SSE_TOKEN;

  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !authToken) {
    throw new Error("Refusing to bind SSE MCP server to a non-loopback host without authentication token (--auth-token or SPEC_MEMO_SSE_TOKEN).");
  }

  const transports = new Map<string, SSEServerTransport>();

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const pathname = url.pathname;

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
          port: (server.address() as any)?.port || port,
          host,
          projectsCount: projects.length,
          activeTransports: transports.size
        }));
        return;
      }

      if (req.method === "GET" && pathname === "/sse") {
        const transport = new SSEServerTransport("/message", res);
        const mcpServer = createMcpServer({ defaultVaultRoot: vaultRoot });

        transports.set(transport.sessionId, transport);

        transport.onclose = () => {
          transports.delete(transport.sessionId);
        };

        res.on("close", () => {
          transports.delete(transport.sessionId);
        });

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

    server.listen(port, host, () => {
      const actualPort = (server.address() as any).port;
      const serverUrl = `http://${host}:${actualPort}`;
      resolve({
        server,
        port: actualPort,
        host,
        url: serverUrl,
        close: () => new Promise<void>((res) => {
          for (const transport of transports.values()) {
            try {
              transport.close();
            } catch {
              // ignore cleanup error
            }
          }
          transports.clear();
          server.close(() => res());
        })
      });
    });
  });
}
