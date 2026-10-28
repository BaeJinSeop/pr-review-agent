import { Claude, type ModelComment, type Severity } from "./claude";
import { config, type HistoryEntry, type Settings } from "./config";
import { prepareDiff, type PreparedDiff } from "./diff";
import { GitHub, GitHubError, type GhPull, type ReviewComment } from "./github";
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

export async function clients(): Promise<{ gh: GitHub; claude: Claude }> {
  const [token, key] = await Promise.all([secrets.get("github_token"), secrets.get("anthropic_api_key")]);
  if (!token) throw new Error("GitHub 토큰이 설정되지 않았습니다 (설정 탭).");
  if (!key) throw new Error("Claude API 키가 설정되지 않았습니다 (설정 탭).");
  return { gh: new GitHub(token), claude: new Claude(key) };
}

const prKey = (repo: string, n: number) => `${repo}#${n}`;

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
- 지적할 것이 없으면 comments는 빈 배열로 두고 summary에 짧게 적습니다.

팀 리뷰 기준:
${s.guidelines.trim()}`;
}

function userPrompt(pr: GhPull, repo: string, diff: PreparedDiff): string {
  const body = (pr.body ?? "").slice(0, 4000);
  const files = diff.files
    .map((f) => `### ${f.path} (${f.status})\n\`\`\`diff\n${f.text}\n\`\`\``)
    .join("\n\n");
  const skipped = diff.skipped.length ? `\n\n리뷰에서 제외된 파일: ${diff.skipped.join(", ")}` : "";
  return `레포: ${repo}
PR #${pr.number}: ${pr.title}
작성자: ${pr.user.login}
브랜치: ${pr.head.ref} -> ${pr.base.ref}

PR 설명:
${body || "(없음)"}

변경 사항 (라인 번호는 새 파일 기준):

${files}${skipped}`;
}

function formatComment(c: ModelComment): string {
  return `**${SEVERITY_LABEL[c.severity] ?? c.severity}** ${c.body}`;
}

function buildReviewBody(
  summary: string,
  stray: ModelComment[],
  diff: PreparedDiff,
  model: string,
  sha: string,
): string {
  const parts = [`## 🤖 PR Review Agent\n\n${summary.trim()}`];
  if (stray.length) {
    parts.push(
      "### 기타 지적사항\n" + stray.map((c) => `- \`${c.path}:${c.line}\` ${formatComment(c)}`).join("\n"),
    );
  }
  const meta = [`model: ${model}`, `commit: ${sha.slice(0, 7)}`];
  if (diff.skipped.length) meta.push(`제외 파일 ${diff.skipped.length}개`);
  parts.push(`<sub>${meta.join(" · ")}</sub>`);
  return parts.join("\n\n");
}

/** Review one PR at its current head and (unless dry-run) post a COMMENT review. */
export async function reviewPull(repo: string, pr: GhPull, log: LogFn): Promise<HistoryEntry> {
  const settings = await config.settings();
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
    log(`${repo}#${pr.number} 리뷰 시작: ${pr.title}`);

    const files = await gh.listPullFiles(repo, pr.number);
    const diff = prepareDiff(files, settings.maxDiffChars);
    if (diff.files.length === 0) throw new Error("리뷰할 수 있는 변경 파일이 없습니다.");

    const result = await claude.review(settings.model, systemPrompt(settings), userPrompt(pr, repo, diff));

    // Only lines present in the diff can be anchored; the rest go into the review body.
    const byPath = new Map(diff.files.map((f) => [f.path, f.validLines]));
    const anchored: ReviewComment[] = [];
    const stray: ModelComment[] = [];
    for (const c of result.comments) {
      if (byPath.get(c.path)?.has(c.line)) {
        anchored.push({ path: c.path, line: c.line, side: "RIGHT", body: formatComment(c) });
      } else {
        stray.push(c);
      }
    }

    entry.summary = result.summary;
    entry.commentCount = result.comments.length;

    if (settings.dryRun) {
      entry.status = "dry-run";
      log(`${repo}#${pr.number} 드라이런: 코멘트 ${result.comments.length}개 (게시 안 함)`);
    } else {
      try {
        await gh.createReview(
          repo,
          pr.number,
          pr.head.sha,
          buildReviewBody(result.summary, stray, diff, settings.model, pr.head.sha),
          anchored,
        );
      } catch (e) {
        // 422 = GitHub could not resolve a line; retry with everything in the body.
        if (!(e instanceof GitHubError && e.status === 422) || anchored.length === 0) throw e;
        log(`${repo}#${pr.number} 라인 코멘트 실패(422), 본문으로 합쳐 재시도`);
        await gh.createReview(
          repo,
          pr.number,
          pr.head.sha,
          buildReviewBody(result.summary, result.comments, diff, settings.model, pr.head.sha),
          [],
        );
      }
      entry.status = "posted";
      log(`${repo}#${pr.number} 리뷰 게시 완료: 코멘트 ${result.comments.length}개`);
    }
    await config.markReviewed(prKey(repo, pr.number), pr.head.sha);
  } catch (e) {
    entry.error = e instanceof Error ? e.message : String(e);
    await config.recordFailure(prKey(repo, pr.number), pr.head.sha);
    log(`${repo}#${pr.number} 실패: ${entry.error}`);
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
        if (pr.draft) continue;
        if (!matchesBase(repo.baseBranches, pr.base.ref)) continue;
        if (reviewed[key] === pr.head.sha) continue;
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
