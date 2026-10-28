import { Claude, type ModelComment, type Severity } from "./claude";
import { config, type HistoryEntry, type Settings } from "./config";
import { annotatePatch, prepareDiff, type PreparedDiff } from "./diff";
import { GitHub, GitHubError, type GhFile, type GhPull, type GhThread, type ReviewComment } from "./github";
import { AGENT_MARKER, isAgentComment, isDuplicate, skipReason, type PriorComment } from "./rules";
import { secrets } from "./secrets";

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "🔴 치명",
  major: "🟠 중요",
  minor: "🟡 개선",
  nit: "⚪ 사소",
};

export type LogFn = (msg: string) => void;

/** Automatic retries per (PR, head SHA). Manual review by URL ignores this. */
const MAX_ATTEMPTS = 3;
/** Open agent threads shown to the model (newest first). */
const MAX_PRIOR_IN_PROMPT = 40;
/** Resolved agent threads shown as "do not raise again" context. */
const MAX_CLOSED_IN_PROMPT = 20;

export async function clients(): Promise<{ gh: GitHub; claude: Claude }> {
  const [token, key] = await Promise.all([secrets.get("github_token"), secrets.get("anthropic_api_key")]);
  if (!token) throw new Error("GitHub 토큰이 설정되지 않았습니다 (설정 탭).");
  if (!key) throw new Error("Claude API 키가 설정되지 않았습니다 (설정 탭).");
  return { gh: new GitHub(token), claude: new Claude(key) };
}

const prKey = (repo: string, n: number) => `${repo}#${n}`;
const short = (sha: string) => sha.slice(0, 7);

function matchesBase(baseBranches: string, base: string): boolean {
  const list = baseBranches
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length === 0 || list.includes(base);
}

function systemPrompt(s: Settings): string {
  return `당신은 시니어 소프트웨어 엔지니어로서 GitHub Pull Request를 리뷰합니다.

규칙:
- 반드시 submit_review 도구로 결과를 제출합니다.
- 모든 내용은 한국어로 작성합니다.
- 라인 코멘트는 diff에서 왼쪽에 번호가 붙은 라인(새 파일 기준)에만 답니다. "-"로 표시된 삭제 라인에는 달지 않습니다.
- path는 diff 헤더의 파일 경로를 그대로 씁니다.
- 실제로 문제가 되거나 개선 효과가 분명한 것만 지적합니다. 확신이 낮은 추측, 칭찬, 단순 요약은 라인 코멘트로 달지 않습니다.
- 각 코멘트에는 왜 문제인지와 구체적인 수정 방법(가능하면 코드)을 적습니다.
- "열린 이전 지적"(T1, T2 ... id가 붙음)이 주어지면, 같은 지적은 다시 달지 않습니다. 현재 diff에서 그 문제가 확실히 고쳐졌으면 resolved_threads에 id와 이유를 넣습니다. 고쳐졌는지 diff로 확인할 수 없거나 애매하면 넣지 않습니다.
- "결론 난 이전 지적"은 사람이 이미 처리(수정 또는 수정하지 않기로 결정)한 것입니다. 다시 지적하지 않고, summary에서도 언급하지 않습니다.
- 증분 리뷰에서는 이번에 바뀐 부분만 평가하고, PR 전체를 다시 요약하지 않습니다.
- 지적할 것이 없으면 comments는 빈 배열로 두고 summary에 짧게 적습니다.

팀 리뷰 기준:
${s.guidelines.trim()}`;
}

interface ReviewScope {
  mode: "full" | "incremental";
  from?: string; // last reviewed SHA for incremental
}

const oneLine = (body: string, max: number) =>
  body.replace(AGENT_MARKER, "").replace(/\s+/g, " ").trim().slice(0, max);
const where = (t: GhThread) => (t.line === null ? `${t.path} (위치 변경됨)` : `${t.path}:${t.line}`);

interface FixedThread {
  thread: GhThread;
  reason: string;
}

