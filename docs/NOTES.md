# 작업 메모 (맥락 이어가기용)

마지막 갱신: 2026-11-06

## 현재 상태

- 최신 커밋 `a58253d`, `origin/main`까지 푸시됨(이 레포는 커밋 후 자동으로 푸시되고 있음, 원인 미확인). 버전은 아직 `0.1.1`(`4b247be`)이고,
  그 뒤 운영 이슈 대응 커밋 4개가 올라감(아래 "운영 이슈 대응"). 릴리스 전에 버전을 0.1.2로 올릴지 결정 필요.
- `v0.1.1` 태그는 아직 만들지 않음. 릴리스하려면:
  ```bash
  git tag v0.1.1 && git push origin v0.1.1
  ```
  `.github/workflows/release.yml`이 macOS universal DMG와 Windows 설치 파일을 빌드해 Draft Release로 올린다.
- GitHub Releases에 v0.1.0이 아직 Draft로 남아 있음. v0.1.1 공개 시 삭제하거나 함께 공개할지 결정 필요.
- 앱 설정 파일: `~/Library/Application Support/com.intocns.prreviewagent/config.json`
  (켜진 레포, 리뷰한 SHA, 실패 횟수, 이력).
- 레포 위치: 2026-11-06에 `~/project/IntoProject/pr-review-agent` → `~/project/BaeJinseop/pr-review-agent`로 이동.
  `~/.gitconfig`의 `includeIf "gitdir:~/project/BaeJinseop/"`로 이후 커밋은 개인 계정 BaeJinSeop, 통신은 개인 SSH 키.
  옛 경로는 새 경로를 가리키는 심볼릭 링크(Orca가 옛 경로로 등록돼 있고 경로 변경 CLI가 없음).
  Orca 앱에서 새 경로로 다시 등록하면 링크 삭제. 원격 `js8ae/pr-review-agent`는 BaeJinSeop 레포로 리다이렉트됨.

## v0.1.0 이후 변경 (v0.1.1에 포함)

- `686c9e9` 같은 PR 리뷰 동시 실행 방지(PR 단위 잠금, 버튼 비활성화).
- `e4e6ced` 수정 확인된 이전 지적에 답글 + `resolveReviewThread`, 사람이 resolve한 스레드는 재지적 금지.
- `a4e545f` Claude 응답 파싱 보강(다른 도구명, 문자열/중첩 input, 텍스트 JSON), 실패 시 응답 구조 표시.
- `bf991dd` 리뷰 본문에 "수정 확인된 이전 지적" 섹션, 새 지적 0개여도 수정 확인 있으면 게시.
- `ee56bec` 폴링 시 PR을 건너뛴 이유와 레포별 열린 PR 수를 로그에 남김.

## 운영 이슈 대응 (v0.1.1 이후)

