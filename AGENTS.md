# AGENTS.md — oh-my-harness v2 프로젝트 가드레일

Oh My Harness v2는 원하는 코딩 에이전트와 공유 CLI 패키지, 검증된 플러그인·스킬을 프로필로 설치하고 유지하는 cross-runtime 환경 관리자다. 지원 대상은 Claude Code, OpenCode, Codex이며 Pi는 신규 제품 surface에서 제거한다. Claude Code를 먼저 완성하되 카탈로그와 정책은 처음부터 runtime-neutral하게 설계하고 세 런타임 parity까지 같은 제품 범위로 다룬다.

이 문서는 2026-07-24 v2 reset 이후의 현재 가드레일이다. 이전 Pi, connector,
proxy, 전체 Compound Engineering 문서는 역사적 근거일 뿐 새 구현의 권한이
아니다.

## 제품 원칙

- 사용자는 `personal`, `company`, 또는 검증된 `custom` Environment Profile과 하나 이상의 에이전트를 선택한다.
- Claude-first는 delivery 순서일 뿐 Claude manifest가 source of truth라는 뜻이 아니다.
- Capability Catalog, Environment Profile, Catalog Revision, Managed-state Receipt가 desired state의 canonical contract다.
- 공식·upstream 구현을 우선 사용한다. 적합한 upstream이 없을 때만 이 저장소에 portable semantic contract와 runtime-native 패키지를 만든다.
- 외부 CLI executable은 머신에 한 번 설치되어 trusted `PATH`로 공유된다. 플러그인·스킬·hook 등록은 에이전트별 native surface를 사용한다.
- 상태와 readiness는 부분 지원을 성공으로 포장하지 않는다. `unsupported`, `pending-approval`, `conflict`, `unverifiable`, `partial-unready`를 명시적으로 보고한다.

## 목표 프로젝트 구조

v2 마이그레이션 중 legacy 파일이 남아 있을 수 있지만 새 기능은 아래 ownership에 맞춘다.

```text
oh-my-harness/
├── omh, omh.cmd                  # 사용자용 호환 launcher
├── src/                          # strict TypeScript canonical source
│   ├── cli/                      # command parsing과 출력 adapter
│   ├── catalog/                  # catalog/profile load와 validation
│   ├── planning/                 # preview와 exact-apply planner
│   ├── install/                  # agent/package/capability installer
│   ├── environment/              # composed preview/apply/status/doctor
│   ├── reconcile/                # startup reconciliation
│   ├── runtime/                  # Claude/OpenCode/Codex native adapters
│   ├── state/                    # receipts, ownership, locks, journal
│   ├── migration/                # v1 read-only inspection/removal preview
│   └── tools/                    # 외부 CLI 정책과 실행 adapter
├── dist/                         # TypeScript build output, 직접 편집 금지
├── harness/
│   ├── catalog/                  # agents, packages, capabilities, provenance
│   ├── profiles/                 # personal, company, published custom
│   ├── contracts/                # closed JSON Schemas
│   └── adapters/                 # runtime acquisition/native capability data
├── plugins/oh-my-harness/        # repository-managed native plugin payload
├── .claude-plugin/               # Claude marketplace
├── .opencode/plugins/            # OpenCode native entrypoint
├── .agents/plugins/              # Codex marketplace
├── tests/                        # typed unit/integration/contract tests
├── docs/plans/                   # implementation plans
├── docs/solutions/               # durable project learnings
├── CONCEPTS.md                   # shared domain vocabulary
└── README.md                     # canonical user documentation
```

## 언어와 빌드 규칙

- maintained CLI/core source는 Node.js ESM + strict TypeScript다. 새 core 로직을 `.mjs`에 추가하지 않는다.
- `module`/`moduleResolution`은 `NodeNext`, target은 최소 `ES2022`, 지원 Node 기준은 `package.json#engines`와 CI에서 동일해야 한다.
- `omh`와 기존 npm script는 compatibility launcher로 남길 수 있지만 판단 로직을 복제하지 않고 compiled entrypoint만 호출한다.
- source import, emitted extension, `npm pack` 포함 파일을 Linux/macOS/Windows에서 검증한다.
- runtime adapter는 catalog 정책을 재정의하지 않고 native manifest·hook·tool 형식으로 변환만 한다.

