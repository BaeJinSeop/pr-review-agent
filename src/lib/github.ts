import { fetch } from "@tauri-apps/plugin-http";

const API = "https://api.github.com";

export interface GhRepo {
  full_name: string;
  private: boolean;
  archived: boolean;
  default_branch: string;
  owner: { login: string };
}

export interface GhPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  draft: boolean;
  user: { login: string };
  head: { sha: string; ref: string };
  base: { ref: string };
}

export interface GhFile {
  filename: string;
  status: string; // added | removed | modified | renamed | copied | changed | unchanged
  additions: number;
  deletions: number;
  patch?: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class GitHub {
  constructor(private token: string) {}

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pr-review-agent",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try {
        msg = JSON.parse(text).message ?? text;
      } catch {
        /* not json */
      }
      throw new GitHubError(res.status, `GitHub ${res.status}: ${msg}`);
    }
    return (await res.json()) as T;
  }

  private async paged<T>(path: string, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.req<T[]>(`${path}${sep}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  me() {
    return this.req<{ login: string; name: string | null }>("/user");
  }

  listRepos() {
    return this.paged<GhRepo>(
      "/user/repos?sort=full_name&affiliation=owner,collaborator,organization_member",
    );
  }

  listOpenPulls(repo: string) {
    return this.paged<GhPull>(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc`, 2);
  }

  getPull(repo: string, number: number) {
    return this.req<GhPull>(`/repos/${repo}/pulls/${number}`);
  }

  listPullFiles(repo: string, number: number) {
    // GitHub returns at most 3000 files; 3 pages is plenty for review purposes.
    return this.paged<GhFile>(`/repos/${repo}/pulls/${number}/files`, 3);
  }

  createReview(repo: string, number: number, commitId: string, body: string, comments: ReviewComment[]) {
    return this.req<{ id: number; html_url: string }>(`/repos/${repo}/pulls/${number}/reviews`, {
      method: "POST",
      body: JSON.stringify({ commit_id: commitId, event: "COMMENT", body, comments }),
    });
  }
}

/** https://github.com/owner/repo/pull/123 -> {repo, number} */
export function parsePullUrl(url: string): { repo: string; number: number } | null {
  const m = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(url.trim());
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}
