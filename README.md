# PR Review Agent

GitHub PR을 주기적으로 확인해서 Claude로 리뷰하고, PR에 리뷰 코멘트(COMMENT)를 직접 게시하는 데스크톱 앱 (Tauri 2, macOS / Windows).

## 사용법

1. **설정** 탭
   - GitHub 토큰 저장: Fine-grained PAT, Repository permissions `Pull requests: Read and write`, `Contents: Read`
     (조직 레포는 Resource owner를 조직으로 지정, 조직 정책에 따라 승인 필요)
   - Claude API 키 저장 → "모델 목록 불러오기" → 모델 선택 → 설정 저장
   - 처음엔 **드라이런**을 켜고 리뷰 품질을 이력에서 확인한 뒤 끄는 것을 권장
2. **레포** 탭: "GitHub에서 레포 불러오기" → 리뷰할 레포 체크, 필요하면 대상 base 브랜치 입력
3. **대시보드**: "지금 확인" 또는 PR URL로 즉시 리뷰. 창을 닫아도 트레이(메뉴바)에서 계속 동작

## 동작

- 확인 주기마다 활성 레포의 열린 PR(드래프트 제외)을 조회하고, 아직 리뷰하지 않은 head 커밋이면 리뷰
- diff에 새 파일 기준 라인 번호를 붙여 Claude에 전달 → diff에 있는 라인만 라인 코멘트, 나머지는 리뷰 본문으로
- 같은 커밋에서 실패하면 자동 재시도는 3번까지 (PR URL 수동 리뷰는 제한 없음)
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

## 배포 메모

- 현재 빌드는 ad-hoc 서명 → 다른 맥에서는 처음 실행 시 우클릭 → 열기 (또는 `xattr -dr com.apple.quarantine`)
- 팀 배포: Apple Developer ID 서명 + 공증, Windows는 GitHub Actions `windows-latest`에서 MSI/NSIS 빌드

## 라이선스

[MIT](LICENSE)