## Preview-first 변경 규칙

- `omh setup`, `omh agents install`, `omh tools install`, `omh profiles publish`, removal 명령은 기본적으로 읽기 전용 preview다.
- 실제 변경은 `--apply`와 방금 확인한 exact preview digest가 모두 있을 때만 수행한다.
- preview digest는 Catalog Revision, 선택 profile/agents, platform, observed managed state를 포함한다. apply 직전에 다시 계산하여 stale preview를 첫 mutation 전에 거부한다.
- agent, package, capability installer의 모든 필수 preflight를 mutation보다 먼저 실행한다.
- 부분 실패는 last-known-good를 보존하고 `partial-unready` 결과와 재시도 가능한 journal을 남긴다. required 항목이 모두 검증되기 전 success receipt를 쓰지 않는다.
- removal, pin 변경, source 변경, user-owned 충돌은 additive repair와 분리된 새 preview를 요구한다.
- 같은 marketplace/plugin ID가 다른 source, version, tree, enabled state로 이미
  등록되어 있으면 이를 제거하거나 교체하지 않고 user-owned collision으로
  실패한다. exact registration만 idempotent하게 재사용한다.

## 카탈로그와 프로필 규칙

- 카탈로그의 agent ID는 `claude-code`, `opencode`, `codex`다. Pi를 신규 schema, help, selector, readiness matrix에 추가하지 않는다.
- 패키지 catalog는 Notion CLI, Linear CLI, Jira CLI, Confluence CLI, `gh`, `glab`을 다룬다.
- 각 패키지 항목은 최소한 ID, 설명, executable, upstream/source, 지원 OS/architecture, exact version 또는 provenance policy, 설치 방법, 인증 안내, built-in profile별 required/optional 분류를 가진다.
- `personal` 기본 required는 Linear, Notion, `gh`; optional은 Jira, Confluence, `glab`이다.
- `company` 기본 required는 Jira, Confluence, `glab`; optional은 Linear, Notion, `gh`다.
- missing required는 profile을 unready로 만들고 missing optional은 `ready-with-optional-gaps`로 보고한다.
- custom profile은 로컬에서 create → validate → preview → repository diff 생성 순서를 따른다. commit, push, PR 생성은 별도의 명시적 외부-write 의도가 있어야 한다.
- merged/released profile만 다른 사용자의 trusted selectable profile이 된다.
- 모든 JSON contract는 unknown field와 unknown ID를 fail closed하고 secret-like field를 금지한다.

## Capability와 runtime parity 규칙

- 기본 capability catalog는 다음을 포함한다.
  - LSP: jdtls, Kotlin, C#, clangd, gopls, Pyright, TypeScript
  - workflow: goal, deep-research, ideation, brainstorm, plan, code-review, doc-review, skill-creator, ralph-loop, security-guidance
- Claude Code의 공식 marketplace 또는 각 capability의 공식 upstream을 먼저 조사한다.
- 공식 plugin도 mutable `latest`로 설치하지 않는다. repository, exact commit/tree, plugin path, manifest/version, content digest를 Upstream Trust Receipt로 고정한다.
- Claude 공식 plugin은 `claude-plugins-official`의 `.gcs-sha`, marketplace
  manifest SHA-256, 선택 plugin별 Git tree SHA-1이 모두 lock과 일치할 때만
  preview/apply 대상이 된다. plugin 이름이나 cache 존재만으로 검증하지 않는다.
