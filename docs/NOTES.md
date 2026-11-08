# 작업 메모 (맥락 이어가기용)

마지막 갱신: 2026-11-09

## 현재 상태

- 최신 릴리스 **v0.1.4** (2026-11-08, Latest). `origin/main` = `2adc6c7`(v0.1.4).
- GitHub Releases: v0.1.4(Latest), v0.1.3, v0.1.0 모두 게시됨.
  `v0.1.2` 태그는 원격에 있지만 Release는 없음(태그가 버전 0.1.1 커밋 `ad3456d`를 가리켜 workflow 실패). 그대로 둠.
- 작업 위치: Orca 워크트리 `~/orca/workspaces/pr-review-agent/main`(브랜치 `feature/develop`), 푸시는 `git push origin HEAD:main`.
- 앱 설정 파일: `~/Library/Application Support/com.intocns.prreviewagent/config.json`
  (켜진 레포, 리뷰한 SHA, 실패 횟수, 이력, 월별 Claude 사용량).
- 레포 위치: 2026-11-06에 `~/project/IntoProject/pr-review-agent` → `~/project/BaeJinseop/pr-review-agent`로 이동.
  `~/.gitconfig`의 `includeIf "gitdir:~/project/BaeJinseop/"`로 커밋은 개인 계정 BaeJinSeop, 통신은 개인 SSH 키.
  옛 경로는 새 경로를 가리키는 심볼릭 링크(Orca가 옛 경로로 등록돼 있고 경로 변경 CLI가 없음).
  Orca 앱에서 새 경로로 다시 등록하면 링크 삭제. 원격 `js8ae/pr-review-agent`는 BaeJinSeop 레포로 리다이렉트됨
  (`gh -R`에는 `BaeJinSeop/pr-review-agent`).

## 릴리스 방법

1. 버전을 5개 파일에서 올림: `package.json`, `package-lock.json`(2곳), `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`(pr-review-agent 항목). 커밋 메시지 `v0.1.x`.
2. `git push origin HEAD:main && git tag v0.1.x && git push origin v0.1.x`
3. `.github/workflows/release.yml`이 태그와 `tauri.conf.json` version이 같은지 검사한 뒤(다르면 실패),
   macOS universal DMG + Windows exe/msi를 Draft Release로 올림(약 8분).
4. `gh release edit v0.1.x -R BaeJinSeop/pr-review-agent --draft=false --latest`로 게시.

이미 올린 태그는 재사용하지 않고 다음 버전으로 올린다(v0.1.2 실패 → v0.1.3으로 해결한 방식).
README의 릴리스 안내는 아직 `tauri.conf.json`만 언급함(5개 파일로 고칠 것).

## 버전별 변경

- **v0.1.1**: PR 단위 잠금, 수정 확인된 이전 지적 resolve, Claude 응답 파싱 보강,
  "수정 확인된 이전 지적" 섹션, 폴링 때 건너뛴 이유 로그.
- **v0.1.3** (2026-11-06):
  - `cf01b05` 리뷰 0개일 때 켜지 않은 레포의 열린 PR을 확인 로그에 붙임(`/search/issues` `user:<owner>`, 최대 5개).
  - `5966d57` 레포를 켤 때 기존 PR 건너뛰기(기본 켜짐) + 토스트 "N개 지금 리뷰" 버튼(15초).
  - `beb902d` 강제 `tool_choice` 미지원 모델을 `autoOnlyModels`에 저장(나중에 지원돼도 계속 auto, 지우려면 config 편집).
  - `cd511d7` Fine-grained PAT은 owner 한 곳만 보임 → 안내/에러 힌트로 대응.
  - `6b55baf` 자동 확인 후 대시보드 "마지막 확인"이 갱신되지 않던 문제.
  - `d7eeef9` 레포를 켜고 꺼도 "N개 활성" 숫자가 그대로이던 문제.
- **v0.1.4** (2026-11-08): 아래 세 가지.

## v0.1.4: 중복 리뷰 방지 (`3232e2f`)

