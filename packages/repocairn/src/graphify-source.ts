import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CodemapFileEntry } from "./types.js";

interface GraphifyNode {
  id: string;
  label?: string;
  source_file?: string;
  file_type?: string;
}

interface GraphifyEdge {
  source: string;
  target: string;
  relation?: string;
}

interface GraphifyGraph {
  nodes: GraphifyNode[];
  edges?: GraphifyEdge[];
  links?: GraphifyEdge[];
}

const GRAPH_RELATIVE_PATH = "graphify-out/graph.json";

// graphify resolves a relative import ("./foo") to a file-level "imports"/"imports_from"
// edge, but a bare workspace-package specifier (import { X } from "repocairn" in a
// monorepo) only shows up as "calls"/"indirect_call"/"references" edges on the actual
// symbols used — confirmed against a real cross-package build (secondpair -> repocairn
// produced zero imports/imports_from edges, six calls/indirect_call edges). Any of these
// structural relations between two different files' code nodes is a real dependency for
// selectContext's importer-ranking purpose. Excludes containment ("contains", "method")
// and LLM-inferred semantic-similarity relations ("semantically_similar_to",
// "conceptually_related_to", "shares_data_with", "rationale_for", "cites") — those aren't
// real code coupling and would pollute the ranking with guesswork.
const DEPENDENCY_RELATIONS = new Set([
  "imports",
  "imports_from",
  "calls",
  "indirect_call",
  "implements",
  "inherits",
  "mixes_in",
  "embeds",
  "references",
  "re_exports",
]);

export type GraphifyFacts = Map<string, Pick<CodemapFileEntry, "symbols" | "imports">>;

function toRepoRelative(sourceFile: string, cwd: string): string {
  const abs = path.isAbsolute(sourceFile) ? sourceFile : path.join(cwd, sourceFile);
  return path.relative(cwd, abs).split(path.sep).join("/");
}

/**
 * Load graphify's structural graph (`graphify-out/graph.json`), if one exists, and
 * derive per-file symbols/imports from it. graphify's AST layer already resolves
 * cross-file imports for far more languages (including monorepo workspace packages
 * via package.json/pnpm-workspace.yaml) than repocairn's own extractors — reuse it
 * instead of duplicating that resolution work.
 *
 * Returns null when no graph exists — callers fall back to repocairn's own
 * tree-sitter/generic extraction, so repocairn still works standalone.
 *
 * ponytail: symbol nodes include the file's own container node (graphify's
 * `_file_node_id`), which shows up as one extra harmless "symbol" equal to the
 * filename — not worth reverse-engineering graphify's id-normalization to filter out.
 */
export async function loadGraphifyFacts(cwd: string): Promise<GraphifyFacts | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(cwd, GRAPH_RELATIVE_PATH), "utf8");
  } catch {
    return null;
  }

  const graph: GraphifyGraph = JSON.parse(raw);
  const edges = graph.edges ?? graph.links ?? [];

  const sourceFileOf = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.file_type === "code" && n.source_file) {
      sourceFileOf.set(n.id, toRepoRelative(n.source_file, cwd));
    }
  }

  const facts: GraphifyFacts = new Map();
  const entryFor = (file: string) => {
    let e = facts.get(file);
    if (!e) {
      e = { symbols: [], imports: [] };
      facts.set(file, e);
    }
    return e;
  };

  for (const n of graph.nodes) {
    if (n.file_type !== "code" || !n.source_file || !n.label) continue;
    entryFor(toRepoRelative(n.source_file, cwd)).symbols.push(n.label);
  }

  for (const e of edges) {
    if (!e.relation || !DEPENDENCY_RELATIONS.has(e.relation)) continue;
    const from = sourceFileOf.get(e.source);
    const to = sourceFileOf.get(e.target);
    if (!from || !to || from === to) continue;
    const entry = entryFor(from);
    if (!entry.imports.includes(to)) entry.imports.push(to);
  }

  return facts;
}