- upstream이 없거나 semantic contract를 충족하지 못할 때만 `plugins/oh-my-harness/`에 managed capability를 만든다.
- 하나의 semantic capability는 trigger, intent, input/output, side effects, approval posture, error behavior를 runtime-neutral하게 정의한다.
- Claude, OpenCode, Codex adapter는 native surface를 사용하고 같은 contract test를 통과해야 `ready`다.
- LSP readiness는 agent-side LSP plugin/config와 machine-side language-server executable을 별도로 검증한다.
- 현재 Codex plugin surface에는 검증된 LSP 등록점이 없으므로 Codex의 7개 LSP
  cell은 `unsupported`다. native surface가 추가되고 계약 테스트가 생기기 전에는
  카탈로그를 `ready`로 바꾸지 않는다.
- 한 runtime의 성공만으로 cross-runtime parity를 선언하지 않는다.

## Approved Startup Synchronization

- managed launcher는 runtime discovery 전에 reconciliation을 수행하여 같은 세션에서 approved content를 사용할 수 있게 한다.
- 각 runtime의 native startup hook/plugin은 direct launch에서도 drift를 감지한다. runtime discovery 이후 복구된 content가 즉시 로드되지 않으면 다음 시작이 필요함을 명시한다.
- startup sync는 bounded timeout, cross-process single-writer lock, atomic publish, crash-safe journal, structured result를 사용한다.
- 자동 변경은 다음 두 종류로 제한한다.
  - 현재 승인된 revision에서 삭제된 pinned managed artifact 복구
  - 기록된 additive consent와 검증된 release/catalog lineage 안에서 새로 추가된 reviewed capability 설치
- version upgrade, removal, source replacement, unknown catalog revision, modified managed file, unreviewed remote code는 자동 실행하지 않고 `pending-approval` 또는 `conflict`로 남긴다.
- startup 실패는 agent process를 손상시키지 않고 degraded context를 보고한다. required readiness는 실패로 유지한다.
- `status`, `doctor`, runtime context/tool은 같은 Managed-state Receipt와 reconciliation result를 읽어 profile/revision/readiness가 일치해야 한다.

## 외부 CLI 도구 안전 규칙

- `harness/catalog/packages.json`이 설치와 agent tool package metadata의
  runtime-neutral source of truth이며 TypeScript loader/adapter가 이를
  fail-closed로 파생한다.
- Claude/Codex는 MCP, OpenCode는 native custom tools로 선택 Environment Profile의 backend만 노출한다.
- 숨겨진 backend를 tool name으로 직접 호출해도 실행 단계에서 다시 거부한다.
- 외부 CLI 인증은 각 CLI가 소유한다. harness는 login을 자동화하거나 token, password, cookie, Authorization header를 인자로 받거나 receipt에 저장하지 않는다.
- 명령은 shell 없이 trusted `PATH`에서 실행한다. workspace-local executable shim, path escape, interactive/browser flag를 거부한다.
- remote/local write는 사용자의 정확한 변경 의도와 `confirmedWrite=true`가 모두 필요하다.
- auth가 끝나지 않은 설치는 `installed-unconfigured`로 구분하고 login guidance만 제공한다.

## 상태, 소유권, 마이그레이션

- managed payload, receipt, lock, journal은 기본적으로 `~/.oh-my-harness`에 저장하고 저장소에 커밋하지 않는다.
- runtime plugin payload는 content-addressed store와 receipt-owned generation을
  분리한다. receipt의 `repairSource`는 같은 digest의 로컬 store만 가리키며,
  startup repair는 target이 단순 삭제된 경우에만 atomic copy를 수행한다.
- receipt는 secret-free이며 catalog revision, profile, selected agents, pins,
  managed paths/digests, `managed`/`external` ownership scope, sync consent,
  lifecycle result를 기록한다. adopted Node/agent executable은 `external`이며
  harness가 소유권을 주장하거나 자동 복구하지 않는다.
- managed state root는 절대 경로여야 하고 파일시스템 root가 될 수 없다.
  managed root 밖 경로, symlink escape, pre-image가 바뀐 target에는 쓰지 않는다.
  startup repair는 정확히
  `payloads/store/<digest> → payloads/generations/<digest>`만 허용한다.
