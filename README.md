# PR Review Agent

GitHub PR을 주기적으로 확인해서 Claude로 리뷰하고, PR에 리뷰 코멘트(COMMENT)를 직접 게시하는 데스크톱 앱 (Tauri 2, macOS / Windows).

## 사용법

1. **설정** 탭
   - GitHub 토큰 저장: Fine-grained PAT, Repository permissions `Pull requests: Read and write`, `Contents: Read`
     (조직 레포는 Resource owner를 조직으로 지정, 조직 정책에 따라 승인 필요)
     - Fine-grained PAT은 Resource owner 한 곳의 레포만 보인다. 개인·조직 등 여러 owner의 레포를 함께 쓰면 Classic PAT(`repo` 권한)을 쓴다.
   - Claude API 키 저장 → "모델 목록 불러오기" → 모델 선택 → 설정 저장
   - 처음엔 **드라이런**을 켜고 리뷰 품질을 이력에서 확인한 뒤 끄는 것을 권장
2. **레포** 탭: "GitHub에서 레포 불러오기" → 리뷰할 레포 체크, 필요하면 대상 base 브랜치 입력
3. **대시보드**: "지금 확인" 또는 PR URL로 즉시 리뷰. 창을 닫아도 트레이(메뉴바)에서 계속 동작

## 동작

- 확인 주기마다 활성 레포의 열린 PR(드래프트 제외)을 조회하고, 아직 리뷰하지 않은 head 커밋이면 리뷰
- diff에 새 파일 기준 라인 번호를 붙여 Claude에 전달 → diff에 있는 라인만 라인 코멘트, 나머지는 리뷰 본문으로
- 같은 커밋에서 실패하면 자동 재시도는 3번까지 (PR URL 수동 리뷰는 제한 없음)
- 여러 사람이 같은 레포를 켜도 커밋당 리뷰는 하나: 리뷰 전과 게시 직전에 그 커밋에 이미 에이전트 리뷰가 있으면(누구의 앱이든) 건너뜀
  (PR URL 수동 리뷰는 "그래도 리뷰"로 다시 게시 가능)
- 설정의 월 예산 상한에 이번 달 추정 비용(이 PC에서 쓴 것)이 닿으면 자동 리뷰를 멈춤 (PR URL 수동 리뷰는 가능)
- lock 파일, 바이너리, 빌드 산출물은 제외. 최대 diff 크기 초과분은 변경량 적은 파일부터 제외

## 저장 위치

- 토큰·API 키: macOS 키체인 / Windows 자격 증명 관리자 (서비스명 `com.intocns.prreviewagent`)
- 설정·레포·이력: 앱 데이터 디렉터리의 `config.json`
  (macOS `~/Library/Application Support/com.intocns.prreviewagent/`)

## 개발

```bash
npm install
npm run tauri dev        # 개발 실행
CI=true npm run tauri build   # .app + .dmg (CI=true: Finder 레이아웃 AppleScript 생략)
```

산출물: `src-tauri/target/release/bundle/dmg/`

## 다운로드 / 릴리스

[Releases](https://github.com/js8ae/pr-review-agent/releases)에서 macOS universal DMG와 Windows 설치 파일을 받을 수 있습니다.
서명·공증하지 않은 빌드라 처음 실행할 때 OS가 막습니다.

- macOS: 시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기", 또는 `xattr -dr com.apple.quarantine "/Applications/PR Review Agent.app"`
- Windows: SmartScreen 경고에서 "추가 정보 → 실행"

릴리스 만드는 법 (`.github/workflows/release.yml`):

1. 버전을 올리고 커밋·푸시: `package.json`, `package-lock.json`(2곳), `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`
2. `git tag v<버전> && git push origin v<버전>`
   (태그와 `tauri.conf.json`의 version이 다르면 workflow가 실패함. 실패한 태그는 재사용하지 말고 다음 버전으로)
3. Actions가 끝나면 Releases의 초안을 확인하고 Publish

## 배포 메모

- 경고 없이 열리게 하려면: Apple Developer ID 서명 + 공증(Apple Developer Program 연 $99), Windows 코드 서명 인증서

## 라이선스

[MIT](LICENSE)
