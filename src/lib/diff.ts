import type { GhFile } from "./github";

/** Files that are noise for an LLM review. */
const SKIP_PATTERNS: RegExp[] = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Podfile\.lock|Cargo\.lock|gradle\.lockfile|composer\.lock)$/,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.(png|jpe?g|gif|webp|ico|svg|pdf|jar|zip|woff2?|ttf|eot)$/i,
  /(^|\/)(dist|build|node_modules|vendor)\//,
  /gradle-wrapper\.(jar|properties)$/,
];

/** Lock files, build output, binaries: not worth sending to the model. */
export const isNoiseFile = (filename: string) => SKIP_PATTERNS.some((p) => p.test(filename));

export interface PreparedFile {
  path: string;
  status: string;
  text: string;
  /** New-side line numbers present in the diff (commentable with side=RIGHT). */
  validLines: Set<number>;
}

export interface PreparedDiff {
  files: PreparedFile[];
  skipped: string[];
  totalChars: number;
}

/**
 * Rewrites a unified-diff patch so every new-side line carries its line number:
 *   "  42 + added"   "  43   context"   "     - removed"
 * The model is told to only cite numbered lines, which keeps comments anchorable.
 */
export function annotatePatch(patch: string): { text: string; validLines: Set<number> } {
  const out: string[] = [];
  const valid = new Set<number>();
  let n = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("@@")) {
      const m = /\+(\d+)/.exec(l);
      n = m ? Number(m[1]) : n;
      out.push(l);
    } else if (l.startsWith("+")) {
      valid.add(n);
      out.push(`${String(n).padStart(5)} + ${l.slice(1)}`);
      n++;
    } else if (l.startsWith("-")) {
      out.push(`      - ${l.slice(1)}`);
    } else if (l.startsWith("\\")) {
      out.push(l);
    } else {
      valid.add(n);
      out.push(`${String(n).padStart(5)}   ${l.slice(1)}`);
      n++;
    }
  }
  return { text: out.join("\n"), validLines: valid };
}

export function prepareDiff(files: GhFile[], maxChars: number): PreparedDiff {
  const result: PreparedDiff = { files: [], skipped: [], totalChars: 0 };
  // Review the most-changed files first when the budget runs out.
  const sorted = [...files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  for (const f of sorted) {
    if (f.status === "removed" || !f.patch || isNoiseFile(f.filename)) {
      result.skipped.push(f.filename);
      continue;
    }
    const { text, validLines } = annotatePatch(f.patch);
    if (result.totalChars + text.length > maxChars) {
      result.skipped.push(f.filename);
      continue;
    }
    result.totalChars += text.length;
    result.files.push({ path: f.filename, status: f.status, text, validLines });
  }
  return result;
}