/** Open threads get short ids the model can return; resolved ones are context only. */
function priorSection(open: Map<string, GhThread>, closed: GhThread[]): string {
  let out = "";
  if (open.size) {
    const lines = [...open].map(([id, t]) => `- [${id}] ${where(t)} — ${oneLine(t.body, 300)}`).join("\n");
    out += `\n\n열린 이전 지적 (아직 처리 안 됨, 반복 금지, 고쳐졌으면 resolved_threads에 id 기재):\n${lines}`;
  }
  if (closed.length) {
    const lines = closed
      .slice(0, MAX_CLOSED_IN_PROMPT)
      .map((t) => `- ${where(t)} — ${oneLine(t.body, 150)}`)
      .join("\n");
    out += `\n\n결론 난 이전 지적 (사람이 resolve함, 다시 꺼내지 말 것):\n${lines}`;
  }
  return out;
}

function userPrompt(
  pr: GhPull,
  repo: string,
  diff: PreparedDiff,
  scope: ReviewScope,
  open: Map<string, GhThread>,
  closed: GhThread[],
): string {
  const body = (pr.body ?? "").slice(0, 4000);
  const files = diff.files
    .map((f) => `### ${f.path} (${f.status})\n\`\`\`diff\n${f.text}\n\`\`\``)
    .join("\n\n");
  const skipped = diff.skipped.length ? `\n\n리뷰에서 제외된 파일: ${diff.skipped.join(", ")}` : "";
  const range =
    scope.mode === "incremental"
      ? `증분 리뷰: 마지막 리뷰 커밋 ${short(scope.from!)} 이후 새로 푸시된 변경만 보여줍니다 (${short(scope.from!)}..${short(pr.head.sha)}).`
      : "전체 리뷰: PR의 전체 변경을 보여줍니다.";
  return `레포: ${repo}
PR #${pr.number}: ${pr.title}
작성자: ${pr.user.login}
브랜치: ${pr.head.ref} -> ${pr.base.ref}
${range}

PR 설명:
${body || "(없음)"}${priorSection(open, closed)}

변경 사항 (라인 번호는 새 파일 기준):

${files}${skipped}`;
}

function formatComment(c: ModelComment): string {
  return `**${SEVERITY_LABEL[c.severity] ?? c.severity}** ${c.body}\n\n${AGENT_MARKER}`;
}

function buildReviewBody(
  summary: string,
  stray: ModelComment[],
  diff: PreparedDiff,
  model: string,
  sha: string,
  scope: ReviewScope,
  duplicates: number,
  fixed: FixedThread[],
  autoResolved: boolean,
): string {
  const title = scope.mode === "incremental" ? "## 🤖 PR Review Agent (추가 커밋 리뷰)" : "## 🤖 PR Review Agent";
  const parts = [`${title}\n\n${summary.trim()}`];
  if (fixed.length) {
    const heading = autoResolved
      ? `### ✅ 수정 확인된 이전 지적 (${fixed.length}개, resolve 처리함)`
      : `### ✅ 수정된 것으로 보이는 이전 지적 (${fixed.length}개, 자동 resolve 꺼져 있음)`;
    parts.push(
      heading + "\n" + fixed.map(({ thread, reason }) => `- \`${where(thread)}\` ${oneLine(thread.body, 80)}\n  → ${reason}`).join("\n"),
    );
  }
  if (stray.length) {
    parts.push(
      "### 기타 지적사항\n" +
        stray.map((c) => `- \`${c.path}:${c.line}\` **${SEVERITY_LABEL[c.severity] ?? c.severity}** ${c.body}`).join("\n"),
    );
  }
  const meta = [`model: ${model}`];
  meta.push(scope.mode === "incremental" ? `range: ${short(scope.from!)}..${short(sha)}` : `commit: ${short(sha)}`);
  if (diff.skipped.length) meta.push(`제외 파일 ${diff.skipped.length}개`);
  if (duplicates) meta.push(`중복 지적 ${duplicates}개 생략`);
  if (fixed.length) meta.push(`이전 지적 ${fixed.length}개 수정 확인`);
  parts.push(`<sub>${meta.join(" · ")}</sub>`);
  return parts.join("\n\n");
}

