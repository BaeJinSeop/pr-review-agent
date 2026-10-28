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
  labels?: { name: string }[];
}

export interface GhCompare {
  status: "identical" | "ahead" | "behind" | "diverged";
  files?: GhFile[];
}

/** A review thread, reduced to its first comment (the one that raised the point). */
export interface GhThread {
  id: string; // GraphQL node id
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  /** null when outdated (the line no longer exists at head). */
  line: number | null;
  body: string;
}

interface ThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          isResolved: boolean;
          isOutdated: boolean;
          path: string;
          line: number | null;
          comments: { nodes: { body: string }[] };
        }[];
      };
    } | null;
  } | null;
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line
          comments(first: 1) { nodes { body } }
        }
      }
    }
  }
}`;

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

  /** Changes between two commits (base...head). Files capped at 300 by GitHub. */
  compare(repo: string, base: string, head: string) {
    return this.req<GhCompare>(`/repos/${repo}/compare/${base}...${head}`);
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.req<{ data?: T; errors?: { message: string }[] }>("/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
    if (res.errors?.length) throw new GitHubError(200, `GitHub GraphQL: ${res.errors.map((e) => e.message).join("; ")}`);
    return res.data as T;
  }

  /** All review threads of a PR with their resolved state (REST does not expose it). */
  async listReviewThreads(repo: string, number: number): Promise<GhThread[]> {
    const [owner, name] = repo.split("/");
    const out: GhThread[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const data: ThreadsPage = await this.graphql<ThreadsPage>(THREADS_QUERY, { owner, name, number, cursor });
      const t = data.repository?.pullRequest?.reviewThreads;
      if (!t) break;
      for (const n of t.nodes) {
        const first = n.comments.nodes[0];
        if (!first) continue;
        out.push({ id: n.id, isResolved: n.isResolved, isOutdated: n.isOutdated, path: n.path, line: n.line, body: first.body });
      }
      if (!t.pageInfo.hasNextPage) break;
      cursor = t.pageInfo.endCursor;
    }
    return out;
  }

  /** Reply in a thread, then mark it resolved. */
  async replyAndResolve(threadId: string, body: string): Promise<void> {
    await this.graphql(
      `mutation($id: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } }
      }`,
      { id: threadId, body },
    );
    await this.graphql(
      `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`,
      { id: threadId },
    );
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