- v1/Pi/Compound Engineering 상태는 read-only migration inspector로 탐지한다. receipt가 없거나 손상된 경로는 `suspected`로만 보고한다.
- Pi와 v1 plugin/payload 제거는 exact removal preview가 있을 때만 수행하며 user-owned 파일을 추정 삭제하지 않는다.
- legacy connector/proxy/provider 코드는 v2 제품 surface로 확장하지 않는다. 독립적 가치가 있는 코드는 별도 결정 전까지 보존하되 canonical CLI/profile/catalog에 포함하지 않는다.

## 테스트와 검증

- unit/integration test는 `node:test`와 `node:assert/strict`를 기본으로 사용한다.
- TypeScript typecheck와 build는 별도 CI gate이며 test가 emitted JavaScript를 실제로 실행해야 한다.
- 테스트는 네트워크 대신 temp directory, fake runner, pinned fixture, dependency injection을 사용한다.
- receipt, snapshot, hook stdin, JSON-RPC line, subprocess output은 읽기 전에
  크기 한계를 적용하고 symlink/non-regular file을 fail closed한다.
- 최소 검증 범위:
  - catalog/profile/receipt closed-schema와 deterministic revision/digest
  - preview 무변경, stale-preview 거부, partial apply 재시도
  - personal/company/custom required·optional 해석
  - six-package platform/install/auth guidance
  - three-runtime capability parity와 unsupported honesty
  - profile-scoped tool exposure와 execution-time 재검사
  - startup no-op/repair/conflict/concurrency/timeout/crash recovery
  - user-owned config 보존과 v1/Pi migration preview
  - arbitrary CWD의 marketplace/plugin/MCP/hook 실행
  - `npm pack` payload와 Linux/macOS/Windows CI
- security boundary를 OS나 runtime 전체에서 skip하지 않는다. platform-specific fixture로 같은 invariant를 검증한다.
- release 전에는 README의 agent/package/capability 표가 catalog에서 생성된
  결과와 일치해야 하며 `npm run catalog:verify`가 drift를 거부해야 한다.
- canonical gate는 `typecheck`, `build`, `catalog:verify`, `test:unit`,
  `test:contracts`, `test:integration`, 세 `test:runtime:*`, `test:harness`,
  `package:verify`, `git diff --check`다.

## 문서와 지식 규칙

- canonical 사용자 surface는 `omh`다. README와 CLI help는 agent-scoped 설치와 machine-shared package 설치를 구분한다.
- `CONCEPTS.md`의 v2 vocabulary를 코드, schema, plan, issue, wiki에서 동일하게 사용한다.
- `docs/solutions/`의 preview-first, immutable provenance, one-policy/multiple-adapters, cross-platform Node 선례를 구현 전 검색한다.
- Product Contract를 바꾸는 결정은 먼저 현재 `docs/plans/` artifact와 `CONCEPTS.md`에 반영한다.

## 환경변수와 커밋 금지

- 환경변수는 credential 값의 전달 통로일 수 있지만 catalog/profile/receipt에 실제 secret을 기록하지 않는다.
- 기존 process environment를 무조건 덮어쓰는 global `.env` loader를 새 v2 core에 도입하지 않는다.
- 다음은 커밋하지 않는다.
  - `.env`
  - `node_modules/`
  - `dist/`가 release artifact로 명시되지 않은 개발 build output
  - `~/.oh-my-harness/` payload, receipt, lock, journal
  - runtime auth state와 `.mcp-auth/`
  - API key, token, password, cookie, Authorization header

## 핵심 의존성

- Node.js와 TypeScript는 `package.json`의 exact supported range를 따른다.
- `@modelcontextprotocol/sdk`는 MCP adapter에만 사용하고 catalog/domain core가 MCP 타입에 종속되지 않게 한다.
- OpenCode/Codex/Claude 전용 SDK 또는 manifest type은 각 runtime adapter 경계 밖으로 누출하지 않는다.
- Pi ExtensionAPI와 `@earendil-works/pi-coding-agent`는 v2 dependency에
  다시 추가하지 않는다.
