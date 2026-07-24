# Oh My Harness

Oh My Harness v2는 Claude Code, OpenCode, Codex 환경을 하나의 프로필과
검증 가능한 카탈로그로 준비하는 Claude-first 관리 CLI입니다. 관리 코어는
Node.js ESM + strict TypeScript이며, 모든 변경은 preview와 exact digest
승인을 거칩니다.

Pi, 전체 Compound Engineering 배포, connector/proxy/provider 확장은 v1
역사와 migration 진단에만 남아 있고 v2 제품 surface에는 포함되지 않습니다.

## 요구사항

- Node.js 22.19.0 이상
- npm
- Git
- 선택한 외부 CLI를 설치할 플랫폼 패키지 관리자
  (`npm`, Homebrew, `apt-get`, WinGet 중 preview에 표시되는 항목)

외부 CLI의 로그인과 credential 저장은 각 CLI가 소유합니다. OMH는 token,
password, cookie, Authorization header를 인자로 받거나 receipt에 저장하지
않습니다.

## 빠른 시작

```bash
npm ci --ignore-scripts
npm run build

# 기본값: personal + Claude Code. 읽기 전용 preview이며 exit code는 2다.
./omh setup

# 출력된 같은 명령과 exact digest를 복사해 적용한다.
./omh setup --apply --digest <64자리-preview-digest>

# 로컬 receipt 상태와 bounded native 검사를 각각 확인한다.
./omh status
./omh doctor
```

Windows PowerShell에서는 `.\omh.cmd`를 사용합니다.

```powershell
.\omh.cmd setup --profile personal --agents claude-code
.\omh.cmd setup --profile personal --agents claude-code --apply --digest <digest>
```

Preview는 managed root, journal, receipt, marketplace, runtime config,
package-manager를 변경하지 않습니다. 적용 시에도 같은 Catalog Revision,
profile, agent 선택, platform, observed pre-image로 plan을 다시 만들고 하나라도
달라지면 첫 mutation 전에 `stale-preview`로 끝납니다.

## 프로필

- `personal`: Linear, Notion, GitHub CLI가 required이고 Jira, Confluence,
  GitLab CLI는 optional입니다. 기본 agent는 Claude Code입니다.
- `company`: Jira, Confluence, GitLab CLI가 required이고 Linear, Notion,
  GitHub CLI는 optional입니다. 기본 agent는 Claude Code이며 필요하면
  `--agents`로 OpenCode/Codex를 명시합니다.
- custom: `create → validate → preview → publish`로 로컬 repository diff를
  만든 뒤 review/merge/release된 프로필만 trusted selection이 됩니다.

Agent runtime과 native plugin 등록은 agent별 상태입니다. 외부 CLI executable은
머신에 한 번 설치되어 trusted `PATH`를 통해 세 runtime이 공유합니다.
`installed-unconfigured`는 executable은 준비됐지만 인증 여부를 검사하지 않았다는
뜻입니다.

## 명령

```text
omh setup [--profile id] [--agents ids] [--tools ids] [--root absolute]
omh agents status|install [--only ids] [--profile id] [--root absolute]
omh tools doctor|install [--only ids] [--profile id] [--root absolute]
omh status|doctor [--root absolute]
omh run --runtime id --receipt /absolute/environment.json -- [runtime args]
omh profiles list
omh profiles create --id ... --name ... --agents ... --required ... --capabilities ...
omh profiles validate --file profile.json
omh profiles preview --file profile.json --repo /absolute/checkout
omh profiles publish --file profile.json --repo /absolute/checkout --digest sha256
```

`setup`, `agents install`, `tools install`, `profiles publish`는 exact digest가
없으면 변경하지 않습니다. `status`는 receipt와 로컬 파일만 읽습니다.
`doctor`는 인증이나 원격 서비스 호출 없이 exact runtime의 native list/config만
bounded inspection합니다.

Managed launch가 필요하면 `omh run`을 사용합니다. 이 경로는 receipt에 기록된
Node, reconciler, runtime digest를 검증하고 runtime discovery 전에 startup
reconciliation을 수행합니다. 직접 실행한 Claude Code/Codex hook과 OpenCode
plugin도 시작 시 receipt 기반 context를 다시 만들며 profile, Catalog Revision,
agents, packages, capabilities, gaps, remediation을 세션에 제공합니다.

