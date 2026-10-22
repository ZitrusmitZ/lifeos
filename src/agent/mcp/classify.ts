/**
 * Lesend oder ändernd? Bestimmt, ob ein Connector-Tool ohne Rückfrage laufen darf.
 * Maßgeblich ist das erste bekannte Verb im Tool-Namen (`mcp__claude_ai_Gmail__search_threads` → search,
 * `notion-create-pages` → create, `COMPOSIO_MULTI_EXECUTE_TOOL` → execute). Unbekannt heißt: nachfragen.
 */

const READ = new Set([
  "get", "list", "search", "read", "fetch", "query", "find", "view", "describe", "check", "lookup", "retrieve",
  "show", "count", "suggest", "status", "info", "preview", "download", "export", "answer", "resolve", "whoami", "me", "skill",
]);

const WRITE = new Set([
  "create", "update", "delete", "remove", "send", "trash", "untrash", "label", "unlabel", "move", "apply", "reply",
  "forward", "cancel", "respond", "set", "add", "edit", "upload", "generate", "copy", "merge", "publish", "execute",
  "run", "mark", "unmark", "manage", "submit", "spawn", "stop", "restore", "duplicate", "convert", "import", "resize",
  "write", "post", "patch", "put", "insert", "archive", "invite", "share", "book", "pay", "comment", "approve", "bash",
  "use", "rebuild", "prime", "reprime", "build", "separate", "save",
]);

export function toolVerbs(name: string): string[] {
  const short = name.includes("__") ? name.slice(name.lastIndexOf("__") + 2) : name;
  return short
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

export function isReadOnlyTool(name: string): boolean {
  for (const word of toolVerbs(name)) {
    if (WRITE.has(word)) return false;
    if (READ.has(word)) return true;
  }
  return false;
}
