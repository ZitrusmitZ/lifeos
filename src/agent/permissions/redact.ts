/**
 * Secrets aus Befehlen und Parametern entfernen, bevor sie ins Audit-Log oder in die Oberfläche gelangen.
 * Heuristisch (Schlüsselwörter, bekannte Token-Formen) – lieber zu viel schwärzen als ein Secret durchlassen.
 */

const MASK = "***";
const KEY = String.raw`[\w.-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|apikey|auth|credential|private[_-]?key|cookie|session)[\w.-]*`;

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, `${MASK}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/(-H|--header)(\s+)(["']?)(Authorization|X-[\w-]*(?:key|token)[\w-]*|Cookie)\s*:[^"'\n]*/gi, `$1$2$3$4: ${MASK}`],
  [new RegExp(String.raw`(${KEY})(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"';&|]+)`, "gi"), `$1$2${MASK}`],
  [new RegExp(String.raw`(--?${KEY})(\s+)("[^"]*"|'[^']*'|[^\s"';&|-][^\s"';&|]*)`, "gi"), `$1$2${MASK}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MASK}@`],
  [/\b(?:sk|pk|rk|xox[abprs]|ghp|gho|ghu|ghs|github_pat|glpat|AKIA|AIza|ya29)[-_A-Za-z0-9]{16,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, MASK],
  [/\b[0-9a-f]{40,}\b/gi, MASK],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}