적용된 runtime plugin은 상태 루트의 content-addressed generation에서
등록됩니다. Receipt는 같은 digest의 별도 로컬 store를 `repairSource`로
기록하므로 startup은 삭제된 generation만 원자적으로 복구할 수 있고, 수정된
generation은 덮어쓰지 않고 conflict로 보고합니다.
Receipt의 각 항목은 `managed` 또는 `external` scope를 함께 기록합니다. 기존
Node·agent executable과 사용자 소유 native 등록은 OMH가 제거하거나 덮어쓰지
않으며, 자동 복구는 exact digest의 `managed` payload에만 적용됩니다.

## Agent 카탈로그

아래 블록은 contract test가 카탈로그로부터 생성해 README drift를 거부합니다.

<!-- catalog:agents:start -->
| Agent | Command | Exact version | Reviewed platforms |
| --- | --- | --- | --- |
| claude-code | claude | 2.1.210 | darwin-arm64, darwin-x64, linux-x64, win32-arm64, win32-x64 |
| opencode | opencode | 1.18.0 | darwin-arm64, darwin-x64, linux-x64, win32-arm64, win32-x64 |
| codex | codex | 0.144.4 | darwin-arm64, darwin-x64, linux-x64, win32-arm64, win32-x64 |
<!-- catalog:agents:end -->

Reviewed tuple이 없는 Linux ARM64는 `unsupported`입니다. PATH에 같은 명령이
있어도 exact executable SHA-256이 다르면 OMH는 그 파일을 덮어쓰거나
소유권을 주장하지 않고 별도 managed runtime acquisition을 계획합니다.

## 외부 CLI 패키지 카탈로그

<!-- catalog:packages:start -->
| Package | Executable | Personal | Company | Supported OS | Exact version | Provenance policy |
| --- | --- | --- | --- | --- | --- | --- |
| notion | ntn | required | optional | darwin, linux | 0.19.0 | exact-package-version |
| linear | linear | required | optional | darwin, linux, win32 | 2.0.0 | exact-package-version |
| jira | jira | optional | required | darwin, linux, win32 | 1.7.0 | exact-release-artifact |
| confluence | confluence | optional | required | darwin, linux, win32 | 2.18.0 | exact-package-version |
| github | gh | required | optional | darwin, linux, win32 | manager-provided | reviewed-package-manager-source |
| gitlab | glab | optional | required | darwin, linux, win32 | manager-provided | reviewed-package-manager-source |
<!-- catalog:packages:end -->

현재 catalog revision에서 reviewed URL과 SHA-256이 없는 managed Jira artifact는
Linux/Windows에서 설치 가능하다고 가장하지 않고 required profile을 preview
단계에서 차단합니다. Notion CLI가 required인 `personal`은 Windows에서
지원되지 않으므로 custom profile 또는 지원되는 원격 환경을 선택해야 합니다.

로그인은 사람이 보이는 터미널에서 각 CLI 명령으로 수행합니다:
`linear auth login`, `ntn login`, `jira init`, `confluence init --read-only`,
`gh auth login`, `glab auth login`.

## Capability 카탈로그

이 표의 `ready`는 해당 runtime adapter가 catalog semantic contract를 native
surface로 제공한다는 release 상태입니다. 실제 환경 readiness는 native
registration과 필요한 language-server executable을 별도로 검사한 결과입니다.
Claude 공식 capability는 `claude-plugins-official` commit marker, 전체
marketplace manifest SHA-256, 선택 plugin별 Git tree가 lock과 모두 일치해야
preview에 들어갑니다.

