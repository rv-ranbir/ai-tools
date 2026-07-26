import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { selectContext } from "./graph.js";
import { getFileInfo, searchSymbols } from "./query.js";
import { indexPath, loadIndex } from "./store.js";
import type { CodemapIndex } from "./types.js";

// Tool schemas are plain JSON Schema (not zod) so the MCP SDK's zod version
// never has to agree with ours.
const TOOLS = [
  {
    name: "get_context",
    description:
      "Get token-budgeted repository context for a set of files: summaries and exported symbols of the files' importers (code that depends on them), their imports, and the files themselves. Use before modifying or reviewing files to understand what depends on them.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Repo-relative paths of the files being changed or studied",
        },
        token_budget: {
          type: "number",
          description: "Approximate max tokens of context to return (default 8000)",
        },
      },
      required: ["files"],
    },
  },
  {
    name: "search_symbols",
    description:
      "Search the repository's exported symbols and file paths by substring. Returns matching files with their matching symbol signatures and summaries.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive substring to search for" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "file_info",
    description:
      "Everything the repository index knows about one file: summary, exported symbols, imports, and importers (files that depend on it).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative file path" },
      },
      required: ["path"],
    },
  },
] as const;

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function errorText(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

/** Run the codengram MCP server on stdio, serving the index in `cwd`. */
export async function runMcpServer(cwd: string): Promise<void> {
  const server = new Server(
    { name: "codengram", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const requireIndex = async (): Promise<CodemapIndex> => {
    const index = await loadIndex(cwd);
    if (!index) {
      throw new Error(`No codengram index at ${indexPath(cwd)}. Run \`codengram index\` first.`);
    }
    return index;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ ...t, inputSchema: t.inputSchema as Record<string, unknown> })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const index = await requireIndex();
      switch (req.params.name) {
        case "get_context": {
          const files = Array.isArray(args.files) ? args.files.map(String) : [];
          if (files.length === 0) return errorText("Pass at least one file path in `files`.");
          const budget = typeof args.token_budget === "number" ? args.token_budget : 8000;
          const { entries, rendered } = selectContext(index, files, budget);
          return text(entries.length ? rendered : "No context found for those files in the index.");
        }
        case "search_symbols": {
          const query = String(args.query ?? "");
          if (!query) return errorText("Pass a non-empty `query`.");
          const limit = typeof args.limit === "number" ? args.limit : 20;
          const matches = searchSymbols(index, query, limit);
          if (matches.length === 0) return text(`No matches for "${query}".`);
          return text(
            matches
              .map((m) => {
                const parts = [`## ${m.path}`];
                if (m.summary) parts.push(m.summary);
                if (m.symbols.length) parts.push(m.symbols.map((s) => `- ${s}`).join("\n"));
                return parts.join("\n");
              })
              .join("\n\n"),
          );
        }
        case "file_info": {
          const info = getFileInfo(index, String(args.path ?? ""));
          if (!info) return errorText(`"${args.path}" is not in the index.`);
          return text(JSON.stringify(info, null, 2));
        }
        default:
          return errorText(`Unknown tool: ${req.params.name}`);
      }
    } catch (err) {
      return errorText(err instanceof Error ? err.message : String(err));
    }
  });

  await server.connect(new StdioServerTransport());
}
