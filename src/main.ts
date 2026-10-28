import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Claude } from "./lib/claude";
import { config, DEFAULT_GUIDELINES, type RepoConfig, type Settings } from "./lib/config";
import { GitHub, parsePullUrl, type GhRepo } from "./lib/github";
import { clients, isRunning, markExistingAsSeen, reviewPull, runPoll } from "./lib/reviewer";
import { secrets, type SecretKey } from "./lib/secrets";

// ---------- helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ko-KR") : "-");

function toast(msg: string, kind: "ok" | "err" = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout((toast as any).timer);
  (toast as any).timer = setTimeout(() => (t.hidden = true), 3500);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- state ----------
const logs: string[] = [];
let ghLogin: string | null = null;
let ghRepos: GhRepo[] = [];
let repoFilter = "";

function log(msg: string) {
  logs.unshift(`[${new Date().toLocaleTimeString("ko-KR")}] ${msg}`);
  logs.length = Math.min(logs.length, 200);
  const el = document.getElementById("log");
  if (el) el.textContent = logs.join("\n");
  if (!isRunning()) void renderHistory();
}

// ---------- tabs ----------
document.querySelectorAll<HTMLButtonElement>("nav.tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("nav.tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll<HTMLElement>("main > section").forEach((s) => (s.hidden = s.id !== `tab-${b.dataset.tab}`));
    if (b.dataset.tab === "dashboard") void renderDashboard();
    if (b.dataset.tab === "repos") void renderRepos();
    if (b.dataset.tab === "settings") void renderSettings();
  }),
);

// external links
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a[data-href]") as HTMLAnchorElement | null;
  if (a) {
    e.preventDefault();
    void openUrl(a.dataset.href!);
  }
});

// ---------- dashboard ----------
async function renderDashboard() {
  const [settings, repos, lastCheck, token, key] = await Promise.all([
    config.settings(),
    config.repos(),
    config.lastCheck(),
    secrets.get("github_token"),
    secrets.get("anthropic_api_key"),
  ]);
  const enabled = repos.filter((r) => r.enabled).length;
  const ready = !!token && !!key && !!settings.model && enabled > 0;
  $("#tab-dashboard").innerHTML = `
    <div class="card status">
      <div><span class="label">GitHub</span>${token ? `<span class="ok">연결됨${ghLogin ? ` (${esc(ghLogin)})` : ""}</span>` : `<span class="bad">토큰 없음</span>`}</div>
      <div><span class="label">Claude</span>${key ? `<span class="ok">${esc(settings.model || "모델 미선택")}</span>` : `<span class="bad">API 키 없음</span>`}</div>
      <div><span class="label">활성 레포</span>${enabled}개</div>
      <div><span class="label">확인 주기</span>${settings.pollMinutes}분</div>
      <div><span class="label">마지막 확인</span>${fmtTime(lastCheck)}</div>
      <div><span class="label">모드</span>${settings.dryRun ? `<span class="warn">드라이런 (게시 안 함)</span>` : "PR에 코멘트 게시"}</div>
    </div>
    ${ready ? "" : `<p class="hint">설정 탭에서 토큰·API 키·모델을 저장하고, 레포 탭에서 대상 레포를 켜면 자동 리뷰가 시작됩니다.</p>`}
    <div class="row">
      <button id="check-now" ${ready ? "" : "disabled"}>지금 확인</button>
      <input id="pr-url" placeholder="https://github.com/owner/repo/pull/123" />
      <button id="review-url">이 PR 리뷰</button>
    </div>
    <h3>로그</h3>
    <pre id="log" class="log">${esc(logs.join("\n"))}</pre>
    <div class="row between"><h3>리뷰 이력</h3><button class="ghost" id="clear-history">이력 지우기</button></div>
    <div id="history"></div>`;

  $("#check-now").onclick = async () => {
    log("수동 확인 시작");
    await runPoll(log);
    await renderDashboard();
  };
  $("#review-url").onclick = async () => {
    const btn = $<HTMLButtonElement>("#review-url");
    if (btn.disabled) return;
    const parsed = parsePullUrl($<HTMLInputElement>("#pr-url").value);
    if (!parsed) return toast("PR URL 형식이 아닙니다.", "err");
    btn.disabled = true;
    btn.textContent = "리뷰 중...";
    try {
      const { gh } = await clients();
      const pr = await gh.getPull(parsed.repo, parsed.number);
      const r = await reviewPull(parsed.repo, pr, log, { full: true });
      toast(
        r.status === "error" ? `실패: ${r.error}` : r.status === "skipped" ? `건너뜀: ${r.summary}` : "리뷰 완료",
        r.status === "error" ? "err" : "ok",
      );
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "이 PR 리뷰";
    }
    await renderHistory();
  };
  $("#clear-history").onclick = async () => {
    await config.clearHistory();
    await renderHistory();
  };
  await renderHistory();
}

