import { parseFindingId } from "./finding-id.js";

const WONT_FIX_RE = /\b(won't\s*fix|wont\s*fix|false\s*positive|not\s*a\s*bug)\b/i;

export function isWontFixText(body: string): boolean {
  return WONT_FIX_RE.test(body);
}

export function collectWontFixIds(
  items: Array<{
    body: string;
    isAgent?: boolean;
    parentAgentId?: string | null;
    reactionWontFix?: boolean;
  }>,
): Set<string> {
  const out = new Set<string>();
  for (const item of items) {
    const hit = item.reactionWontFix || isWontFixText(item.body);
    if (!hit) continue;
    const id =
      item.parentAgentId ??
      (item.isAgent ? parseFindingId(item.body) ?? undefined : undefined);
    if (id) out.add(id.toLowerCase());
  }
  return out;
}