여러 사람이 같은 레포를 켜도 커밋당 에이전트 리뷰는 하나.
- 판별: PR 리뷰 목록(`/pulls/{n}/reviews`)에서 `commit_id === head sha` 이고 본문이 `## 🤖 PR Review Agent`로 시작하면
  누구 계정이든 이미 리뷰됨. 실제 PR(Intocns/IntovetCloudMobile-API#5)의 리뷰 데이터로 규칙 확인.
- 리뷰 시작 전 확인 → 있으면 건너뜀(이력에 "OO님이 먼저 리뷰", `reviewed`에 기록).
  Claude 호출 후 게시 직전 다시 확인 → 그 사이 누가 올렸으면 게시 안 함(드라이런은 생략).
- PR URL 수동 리뷰는 이미 있으면 토스트에 "그래도 리뷰"(force).
- 예전 설계의 "내 PR / 리뷰 요청된 PR만" 옵션은 넣지 않음: 작성자와 리뷰어가 둘 다 앱을 쓰면 그 옵션이 오히려 중복을 만듦.
- 한계: 두 앱이 몇 초 차이로 동시에 게시하면 둘 다 올라갈 수 있음. 게시 직전에 밀린 쪽은 Claude 비용을 이미 씀.
- 앱에서 직접 본 건 정상 흐름만. "이미 리뷰됨" 건너뜀/"그래도 리뷰" 토스트는 화면에서 아직 못 봄
  (PR URL에 `https://github.com/Intocns/IntovetCloudMobile-API/pull/5` 넣고 리뷰하면 볼 수 있음).

## v0.1.4: Claude 비용 표시 (`4545e09`)

- 응답의 `usage`(input/output 토큰)를 이력 각 줄에 `토큰 74.0k/5.7k · $0.411`로 표시.
- 대시보드 "이번 달 Claude 비용 (추정)": config `monthlyUsage`("YYYY-MM" → 합계)에 누적. 이력을 지워도 남음.
  파싱 실패한 응답도 과금되므로 파싱 전에 기록.
- 가격표는 `src/lib/pricing.ts`(2026-10 정가, 캐시/배치 할인 없음). 표에 없는 모델은 "가격 미상", 토큰만 누적.
  새 모델을 고르면 표에 한 줄 추가.
- 검증: IntocnsAdmin#9 드라이런 리뷰 1회 = 입력 73,954 / 출력 5,742 토큰, $0.41 (claude-opus-5-5).

## v0.1.4: 창을 숨겨도 자동 확인 유지 (`6fa8d03`)

- 원인: 확인 작업은 웹뷰(JS)에서 도는데, macOS WebKit이 숨겨지거나 가려진 웹뷰를 기본으로 일시정지시킴.
  Rust 타이머가 `poll-tick`을 보내도 JS가 받지 못해, 창을 트레이로 보내면 자동 리뷰가 멈출 수 있었음.
- 수정: `tauri.conf.json` 창 설정에 `"backgroundThrottling": "disabled"` (macOS 14+, Tauri 2.12).
- 검증: 수정 전 창이 가려진 8분 동안 확인 0번 → 수정 후 창을 숨긴 7분 동안 매분 7번.
- Windows는 이 설정을 지원하지 않음. Windows에서 창을 숨겨도 도는지는 미확인.

## 앱 실행 검증 방법

- `npx tauri dev --config '{"identifier":"com.intocns.prreviewagent.devcheck"}'`로 실제 설정과 분리(키체인 토큰/키는 공유).
  먼저 `~/Library/Application Support/com.intocns.prreviewagent.devcheck/config.json`에
  `{"settings":{"model":"claude-opus-5-5","pollMinutes":1,"dryRun":true},"repos":[...]}`를 넣고 실행. 끝나면 폴더 삭제.
- 열린 PR이 없는 레포(예: `BaeJinSeop/pr-review-agent`)를 켜면 Claude 비용 없이 자동 확인만 볼 수 있음(`lastCheck` 갱신).
- 터미널에 손쉬운 사용 권한이 없어 클릭은 사람이 함. 되는 것:
  - 창 앞으로: `osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is <PID>) to true'`
  - 창 숨기기: 같은 방식으로 `set visible of ... to false`
  - 창 id: `CGWindowListCopyWindowInfo`(swift 스크립트), 캡처: `screencapture -x -o -l <창 id>`

## 다음 후보 (2026-11-08 제안 목록 중 남은 것)

- 앱 자동 업데이트(Tauri updater): 업데이트용 서명 키 + workflow 수정. Apple 서명 없이 가능.
- 리뷰 품질: 변경 파일 전체(또는 주변 수십 줄) 맥락 제공(토큰 증가, 비용 표시로 확인하며 진행),
  `maxDiffChars`(12만 자) 넘는 큰 PR을 파일 묶음으로 나눠 리뷰.
- 에이전트 코멘트에 작성자가 답글 달면 재답변.
- 리뷰 게시/critical 지적 시 macOS 알림.
- 테스트(vitest): `annotatePatch`, 중복 지적 판별, `estimateUsd` 같은 순수 함수부터.
- Actions Node 20 경고: `actions/checkout`, `actions/setup-node`를 v5로.
- Developer ID 서명·공증(Apple Developer 가입 후 workflow에 추가).
