---
title: ZZA-96 Codex 플러그인 등록 유실 감지 및 복구
ticket: ZZA-96
merged_pr: https://github.com/zzanghyunmoo/oh-my-harness/pull/32
merge_commit: ce56a38423a83cb5b4681d9fa792788bd869d945
work_evidence: docs/works/2026-07-21-ZZA-96-codex-plugin-registration-work.md
notion_feature_status: https://app.notion.com/p/39eef22ad4fc819db113ce1029c899a4
notion_ticket: https://app.notion.com/p/3a4ef22ad4fc81a2bd74c1bf82937b10
last_verified: 2026-07-21
---

<!-- markdownlint-disable MD025 -->

# ZZA-96 Codex 플러그인 등록 유실 감지 및 복구

## 현재 기능 상태

Codex agent installation은 runtime binary와 receipt뿐 아니라 실제 marketplace 및
plugin registration까지 검사한다. canonical `~/.codex`와 Orca가 관리하는 활성
`CODEX_HOME`에서 `oh-my-harness`와 `compound-engineering-plugin`이 설치되고
활성화됐는지 확인하며, 유실된 등록은 `omh agents install --only codex --apply`로
복구할 수 있다.

## 주요 동작과 경계

- Orca 환경에서는 canonical home을 먼저, 관리형 활성 home을 다음으로 등록·검사한다.
- receipt에 고정된 package identity와 실제 marketplace 경로, plugin selector 및
  enabled 상태를 비교한다.
- plugin 목록은 selector column을 정확히 비교하므로 접두사가 같은 다른 plugin을
  대상 등록으로 오인하지 않는다.
- 상태는 `registration-missing`, `registration-drift`,
  `registration-unverifiable`을 구분한다.
- npm 인증서 체인 오류는 제한된 online 시도 후 기존 npm cache를 사용한 offline
  설치로 복구한다.

## 검증 결과

- `npm run test:harness`: 80 passed, 플랫폼 전용 3 skipped, 0 failed.
- `npm run test:workspace-connectors`: 34 passed, 0 failed.
- `npm run harness:descriptors:verify`: 20 tuples와 116 expected keys 통과.
- Codex plugin validation 통과.
- 실제 설치 적용과 Orca 재동기화 뒤 두 home에서 두 managed plugin이
  `installed, enabled` 상태임을 확인했다.
- `omh agents status --only codex --json`에서 두 scope 모두 `installed`를 확인했다.

## 운영 및 사용 시 주의사항

Orca가 관리형 config를 재생성할 수 있으므로 장애 확인은 canonical home만 보지 않고
활성 `CODEX_HOME`까지 함께 수행한다. macOS에서 실제 복구를 검증했으며 Windows 실제
설치는 플랫폼 fixture만 통과했다. 인증서 오류 감지 후 online에서 offline cache로
자동 전환되는 분기는 실제 offline 설치로 확인했지만 오류 주입 자동 테스트는 없다.

## 관련 문서

- Work evidence:
  `docs/works/2026-07-21-ZZA-96-codex-plugin-registration-work.md`
- Notion canonical feature status:
  <https://app.notion.com/p/39eef22ad4fc819db113ce1029c899a4>
- Notion canonical ticket document:
  <https://app.notion.com/p/3a4ef22ad4fc81a2bd74c1bf82937b10>