async function renderHistory() {
  const el = document.getElementById("history");
  if (!el) return;
  const history = await config.history();
  if (history.length === 0) {
    el.innerHTML = `<p class="hint">아직 리뷰 이력이 없습니다.</p>`;
    return;
  }
  const label = { posted: "게시됨", "dry-run": "드라이런", skipped: "건너뜀", error: "실패" } as const;
  el.innerHTML = history
    .map(
      (h) => `
    <details class="card hist ${h.status}">
      <summary>
        <span class="badge ${h.status}">${label[h.status]}</span>
        <a href="#" data-href="${esc(h.url)}">${esc(h.repo)}#${h.number}</a>
        <span class="title">${esc(h.title)}</span>
        <span class="meta">${h.mode === "incremental" ? "증분 · " : ""}코멘트 ${h.commentCount}${h.duplicateCount ? ` (중복 ${h.duplicateCount} 생략)` : ""}${h.resolvedCount ? ` · 수정 확인 ${h.resolvedCount}` : ""} · ${esc(h.sha.slice(0, 7))} · ${fmtTime(h.time)}</span>
      </summary>
      ${h.error ? `<pre class="err">${esc(h.error)}</pre>` : ""}
      ${h.summary ? `<pre class="summary">${esc(h.summary)}</pre>` : ""}
    </details>`,
    )
    .join("");
}