<!-- catalog:capabilities:start -->
| Capability | Kind | Claude Code | OpenCode | Codex | Source |
| --- | --- | --- | --- | --- | --- |
| lsp-jdtls | lsp | ready (official-plugin) | ready (native-plugin) | unsupported (native-plugin) | anthropic-official-plugins |
| lsp-kotlin | lsp | ready (official-plugin) | ready (native-plugin) | unsupported (native-plugin) | anthropic-official-plugins |
| lsp-csharp | lsp | ready (official-plugin) | ready (native-plugin) | unsupported (native-plugin) | anthropic-official-plugins |
| lsp-clangd | lsp | ready (official-plugin) | ready (native-plugin) | unsupported (native-plugin) | anthropic-official-plugins |
| lsp-gopls | lsp | ready (official-plugin) | ready (native-plugin) | unsupported (native-plugin) | anthropic-official-plugins |
| lsp-pyright | lsp | ready (official-plugin) | ready (native-plugin) | unsupported (native-plugin) | anthropic-official-plugins |
| lsp-typescript | lsp | ready (official-plugin) | ready (native-plugin) | unsupported (native-plugin) | anthropic-official-plugins |
| goal | workflow | ready (managed-skill) | ready (native-skill) | ready (native-skill) | oh-my-harness-managed |
| deep-research | workflow | ready (managed-skill) | ready (native-skill) | ready (native-skill) | oh-my-harness-managed |
| ideation | workflow | ready (managed-skill) | ready (native-skill) | ready (native-skill) | oh-my-harness-managed |
| brainstorm | workflow | ready (managed-skill) | ready (native-skill) | ready (native-skill) | oh-my-harness-managed |
| plan | workflow | ready (managed-skill) | ready (native-skill) | ready (native-skill) | oh-my-harness-managed |
| code-review | workflow | ready (official-plugin) | ready (native-skill) | ready (native-skill) | anthropic-official-plugins |
| doc-review | workflow | ready (managed-skill) | ready (native-skill) | ready (native-skill) | oh-my-harness-managed |
| skill-creator | workflow | ready (official-plugin) | ready (native-skill) | ready (native-skill) | anthropic-official-plugins |
| ralph-loop | workflow | ready (official-plugin) | ready (native-skill) | ready (native-skill) | anthropic-official-plugins |
| security-guidance | workflow | ready (managed-skill) | ready (native-skill) | ready (native-skill) | oh-my-harness-managed |
<!-- catalog:capabilities:end -->

Codex plugin manifest에는 현재 language-server 등록 surface가 없으므로 7개
LSP capability를 `ready`로 가장하지 않습니다. Codex workflow/skill/MCP/hook
어댑터는 사용할 수 있지만 LSP가 포함된 built-in profile로 Codex를 선택하면
preview가 명시적으로 차단됩니다. Claude Code와 OpenCode는 plugin/native LSP
설정과 trusted executable을 모두 검증합니다.

## 상태와 startup synchronization

성공 receipt는 secret-free이며 profile, selected agents, Catalog Revision,
plan digest, runtime readiness, managed ownership, additive startup consent를
기록합니다.

배포 artifact의 `harness/catalog/release.json`은 같은 Catalog Revision,
managed-skill set digest, runtime plugin tree digest, exact CLI compatibility
range를 고정합니다.

Startup reconciliation이 자동으로 할 수 있는 일은 다음뿐입니다.

- 현재 receipt가 고정한 managed content의 단순 삭제 복구
- accepted trust lineage와 기존 additive consent 안의 reviewed managed skill 추가

수정된 파일, user-owned 충돌, version/source 변경, removal, permission 확장,
unknown/replayed/revoked/expired release는 자동 적용하지 않습니다. 결과는
`pending-approval`, `conflict`, `unverifiable`, `partial-unready`처럼 그대로
노출됩니다.

## 프로젝트 구조

```text
src/                         strict TypeScript core
harness/catalog/             agents, packages, capabilities, provenance
harness/profiles/            built-in and released custom profiles
harness/contracts/           closed JSON Schemas
harness/adapters/            reviewed runtime acquisition descriptors
plugins/oh-my-harness/        Claude/Codex plugin and shared managed skills
.opencode/plugins/           OpenCode native plugin
tests/                       unit, contract, integration, runtime, release gates
docs/plans/                  current and historical implementation plans
docs/solutions/              durable implementation learnings
```

Canonical 방향은
[`docs/plans/2026-07-24-001-feat-claude-first-harness-v2-plan.md`](docs/plans/2026-07-24-001-feat-claude-first-harness-v2-plan.md)와
[`CONCEPTS.md`](CONCEPTS.md)에 있습니다. v1 자료는 역사적 문서이며 현재
명령 계약을 정의하지 않습니다.

## 개발과 릴리스 검증

```bash
npm ci --ignore-scripts
npm run typecheck
npm run build
npm run catalog:verify
npm run test:unit
npm run test:contracts
npm run test:integration
npm run test:runtime:claude
npm run test:runtime:opencode
npm run test:runtime:codex
npm run test:harness
npm run package:verify
git diff --check
```

CI는 Node.js 22.19.0으로 macOS, Ubuntu, Windows에서 같은 contract,
preview/apply, ownership, startup, package-content invariant를 실행합니다.