/**
 * Picks what to review. When this PR was reviewed before at an ancestor commit, only the
 * new commits are reviewed; files are limited to those still in the PR so changes merged
 * in from the base branch are not reviewed as if the author wrote them.
 * Force-push / rebase (not "ahead") falls back to a full review.
 */
async function resolveScope(
  gh: GitHub,
  repo: string,
  pr: GhPull,
  prFiles: GhFile[],
  last: string | undefined,
  forceFull: boolean,
  log: LogFn,
): Promise<{ scope: ReviewScope; files: GhFile[] }> {
  if (forceFull || !last || last === pr.head.sha) return { scope: { mode: "full" }, files: prFiles };
  try {
    const cmp = await gh.compare(repo, last, pr.head.sha);
    if (cmp.status === "ahead" && cmp.files) {
      const inPr = new Set(prFiles.map((f) => f.filename));
      return {
        scope: { mode: "incremental", from: last },
        files: cmp.files.filter((f) => inPr.has(f.filename)),
      };
    }
    log(`${repo}#${pr.number} 이전 리뷰 커밋과 이어지지 않음 (${cmp.status}, force-push 추정) → 전체 리뷰`);
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 404)) throw e;
    log(`${repo}#${pr.number} 이전 리뷰 커밋을 찾을 수 없음 (force-push 추정) → 전체 리뷰`);
  }
  return { scope: { mode: "full" }, files: prFiles };
}

export interface ReviewOptions {
  /** Review the whole PR even if an earlier commit was reviewed (manual review by URL). */
  full?: boolean;
}

/** PRs with a review in progress. A second request for the same PR (double click, or a
 *  poll overlapping a manual review) is dropped instead of posting a second review. */
const inFlight = new Set<string>();

/** Review one PR at its current head and (unless dry-run) post a COMMENT review. */
export async function reviewPull(repo: string, pr: GhPull, log: LogFn, opts: ReviewOptions = {}): Promise<HistoryEntry> {
  const key = prKey(repo, pr.number);
  if (inFlight.has(key)) {
    log(`${key} 이미 리뷰 진행 중 → 중복 요청 무시`);
    return {
      time: new Date().toISOString(),
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      sha: pr.head.sha,
      status: "skipped",
      commentCount: 0,
      summary: "이미 리뷰가 진행 중입니다.",
    };
  }
  inFlight.add(key);
  try {
    return await reviewPullLocked(repo, pr, log, opts);
  } finally {
    inFlight.delete(key);
  }
}

