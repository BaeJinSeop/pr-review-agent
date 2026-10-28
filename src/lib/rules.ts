// Pure helpers (no Tauri imports) so they can be unit-tested with plain node.

/** Hidden marker appended to every line comment this app posts. */
export const AGENT_MARKER = "<!-- pr-review-agent -->";

/** Severity prefixes used before the marker existed (v0.1.0 comments). */
const LEGACY_PREFIXES = ["**🔴 치명**", "**🟠 중요**", "**🟡 개선**", "**⚪ 사소**"];

export function isAgentComment(body: string): boolean {
  return body.includes(AGENT_MARKER) || LEGACY_PREFIXES.some((p) => body.startsWith(p));
}

export function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

const SKIP_TITLE = /\[(skip[ -]?review|no[ -]?review)\]/i;

export interface SkipInput {
  title: string;
  draft: boolean;
  author: string;
  labels: string[];
}

/** Returns why a PR should not be reviewed, or null to review it. */
export function skipReason(pr: SkipInput, skipLabels: string, skipAuthors: string): string | null {
  if (pr.draft) return "draft PR";
  if (SKIP_TITLE.test(pr.title)) return "제목에 [skip review]";
  if (splitList(skipAuthors).includes(pr.author.toLowerCase())) return `제외 작성자 ${pr.author}`;
  const skip = new Set(splitList(skipLabels));
  const hit = pr.labels.find((l) => skip.has(l.toLowerCase()));
  if (hit) return `제외 라벨 ${hit}`;
  return null;
}

/** Text used for similarity: drop marker, severity prefix, code fences, punctuation. */
function normalize(body: string): string {
  return body
    .replace(AGENT_MARKER, "")
    .replace(/^\*\*[^*]+\*\*\s*/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Dice coefficient over character bigrams (works for Korean without a tokenizer). */
export function similarity(a: string, b: string): number {
  const A = bigrams(normalize(a));
  const B = bigrams(normalize(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export interface PriorComment {
  path: string;
  line: number | null;
  body: string;
}

export const DUP_LINE_WINDOW = 3;
export const DUP_SIMILARITY = 0.45;

/** True when a prior agent comment on the same file, near the same line, says roughly the same thing.
 *  An outdated prior comment (line=null) has no reliable position, so it needs a closer text match. */
export const DUP_SIMILARITY_OUTDATED = 0.7;

export function isDuplicate(c: { path: string; line: number; body: string }, prior: PriorComment[]): boolean {
  return prior.some((p) => {
    if (p.path !== c.path) return false;
    const sim = similarity(p.body, c.body);
    if (p.line === null) return sim >= DUP_SIMILARITY_OUTDATED;
    return Math.abs(p.line - c.line) <= DUP_LINE_WINDOW && sim >= DUP_SIMILARITY;
  });
}
