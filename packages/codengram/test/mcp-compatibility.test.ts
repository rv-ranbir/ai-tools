import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

describe("MCP transport compatibility", () => {
  it("lists tools from the codengram stdio server", async () => {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const client = new Client({ name: "codengram-compatibility-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", cli, "mcp", "--dir", process.cwd()],
      stderr: "pipe",
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual([
        "get_context",
        "search_symbols",
        "file_info",
      ]);
    } finally {
      await client.close();
    }
  });

  it("serves an SDK Streamable HTTP exchange through Hono 2", async () => {
    let sessionClosed = false;
    const serverTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessionclosed: () => {
        sessionClosed = true;
      },
    });
    const sdkServer = new Server(
      { name: "hono-compatibility-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    sdkServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "echo",
          description: "Echo a message",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ],
    }));
    sdkServer.setRequestHandler(CallToolRequestSchema, async (request) => ({
      content: [
        {
          type: "text",
          text: String(request.params.arguments?.message ?? ""),
        },
      ],
    }));
    await sdkServer.connect(serverTransport);

    const app = new Hono().all("/mcp", (context) =>
      serverTransport.handleRequest(context.req.raw),
    );
    let httpServer: ReturnType<typeof serve> | undefined;
    const address = await new Promise<AddressInfo>((resolve) => {
      httpServer = serve({ fetch: app.fetch, port: 0 }, resolve);
    });
    const client = new Client({ name: "hono-compatibility-client", version: "1.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );

    try {
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(["echo"]);
      expect(
        await client.callTool({
          name: "echo",
          arguments: { message: "through Hono 2" },
        }),
      ).toMatchObject({
        content: [{ type: "text", text: "through Hono 2" }],
      });
      await clientTransport.terminateSession();
      expect(sessionClosed).toBe(true);
    } finally {
      await client.close();
      await sdkServer.close();
      await new Promise<void>((resolve, reject) => {
        httpServer?.close((error) => (error ? reject(error) : resolve()));
      });
    }

    const adapterEntry = import.meta.resolve("@hono/node-server");
    const packageJson = path.resolve(fileURLToPath(adapterEntry), "../../package.json");
    const adapterPackage = JSON.parse(await readFile(packageJson, "utf8")) as {
      version: string;
    };
    expect(adapterPackage.version).toBe("2.0.12");
  });
});