async function reviewPullLocked(repo: string, pr: GhPull, log: LogFn, opts: ReviewOptions): Promise<HistoryEntry> {
  const settings = await config.settings();
  const key = prKey(repo, pr.number);
  const entry: HistoryEntry = {
    time: new Date().toISOString(),
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    sha: pr.head.sha,
    status: "error",
    commentCount: 0,
    summary: "",
  };
  try {
    if (!settings.model) throw new Error("Claude 모델이 선택되지 않았습니다 (설정 탭).");
    const { gh, claude } = await clients();

    const [prFiles, threads, reviewed] = await Promise.all([
      gh.listPullFiles(repo, pr.number),
      gh.listReviewThreads(repo, pr.number),
      config.reviewed(),
    ]);
    const { scope, files } = await resolveScope(gh, repo, pr, prFiles, reviewed[key], !!opts.full, log);
    entry.mode = scope.mode;

    const diff = prepareDiff(files, settings.maxDiffChars);
    if (diff.files.length === 0) {
      entry.status = "skipped";
      entry.summary = "리뷰할 코드 변경이 없습니다 (lock/빌드/바이너리 파일만 변경되었거나 삭제만 있음).";
      log(`${key} 건너뜀: 리뷰할 코드 변경 없음`);
      await config.markReviewed(key, pr.head.sha);
      await config.addHistory(entry);
      return entry;
    }

    log(`${key} ${scope.mode === "incremental" ? `증분 리뷰 시작 (${short(scope.from!)}..${short(pr.head.sha)})` : "리뷰 시작"}: ${pr.title}`);

    // Newest first, so the prompt caps keep the most recent context.
    const agentThreads = threads.filter((t) => isAgentComment(t.body)).reverse();
    const open = new Map<string, GhThread>();
    agentThreads
      .filter((t) => !t.isResolved)
      .slice(0, MAX_PRIOR_IN_PROMPT)
      .forEach((t, i) => open.set(`T${i + 1}`, t));
    const closed = agentThreads.filter((t) => t.isResolved);
    // Duplicate check covers resolved threads too: a point the team closed must not come back.
    const prior: PriorComment[] = agentThreads.map((t) => ({ path: t.path, line: t.line, body: t.body }));

    const result = await claude.review(
      settings.model,
      systemPrompt(settings),
      userPrompt(pr, repo, diff, scope, open, closed),
    );

    // Only trust "fixed" for threads whose file the model actually saw in this diff.
    const seen = new Set(diff.files.map((f) => f.path));
    const toResolve: FixedThread[] = result.resolved
      .map((r) => ({ thread: open.get(r.id), reason: r.reason }))
      .filter((r): r is FixedThread => !!r.thread && seen.has(r.thread.path));

    const fresh = result.comments.filter((c) => !isDuplicate(c, prior));
    const duplicates = result.comments.length - fresh.length;

    // Anchor against the PR diff (not the compare diff): GitHub only accepts lines in the PR's own hunks.
    const anchorable = new Map<string, Set<number>>();
    for (const f of prFiles) if (f.patch) anchorable.set(f.filename, annotatePatch(f.patch).validLines);
    const anchored: ReviewComment[] = [];
    const stray: ModelComment[] = [];
    for (const c of fresh) {
      if (anchorable.get(c.path)?.has(c.line)) {
        anchored.push({ path: c.path, line: c.line, side: "RIGHT", body: formatComment(c) });
      } else {
        stray.push(c);
      }
    }

    entry.summary = result.summary;
    entry.commentCount = fresh.length;
    entry.duplicateCount = duplicates;
    const dupNote = duplicates ? `, 중복 ${duplicates}개 생략` : "";
    const autoResolve = settings.autoResolve && !settings.dryRun;

    if (settings.dryRun) {
      entry.status = "dry-run";
      const fixNote = toResolve.length ? `, 수정 확인 ${toResolve.length}개` : "";
      log(`${key} 드라이런: 코멘트 ${fresh.length}개${dupNote}${fixNote} (게시·resolve 안 함)`);
      for (const { thread, reason } of toResolve) log(`${key}   수정 확인 ${where(thread)}: ${reason}`);
    } else {
      // Resolve first so the review body lists only threads that were actually resolved.
      // One failure does not stop the rest.
      const fixed: FixedThread[] = [];
      if (autoResolve) {
        for (const f of toResolve) {
          try {
            await gh.replyAndResolve(
              f.thread.id,
              `✅ 수정 확인: ${f.reason}\n\n<sub>commit ${short(pr.head.sha)} 기준 · PR Review Agent</sub>\n\n${AGENT_MARKER}`,
            );
            fixed.push(f);
          } catch (e) {
            log(`${key} ${where(f.thread)} resolve 실패: ${e instanceof Error ? e.message : e}`);
          }
        }
        entry.resolvedCount = fixed.length;
        if (fixed.length) log(`${key} 수정 확인된 이전 지적 ${fixed.length}개 resolve`);
      } else {
        fixed.push(...toResolve);
      }

      if (fresh.length === 0 && fixed.length === 0 && (scope.mode === "incremental" || reviewed[key] === pr.head.sha)) {
        // A follow-up push, or a re-run on an already reviewed commit, with nothing new to say
        // would only add a second summary to the PR.
        entry.status = "skipped";
        log(`${key} 새 지적·수정 확인 없음${dupNote} → 리뷰 게시 안 함 (요약은 이력에 저장)`);
      } else {
        const body = (s: ModelComment[]) =>
          buildReviewBody(result.summary, s, diff, settings.model, pr.head.sha, scope, duplicates, fixed, autoResolve);
        try {
          await gh.createReview(repo, pr.number, pr.head.sha, body(stray), anchored);
        } catch (e) {
          // 422 = GitHub could not resolve a line; retry with everything in the body.
          if (!(e instanceof GitHubError && e.status === 422) || anchored.length === 0) throw e;
          log(`${key} 라인 코멘트 실패(422), 본문으로 합쳐 재시도`);
          await gh.createReview(repo, pr.number, pr.head.sha, body(fresh), []);
        }
        entry.status = "posted";
        const fixNote = fixed.length ? `, 수정 확인 ${fixed.length}개` : "";
        log(`${key} 리뷰 게시 완료: 코멘트 ${fresh.length}개${dupNote}${fixNote}`);
      }
    }
    await config.markReviewed(key, pr.head.sha);
  } catch (e) {
    entry.error = e instanceof Error ? e.message : String(e);
    await config.recordFailure(key, pr.head.sha);
    log(`${key} 실패: ${entry.error}`);
  }
  await config.addHistory(entry);
  return entry;
}