// ---------- repos ----------
async function renderRepos() {
  const repos = await config.repos();
  const configured = new Map(repos.map((r) => [r.fullName, r]));
  const names = new Set([...ghRepos.filter((r) => !r.archived).map((r) => r.full_name), ...configured.keys()]);
  const meta = new Map(ghRepos.map((r) => [r.full_name, r]));
  const list = [...names]
    .filter((n) => n.toLowerCase().includes(repoFilter.toLowerCase()))
    .sort((a, b) => Number(!!configured.get(b)?.enabled) - Number(!!configured.get(a)?.enabled) || a.localeCompare(b));

  $("#tab-repos").innerHTML = `
    <div class="row">
      <button id="load-repos">GitHub에서 레포 불러오기</button>
      <input id="repo-filter" placeholder="검색" value="${esc(repoFilter)}" />
      <span class="hint">${repos.filter((r) => r.enabled).length}개 활성</span>
    </div>
    ${names.size === 0 ? `<p class="hint">"GitHub에서 레포 불러오기"를 눌러 토큰으로 접근 가능한 레포를 가져오세요.</p>` : ""}
    <table class="repos">
      <thead><tr><th>리뷰</th><th>레포</th><th>대상 base 브랜치 (쉼표 구분, 비우면 전체)</th></tr></thead>
      <tbody>
      ${list
        .map((n) => {
          const c = configured.get(n);
          const m = meta.get(n);
          return `<tr data-repo="${esc(n)}">
            <td><input type="checkbox" class="en" ${c?.enabled ? "checked" : ""} /></td>
            <td>${esc(n)} ${m?.private ? `<span class="badge">private</span>` : ""}</td>
            <td><input class="branches" value="${esc(c?.baseBranches ?? "")}" placeholder="${esc(m?.default_branch ? `전체 (예: ${m.default_branch})` : "전체")}" /></td>
          </tr>`;
        })
        .join("")}
      </tbody>
    </table>`;

  $("#load-repos").onclick = async () => {
    try {
      const token = await secrets.get("github_token");
      if (!token) return toast("먼저 설정 탭에서 GitHub 토큰을 저장하세요.", "err");
      ghRepos = await new GitHub(token).listRepos();
      toast(`레포 ${ghRepos.length}개를 불러왔습니다.`);
      await renderRepos();
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };
  const filter = $<HTMLInputElement>("#repo-filter");
  filter.oninput = () => {
    repoFilter = filter.value;
    void renderRepos().then(() => {
      const f = $<HTMLInputElement>("#repo-filter");
      f.focus();
      f.setSelectionRange(f.value.length, f.value.length);
    });
  };

  document.querySelectorAll<HTMLTableRowElement>("tr[data-repo]").forEach((tr) => {
    const name = tr.dataset.repo!;
    const en = $<HTMLInputElement>(".en", tr);
    const br = $<HTMLInputElement>(".branches", tr);
    const save = async (turnedOn: boolean) => {
      const all = await config.repos();
      const idx = all.findIndex((r) => r.fullName === name);
      const next: RepoConfig = { fullName: name, enabled: en.checked, baseBranches: br.value.trim() };
      if (idx >= 0) all[idx] = next;
      else all.push(next);
      await config.saveRepos(all.filter((r) => r.enabled || r.baseBranches));
      if (turnedOn && (await config.settings()).skipExistingOnAdd) {
        try {
          const n = await markExistingAsSeen(name, log);
          toast(`${name} 활성화 (기존 열린 PR ${n}개는 건너뜀)`);
        } catch (e) {
          toast(errMsg(e), "err");
        }
      }
    };
    en.onchange = () => void save(en.checked);
    br.onchange = () => void save(false);
  });
}

// ---------- settings ----------
function secretRow(key: SecretKey, label: string, help: string, saved: boolean) {
  return `
    <div class="field">
      <label>${label} ${saved ? `<span class="ok">저장됨</span>` : `<span class="bad">없음</span>`}</label>
      <div class="row">
        <input type="password" id="in-${key}" placeholder="${saved ? "새 값으로 바꾸려면 입력" : "입력"}" autocomplete="off" />
        <button data-save="${key}">저장</button>
        <button class="ghost" data-test="${key}">연결 테스트</button>
        <button class="ghost danger" data-del="${key}" ${saved ? "" : "disabled"}>삭제</button>
      </div>
      <p class="hint">${help}</p>
    </div>`;
}

async function renderSettings() {
  const [s, token, key] = await Promise.all([config.settings(), secrets.get("github_token"), secrets.get("anthropic_api_key")]);
  $("#tab-settings").innerHTML = `
    <h3>인증 정보 <span class="hint">(macOS 키체인 / Windows 자격 증명 관리자에 저장)</span></h3>
    ${secretRow(
      "github_token",
      "GitHub 토큰",
      "Fine-grained PAT 권장. Repository permissions: <b>Pull requests: Read and write</b>, <b>Contents: Read</b>. 조직 레포는 Resource owner를 조직으로 지정해야 합니다.",
      !!token,
    )}
    ${secretRow("anthropic_api_key", "Claude API 키", "console.anthropic.com 에서 발급한 API 키 (sk-ant-...)", !!key)}

    <h3>리뷰 설정</h3>
    <div class="field">
      <label>Claude 모델</label>
      <div class="row">
        <select id="model">${s.model ? `<option value="${esc(s.model)}">${esc(s.model)}</option>` : `<option value="">(모델 목록을 불러오세요)</option>`}</select>
        <button class="ghost" id="load-models">모델 목록 불러오기</button>
      </div>
    </div>
    <div class="grid2">
      <div class="field"><label>확인 주기 (분)</label><input type="number" id="poll" min="1" max="1440" value="${s.pollMinutes}" /></div>
      <div class="field"><label>최대 diff 크기 (문자)</label><input type="number" id="maxdiff" min="10000" step="10000" value="${s.maxDiffChars}" /></div>
    </div>
    <label class="check"><input type="checkbox" id="dryrun" ${s.dryRun ? "checked" : ""} /> 드라이런: 리뷰만 생성하고 PR에 게시하지 않음 (이력에서 확인)</label>
    <label class="check"><input type="checkbox" id="skipexisting" ${s.skipExistingOnAdd ? "checked" : ""} /> 레포를 켤 때 이미 열려 있는 PR은 건너뛰고 새 커밋부터 리뷰</label>
    <label class="check"><input type="checkbox" id="autoresolve" ${s.autoResolve ? "checked" : ""} /> 이전 지적이 수정된 게 확인되면 "수정 확인" 답글을 달고 스레드를 resolve (에이전트가 단 스레드만)</label>
    <div class="grid2">
      <div class="field"><label>리뷰 제외 라벨 (쉼표로 구분)</label><input type="text" id="skiplabels" value="${esc(s.skipLabels)}" /></div>
      <div class="field"><label>리뷰 제외 작성자 (쉼표로 구분)</label><input type="text" id="skipauthors" value="${esc(s.skipAuthors)}" /></div>
    </div>
    <p class="hint">draft PR, 제목에 [skip review] 또는 [no review]가 있는 PR, lock/빌드/바이너리 파일만 바뀐 PR도 리뷰하지 않습니다.</p>
    <div class="field">
      <div class="row between"><label>팀 리뷰 기준 (시스템 프롬프트에 포함)</label><button class="ghost" id="reset-guide">기본값으로</button></div>
      <textarea id="guidelines" rows="10">${esc(s.guidelines)}</textarea>
    </div>
    <button id="save-settings">설정 저장</button>`;

  document.querySelectorAll<HTMLButtonElement>("[data-save]").forEach((b) => {
    b.onclick = async () => {
      const k = b.dataset.save as SecretKey;
      const v = $<HTMLInputElement>(`#in-${k}`).value.trim();
      if (!v) return toast("값을 입력하세요.", "err");
      try {
        await secrets.set(k, v);
        toast("저장했습니다.");
        await renderSettings();
      } catch (e) {
        toast(errMsg(e), "err");
      }
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((b) => {
    b.onclick = async () => {
      await secrets.delete(b.dataset.del as SecretKey);
      if (b.dataset.del === "github_token") ghLogin = null;
      toast("삭제했습니다.");
      await renderSettings();
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-test]").forEach((b) => {
    b.onclick = async () => {
      const k = b.dataset.test as SecretKey;
      const typed = $<HTMLInputElement>(`#in-${k}`).value.trim();
      const v = typed || (await secrets.get(k));
      if (!v) return toast("테스트할 값이 없습니다.", "err");
      try {
        if (k === "github_token") {
          const me = await new GitHub(v).me();
          ghLogin = me.login;
          toast(`GitHub 연결 성공: ${me.login}`);
        } else {
          const models = await new Claude(v).listModels();
          toast(`Claude 연결 성공: 모델 ${models.length}개`);
        }
      } catch (e) {
        toast(errMsg(e), "err");
      }
    };
  });

  $("#load-models").onclick = async () => {
    try {
      const k = await secrets.get("anthropic_api_key");
      if (!k) return toast("먼저 Claude API 키를 저장하세요.", "err");
      const models = await new Claude(k).listModels();
      const current = $<HTMLSelectElement>("#model").value;
      $("#model").innerHTML = models
        .map((m) => `<option value="${esc(m.id)}" ${m.id === current ? "selected" : ""}>${esc(m.display_name)} (${esc(m.id)})</option>`)
        .join("");
      toast(`모델 ${models.length}개를 불러왔습니다. 고른 뒤 설정 저장을 누르세요.`);
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };
  $("#reset-guide").onclick = () => ($<HTMLTextAreaElement>("#guidelines").value = DEFAULT_GUIDELINES);

  $("#save-settings").onclick = async () => {
    const next: Settings = {
      model: $<HTMLSelectElement>("#model").value,
      pollMinutes: Math.min(1440, Math.max(1, Number($<HTMLInputElement>("#poll").value) || 10)),
      maxDiffChars: Math.max(10_000, Number($<HTMLInputElement>("#maxdiff").value) || 120_000),
      dryRun: $<HTMLInputElement>("#dryrun").checked,
      skipExistingOnAdd: $<HTMLInputElement>("#skipexisting").checked,
      guidelines: $<HTMLTextAreaElement>("#guidelines").value,
      skipLabels: $<HTMLInputElement>("#skiplabels").value,
      skipAuthors: $<HTMLInputElement>("#skipauthors").value,
      autoResolve: $<HTMLInputElement>("#autoresolve").checked,
    };
    await config.saveSettings(next);
    await invoke("set_poll_interval", { minutes: next.pollMinutes });
    toast("설정을 저장했습니다.");
  };
}

// ---------- boot ----------
async function boot() {
  const s = await config.settings();
  await invoke("set_poll_interval", { minutes: s.pollMinutes });
  await listen("poll-tick", () => void runPoll(log).then(() => void renderHistory()));
  const token = await secrets.get("github_token");
  if (token) {
    new GitHub(token)
      .me()
      .then((me) => {
        ghLogin = me.login;
        if (!$("#tab-dashboard").hidden) void renderDashboard();
      })
      .catch((e) => log(`GitHub 토큰 확인 실패: ${errMsg(e)}`));
  }
  await renderDashboard();
}

boot().catch((e) => toast(errMsg(e), "err"));