- `cf01b05` "새 PR/커밋 없음"인데 PR이 켜지 않은 레포에 있던 문제(예: Intocns/cloudSystemBatch#1):
  리뷰 0개일 때 켜진 레포의 owner로 검색(`/search/issues` `user:<owner>`)해서 켜지 않은 레포의 열린 PR을
  확인 로그 줄에 붙임(최대 5개). 검색 실패는 무시. `user:`는 조직에도 동작함을 `gh api`로 확인.
- `5966d57` 레포를 켤 때 기존 열린 PR 건너뛰기(`skipExistingOnAdd` 기본 켜짐): 토스트에 "N개 지금 리뷰" 버튼(15초).
  누르면 건너뜀 표시(`reviewed`)를 지우고 `runPoll` → base 브랜치/라벨/봇 규칙이 폴링과 동일하게 적용.
  토스트를 놓치면 기존처럼 PR URL 수동 리뷰.
- `beb902d` 강제 `tool_choice` 미지원 모델을 config `autoOnlyModels`에 저장(재시작해도 유지).
  한계: 나중에 그 모델이 지원해도 계속 auto 모드(목록에서 지우려면 config.json 편집).
- `cd511d7` Fine-grained PAT은 Resource owner 한 곳만 보임 → GitHub 제약이라 안내로 대응.
  설정 화면/README에 "여러 owner면 Classic PAT(`repo`)", `github_pat_` 토큰으로 404가 나면 에러에 힌트 추가.

앱 실행 검증(2026-11-06, `tauri dev`, 드라이런):
- `cf01b05` 통과: 확인 로그에 `· 켜지 않은 레포의 열린 PR: Intocns/IntocnsAdmin#9 (...)` 표시.
- `5966d57` 통과: 토스트 "1개 지금 리뷰" → "리뷰 대상으로 되돌림" → 바로 확인 → #9 드라이런 리뷰(코멘트 11개) 이력 기록.
- `beb902d`, `cd511d7`은 앱에서 재현 불가(현재 모델은 강제 tool_choice 지원, 토큰이 Fine-grained 아님). tsc/빌드만 통과.
- 검증 방법: `npx tauri dev --config '{"identifier":"com.intocns.prreviewagent.devcheck"}'`로 실제 설정과 분리
  (키체인 토큰/키는 공유). 그 폴더의 `config.json`에 `dryRun: true`, `pollMinutes: 1`, 테스트 레포를 미리 넣고 실행.
  터미널(Orca)에 손쉬운 사용 권한이 없어 클릭은 사람이 하고, 창 캡처는 `screencapture -l <창 id>`로 함.

남은 운영 메모:
- "레포를 켤 때 기존 열린 PR 건너뛰기"는 비용 때문에 기본값 유지.
- 화면 갱신 버그(검증 중 발견, 미수정):
  - 대시보드 "마지막 확인"이 자동 확인 후에도 `-`로 남음. 다른 탭에 다녀와야 갱신(`renderHistory`만 다시 그림).
  - 레포 탭에서 레포를 켜도 상단 "N개 활성" 숫자가 그대로(표를 다시 그리지 않음).

## 검토 중: 여러 사람이 동시에 돌릴 때 중복 리뷰 방지 (미구현)

문제: 리뷰한 SHA 기록과 PR 잠금이 모두 각자 PC 로컬에 있어, 두 사람이 같은 레포를 켜면
같은 커밋에 각자 계정으로 리뷰가 하나씩 달린다. 기존 "비슷한 코멘트 거르기"는 상대가
게시를 끝낸 뒤에만 효과가 있고 동시 실행은 못 막는다.

후보:

1. **담당 나누기**: 각 앱이 "내가 작성한 PR" 또는 "나에게 리뷰 요청된 PR"만 자동 리뷰하는 옵션.
   조율이 필요 없고 경쟁 상태도 없음. 앱 미설치자의 PR이 빠지는 빈틈은 레포별
   "전체 리뷰 담당자" 설정으로 메움.
2. **상태를 GitHub에 기록**: 리뷰 본문에 `<!-- pr-review-agent sha=<head sha> -->` 표식.
   리뷰 시작 전 PR 리뷰 목록에서 같은 SHA 표식이 있으면 누가 게시했든 건너뜀.
   거의 동시에 시작하면 둘 다 통과하는 한계(Claude 호출 수십 초 동안의 틈).
3. **선점 코멘트**: 리뷰 전 `<!-- claim sha=... id=... -->` 코멘트를 달고 몇 초 뒤 재조회,
   가장 먼저 달린 것(created_at, 같으면 id)만 진행하고 나머지는 자기 선점을 지우고 물러남.
   완료 후 삭제, 10분 지난 선점은 무시. 폴링에 0~60초 무작위 지연 추가.
   화면에 잠깐 코멘트가 보이는 단점.
4. **실행 주체 일원화**: GitHub Actions(`concurrency: pr-${{ github.event.number }}`) 또는 GitHub App 서버.
   구조적으로 한 번만 실행되고 봇 이름으로 게시됨. 대신 서버/시크릿 관리 필요.

추천: 팀 배포 단계에서는 **1번 기본 + 2번 안전장치**. 수동 리뷰 버튼은 같은 SHA 리뷰가 이미 있으면
"이미 리뷰됨, 그래도 할까요?" 확인. 모두가 전체 PR을 리뷰해야 할 때만 3번, 사용자가 늘거나
봇 계정이 필요해지면 4번으로 전환.

## 그 밖의 다음 후보

- 리뷰 게시/critical 지적 시 macOS 알림.
- 에이전트 코멘트에 작성자가 답글 달면 재답변.
- Developer ID 서명·공증(Apple Developer 가입 후 workflow에 추가).
