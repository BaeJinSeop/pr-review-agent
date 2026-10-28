import { load, type Store } from "@tauri-apps/plugin-store";

export interface Settings {
  model: string;
  pollMinutes: number;
  dryRun: boolean;
  skipExistingOnAdd: boolean;
  maxDiffChars: number;
  guidelines: string;
  /** Comma-separated PR labels that skip review. */
  skipLabels: string;
  /** Comma-separated PR author logins that skip review (e.g. bots). */
  skipAuthors: string;
  /** Reply "fixed" and resolve the agent's own open threads the model judges fixed. */
  autoResolve: boolean;
}

export interface RepoConfig {
  fullName: string; // owner/name
  enabled: boolean;
  /** Comma-separated base branches to review. Empty = all. */
  baseBranches: string;
}

export type HistoryStatus = "posted" | "dry-run" | "skipped" | "error";

export interface HistoryEntry {
  time: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  sha: string;
  status: HistoryStatus;
  commentCount: number;
  summary: string;
  error?: string;
  /** full = whole PR diff, incremental = only commits since the last review. */
  mode?: "full" | "incremental";
  /** Comments dropped because the same point was already posted. */
  duplicateCount?: number;
  /** Earlier agent threads marked resolved because the fix was confirmed. */
  resolvedCount?: number;
}

export const DEFAULT_GUIDELINES = `- 버그, 보안, 성능, 장애 가능성을 우선 지적하고 스타일 취향은 지적하지 않는다.
- DB 쿼리: 대량 조회에 범위/인덱스/페이징이 없거나, 실행시간 제한(MAX_EXECUTION_TIME 등) 없이 무거운 집계를 돌리면 지적한다.
- Spring WebFlux/R2DBC: 리액티브 체인 안의 블로킹 호출, subscribe 누락, 에러 처리 누락을 지적한다.
- 파일 업로드/멀티파트: 임시파일 정리 누락, 메모리에 전체 적재하는 코드를 지적한다.
- 비밀번호, 토큰, 접속정보 하드코딩과 로그 출력을 지적한다.
- 수정 방법을 구체적으로 제안한다.`;

export const DEFAULT_SETTINGS: Settings = {
  model: "",
  pollMinutes: 10,
  dryRun: false,
  skipExistingOnAdd: true,
  maxDiffChars: 120_000,
  guidelines: DEFAULT_GUIDELINES,
  skipLabels: "skip-review, no-review",
  skipAuthors: "dependabot[bot], renovate[bot]",
  autoResolve: true,
};

const HISTORY_LIMIT = 300;

let storePromise: Promise<Store> | null = null;
function store(): Promise<Store> {
  storePromise ??= load("config.json", { autoSave: 200, defaults: {} });
  return storePromise;
}

async function get<T>(key: string, fallback: T): Promise<T> {
  const v = await (await store()).get<T>(key);
  return v ?? fallback;
}
async function set(key: string, value: unknown): Promise<void> {
  const s = await store();
  await s.set(key, value);
  await s.save();
}

export const config = {
  async settings(): Promise<Settings> {
    return { ...DEFAULT_SETTINGS, ...(await get<Partial<Settings>>("settings", {})) };
  },
  saveSettings: (s: Settings) => set("settings", s),

  repos: () => get<RepoConfig[]>("repos", []),
  saveRepos: (r: RepoConfig[]) => set("repos", r),

  /** key "owner/repo#123" -> last reviewed head SHA */
  reviewed: () => get<Record<string, string>>("reviewed", {}),
  async markReviewed(key: string, sha: string) {
    const r = await config.reviewed();
    r[key] = sha;
    await set("reviewed", r);
  },

  /** key -> failed attempts at a given SHA, so a broken PR is not retried forever. */
  failures: () => get<Record<string, { sha: string; count: number }>>("failures", {}),
  async recordFailure(key: string, sha: string) {
    const f = await config.failures();
    f[key] = { sha, count: f[key]?.sha === sha ? f[key].count + 1 : 1 };
    await set("failures", f);
  },

  history: () => get<HistoryEntry[]>("history", []),
  async addHistory(e: HistoryEntry) {
    const h = await config.history();
    h.unshift(e);
    await set("history", h.slice(0, HISTORY_LIMIT));
  },
  clearHistory: () => set("history", []),

  lastCheck: () => get<string | null>("lastCheck", null),
  setLastCheck: (iso: string) => set("lastCheck", iso),
};
