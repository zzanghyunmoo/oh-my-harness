---
workflow_schema: compound-work/v1
ticket_id: ZZA-96
ticket_url: https://linear.app/zzanghyunmoo/issue/ZZA-96/oh-my-harness-codex-플러그인-등록-유실-감지-및-복구
ticket_status: In Review
ticket_completion: pending
remaining_prs: 1
ideation_status: waived
ideation_path:
ideation_notion_url:
ideation_waiver_reason: 긴급 설치 회귀이며 재현 명령과 완료 기준이 닫혀 있어 별도 후보 탐색이 필요하지 않다.
plan_status: waived
plan_path:
plan_notion_url:
plan_waiver_reason: 수정 범위가 Codex 등록 상태 검사와 재설치 복구로 한정되어 별도 계획 문서 없이 work evidence에서 추적한다.
work_status: complete
work_notion_url: https://app.notion.com/p/3a4ef22ad4fc81a2bd74c1bf82937b10
pr_url: https://github.com/zzanghyunmoo/oh-my-harness/pull/32
closeout_status: pending
merged_pr_url:
merge_commit:
kb_paths:
notion_feature_status_url:
notion_ticket_url: https://app.notion.com/p/3a4ef22ad4fc81a2bd74c1bf82937b10
closed_at:
---

# ZZA-96 작업 기록

## 작업 목표

- 현재 유효한 Codex 설정에 `oh-my-harness`와
  `compound-engineering-plugin` marketplace/plugin 등록을 복구한다.
- Orca가 `~/.codex/config.toml`을 관리형 `CODEX_HOME`으로 다시 동기화해도
  두 등록이 유지되게 한다.
- `omh agents status`가 runtime binary뿐 아니라 Codex package registration을
  검증하고 등록 유실을 명시적으로 보고하게 한다.
- 재설치가 등록 유실 상태를 idempotent하게 복구하는지 실제 환경에서 검증한다.

## 주요 변경 지점

- `scripts/harness/install.mjs`
  - `codexRegistrationScopes`: Orca 환경에서는 canonical `~/.codex`를 먼저,
    현재 관리형 `CODEX_HOME`을 다음으로 등록·검사한다.
  - `ensureCodexPlugin`: 설치 여부뿐 아니라 enabled 상태를 확인하고 disabled
    플러그인을 재설치한다.
  - `codexPluginStatus`: plugin 목록을 selector column 단위로 파싱해 접두사가
    같은 다른 플러그인을 대상 등록으로 오인하지 않는다.
  - `inspectCodexRegistration`: receipt의 고정 package identity로 실제 marketplace
    경로와 plugin 상태를 두 홈에서 검사해 `registration-missing`,
    `registration-drift`, `registration-unverifiable`을 보고한다.
  - `createHarnessPayload`: 인증서 체인 오류 시 bounded online 시도 후 npm cache를
    이용한 offline 설치로 복구한다.
- `plugins/oh-my-harness/.codex-plugin/plugin.json`,
  `plugins/oh-my-harness/.mcp.json`: Codex MCP manifest 경로를 플러그인 표준에 맞춘다.
- `tests/harness/install.test.mjs`: stale receipt, selector 접두사 충돌, disabled
  plugin, Orca dual-home 등록 회귀 fixture를 추가한다.
- 로컬 Codex 설정: 고정 payload를 canonical/managed 두 홈에 재등록했다.
- 작업 브랜치: `ZZA-96/fix-codex-plugin-registration`.

## 검증

- 변경 전 `omh agents status --only codex --json`: 잘못된 `installed` 확인.
- 변경 전 `codex plugin marketplace list`: 두 managed marketplace 누락 확인.
- 변경 전 `codex plugin list`: 두 managed plugin 누락 확인.
- `npm run test:harness`: 80 passed, 3 skipped, 0 failed.
- `npm run test:workspace-connectors`: 34 passed, 0 failed.
- `npm run harness:descriptors:verify`: 20 tuples/116 expected keys 검증 통과.
- `node --test tests/harness/install.test.mjs`: 14 passed, 1 Windows-only skipped,
  0 failed.
- `uv run --with pyyaml python <plugin-validator>/validate_plugin.py plugins/oh-my-harness`:
  plugin validation passed.
- `NPM_CONFIG_OFFLINE=true ./omh agents install --only codex --apply --json`:
  canonical `~/.codex`와 Orca managed home 모두 등록 성공.
- Orca 새 터미널 생성으로 config sync를 재실행한 뒤 `codex plugin list` 확인:
  `compound-engineering@compound-engineering-plugin` 3.19.0과
  `oh-my-harness@oh-my-harness` 0.2.0 모두 `installed, enabled`.
- `./omh agents status --only codex --json`: 두 scope 모두 `installed`.
- 미실행: 인증서 오류 감지 후 online 시도에서 offline cache 재시도로 전환되는
  분기 자동 검증. 실제 offline cache 설치 성공만 확인했다.
- 미실행: Windows 실제 설치 검증. Windows 전용 fixture는 현재 macOS라 스킵했다.

## 외부 동기화

- Linear: ZZA-96, `In Review`, Bug/High. Merge·closeout 전이므로 Done으로 바꾸지 않는다.
- Notion canonical 구현 문서:
  https://app.notion.com/p/3a4ef22ad4fc81a2bd74c1bf82937b10

## Merge closeout

Merge 후 KB 경로, Notion 기능 현황·티켓 문서, merge commit과 Linear 상태를
기록한다.