/** Mark all currently open PRs of a repo as seen, so only new pushes get reviewed. */
export async function markExistingAsSeen(repo: string, log: LogFn): Promise<number> {
  const { gh } = await clients();
  const pulls = await gh.listOpenPulls(repo);
  for (const p of pulls) await config.markReviewed(prKey(repo, p.number), p.head.sha);
  log(`${repo}: 기존 열린 PR ${pulls.length}개는 건너뜀 (이후 새 커밋부터 리뷰)`);
  return pulls.length;
}

let running = false;
export const isRunning = () => running;

/** "key@sha" already logged as skipped by a rule, so each poll does not repeat the log line.
 *  Not persisted: removing the label later makes the PR reviewable on the next poll. */
const skipLogged = new Set<string>();

/** One polling pass over all enabled repos. Concurrent calls are ignored. */
export async function runPoll(log: LogFn): Promise<void> {
  if (running) return;
  running = true;
  try {
    const repos = (await config.repos()).filter((r) => r.enabled);
    if (repos.length === 0) {
      log("활성화된 레포가 없습니다.");
      return;
    }
    const { gh } = await clients();
    const settings = await config.settings();
    let reviewedCount = 0;
    for (const repo of repos) {
      let pulls: GhPull[];
      try {
        pulls = await gh.listOpenPulls(repo.fullName);
      } catch (e) {
        log(`${repo.fullName} PR 조회 실패: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      const [reviewed, failures] = await Promise.all([config.reviewed(), config.failures()]);
      for (const pr of pulls) {
        const key = prKey(repo.fullName, pr.number);
        if (!matchesBase(repo.baseBranches, pr.base.ref)) continue;
        if (reviewed[key] === pr.head.sha) continue;
        const why = skipReason(
          { title: pr.title, draft: pr.draft, author: pr.user.login, labels: (pr.labels ?? []).map((l) => l.name) },
          settings.skipLabels,
          settings.skipAuthors,
        );
        if (why) {
          const mark = `${key}@${pr.head.sha}`;
          if (!pr.draft && !skipLogged.has(mark)) log(`${key} 건너뜀: ${why}`);
          skipLogged.add(mark);
          continue;
        }
        const f = failures[key];
        if (f && f.sha === pr.head.sha && f.count >= MAX_ATTEMPTS) continue;
        await reviewPull(repo.fullName, pr, log);
        reviewedCount++;
      }
    }
    log(reviewedCount ? `확인 완료: ${reviewedCount}개 리뷰` : "확인 완료: 새 PR/커밋 없음");
  } catch (e) {
    log(`확인 실패: ${e instanceof Error ? e.message : e}`);
  } finally {
    await config.setLastCheck(new Date().toISOString());
    running = false;
  }
}
