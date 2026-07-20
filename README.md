# oh-my-harness

Codex, OpenCode, Claude Code, Pi에 같은 Compound Engineering 자산과 안전 정책을 배포하기 위한 cross-runtime coding-agent harness입니다. 기존 Pi 확장은 v1 동안 호환 surface로 유지합니다.

## 현재 구현 범위

- U1: Compound Engineering upstream을 고정하는 trust receipt와 29개 skill inventory
- U2: runtime-neutral feature, profile, adapter, conformance contract
- U3: Codex, OpenCode, Claude Code, Pi의 정확한 버전과 플랫폼 acquisition descriptor
- macOS arm64/x64, Windows arm64/x64, Linux x64에서 Claude Code, Codex, OpenCode, Pi를 checksum으로 검증해 설치하고 각 런타임의 native package surface에 등록하는 preview-first installer
- 런타임별로 Linear/Notion/GitHub 또는 Jira/Confluence/GitLab만 노출하는 role-scoped CLI profile

Native pre-model gate와 전체 conformance runner는 후속 unit에서 구현합니다.

## 요구사항

- Node.js 22.19 이상
- npm
- Git
- macOS에서 Jira, GitHub, GitLab, CodeRabbit CLI를 자동 설치하려면 Homebrew
- Windows에서 GitHub/GitLab CLI를 자동 설치하려면 WinGet

## 빠른 시작

```bash
git clone https://github.com/zzanghyunmoo/oh-my-harness.git
cd oh-my-harness
npm ci

# 네 runtime과 각 runtime profile에 필요한 외부 CLI의 설치 계획만 확인
./omh setup

# 확인한 계획을 실제 적용
./omh setup --apply
```

Windows PowerShell에서는 checkout launcher를 다음처럼 실행합니다.

```powershell
git clone https://github.com/zzanghyunmoo/oh-my-harness.git
Set-Location oh-my-harness
npm ci

# preview
.\omh.cmd setup

# apply
.\omh.cmd setup --apply
```

`setup`은 `--apply`가 없으면 어떤 파일도 변경하지 않습니다. 에이전트 runtime과 harness plugin은 에이전트별로 선택합니다. 외부 CLI 실행파일은 머신에 한 번 설치해 `PATH`로 공유하지만, 각 runtime에는 아래 profile의 issue tracker, wiki, Git repository 도구만 노출됩니다. 기본 `./omh setup`은 네 runtime profile의 합집합인 Jira, Linear, GitHub, GitLab, Confluence, Notion을 계획합니다.

필요한 항목만 설치할 수도 있습니다.

```bash
# Linear, Notion, GitHub가 자동 선택됨
./omh setup --agents codex,pi
./omh setup --agents codex,pi --apply

# Jira, Confluence, GitLab(glab)이 자동 선택됨
./omh setup --agents claude-code,opencode
./omh setup --agents claude-code,opencode --apply
```

`--tools`는 머신에 설치할 실행파일만 명시적으로 덮어씁니다. 예를 들어 `--tools github,coderabbit`으로 CodeRabbit까지 설치할 수 있지만 runtime role profile은 바뀌지 않습니다.

`omh`를 현재 checkout 밖에서도 사용하려면 로컬 package를 전역 연결할 수 있습니다.

```bash
npm install --global .
omh doctor
```

설치 후 상태와 다음 작업은 다음 명령으로 확인합니다.

```bash
omh status
omh doctor
```

## `omh` 명령 구조

```text
omh setup                 agent와 외부 CLI를 함께 preview/apply
omh agents install        고정 runtime과 harness plugin을 에이전트별 설치
omh agents status         managed runtime 상태 확인
omh tools install         runtime profile 합집합의 머신 공유 외부 CLI 설치
omh tools doctor          외부 CLI 실행파일 확인
omh status                agent와 CLI 상태를 한 번에 확인
omh doctor                상태와 다음 명령을 함께 출력
omh profiles verify       Pi compatibility profile/lock 검증
omh profiles apply        Pi profile의 비파괴 적용 계획 출력
```

설치 명령은 모두 `--apply`가 없으면 preview입니다. `claude`는 `claude-code`, `gh`는 `github`, `glab`는 `gitlab`, `ntn`은 `notion`, `cr`은 `coderabbit`의 입력 alias로 사용할 수 있습니다.

## 고정 버전 설치

기본 명령은 읽기 전용 미리보기입니다. 설치 위치와 정확한 버전을 확인한 뒤 `--apply`를 명시해야 다운로드, snapshot 생성, native package 등록이 시작됩니다.

```bash
./omh agents install
./omh agents install --apply
./omh agents status
```

현재 고정 조합은 다음과 같습니다.

- Claude Code `2.1.210`
- Codex `0.144.4`
- OpenCode `1.18.0`
- Pi `0.80.7`
- Compound Engineering `3.19.0`, commit `1756c0b9f3cf94493f287ea29ae766ad668fb7cf`
- Pi companions: `pi-subagents@0.34.0`, `pi-ask-user@0.13.0`

지원 platform tuple은 macOS Apple Silicon/Intel, Windows ARM64/x64, Linux x64입니다. 모든 tuple은 release archive와 내부 실행파일의 SHA-256을 별도로 고정합니다.

설치기는 release archive와 executable의 reviewed SHA-256을 모두 확인하고 `~/.oh-my-harness` 아래에 content-addressed package snapshot과 runtime을 둡니다. Claude Code와 Codex는 local marketplace/plugin, OpenCode는 local plugin, Pi는 local package로 등록됩니다. 설치된 고정 실행파일을 우선 사용하려면 셸 설정에 다음 경로를 추가합니다.

```bash
export PATH="$HOME/.oh-my-harness/bin:$PATH"
```

Windows에서는 `%USERPROFILE%\.oh-my-harness\bin`을 사용자 `PATH`에 추가하고 새 터미널을 엽니다. Windows managed runtime은 권한이 필요한 symlink 대신 검증된 `.exe`의 NTFS hardlink를 사용합니다.

한 런타임만 설치하거나 다른 절대 경로를 사용하려면 다음처럼 실행합니다.

```bash
./omh agents install --only codex --apply
./omh agents install --only claude-code,opencode,pi --root /absolute/managed/root --apply
```

OpenCode 적용 시 같은 OMP/CE 이름을 덮어쓰는 mutable predecessor `oh-my-openagent@latest`만 제거하며, 원래 config는 같은 디렉터리의 `.oh-my-harness.pre-fixed-install` backup으로 한 번 보존합니다. 이 predecessor가 전역 `skills/`에 남긴 `ce-*`와 `lfg` 디렉터리는 `.oh-my-harness.pre-fixed-skills/`로 이동해 복구 가능하게 보존합니다. 다른 OpenCode plugin과 skill은 유지합니다.

Pi 적용 시 기존의 mutable `oh-my-pi`, `oh-my-harness`, Compound Engineering source와 unpinned companion 항목만 제거하고 위 고정 local/npm source로 옮깁니다. 그 밖의 Pi package는 변경하지 않습니다. `/oh-my-pi`, `/oh-my-pi-doctor`, `omp:`, `OH_MY_PI_*` 호환 surface는 v1 동안 유지됩니다.

Pi `0.80.7` standalone release는 자체 `--version`에 `0.0.0`을 출력하므로, 설치기는 이 한 tuple에 한해 reviewed executable SHA-256을 버전 증거로 사용합니다. 다른 Pi digest나 버전 출력은 실패합니다.

개발 중인 현재 checkout을 Pi에 직접 연결하는 아래 방식도 가능하지만 mutable source이므로 고정 설치가 필요할 때는 사용하지 않습니다.

```bash
pi install .
```

## 저장소 구성

- `harness/contracts`: runtime-neutral schema
- `harness/adapters`: 네 runtime의 immutable descriptor
- `harness/profiles`: 설치·검증 대상 tuple을 닫는 profile
- `harness/inventory`, `harness/locks`: 검토된 upstream inventory와 trust receipt
- `scripts/harness`: descriptor, acquisition, upstream 검증기와 고정 버전 설치기
- `omh`, `omh.cmd`, `bin/omh.mjs`: macOS/Linux와 Windows용 통합 preview-first 관리 CLI
- `plugins/oh-my-harness`: Codex/Claude plugin manifest, 공용 skills, dependency-free MCP server
- `.agents/plugins/marketplace.json`: Codex local marketplace
- `.claude-plugin/marketplace.json`: Claude Code local marketplace
- `.opencode/plugins/oh-my-harness.js`: OpenCode native plugin entrypoint
- `extensions/env-loader`: CWD `.env`를 가장 먼저 읽는 opt-in 환경 로더
- `extensions/workspace-connectors`: Linear/Notion MCP와 read-only GitHub/GitLab CLI bridge
- `extensions/workspace-cli-tools`: Pi용 role-scoped external CLI tool pack
- `extensions/quotio-provider`: OpenAI-compatible Quotio LiteLLM provider
- `extensions/setup-doctor`: read-only setup doctor와 command palette
- `docs/profiles`: commit-safe Pi compatibility profile pack

## Workspace CLI tool pack

하나의 검증 코어를 각 런타임의 native surface로 노출합니다. Codex와 Claude Code는 각각의 plugin MCP profile, OpenCode는 native custom tools, Pi는 opt-in extension을 사용합니다.

| Runtime | Issue tracker | Wiki | Git repository |
| --- | --- | --- | --- |
| Pi | Linear `linear` | Notion `ntn` | GitHub `gh` |
| Codex | Linear `linear` | Notion `ntn` | GitHub `gh` |
| Claude Code | Jira `jira` | Confluence `confluence` | GitLab `glab` |
| OpenCode | Jira `jira` | Confluence `confluence` | GitLab `glab` |

각 runtime은 표의 세 role tool만 등록합니다. 다른 backend 도구를 이름으로 직접 호출해도 adapter가 거부합니다. 모든 명령은 shell 없이 trusted `PATH`의 실행파일로 호출하며 workspace-local shim, credential 인자, interactive/browser 플래그를 거부합니다. 조회는 바로 실행할 수 있고 write로 분류된 명령은 사용자가 해당 변경을 요청하거나 확인한 뒤 `confirmedWrite=true`가 있어야 실행됩니다.

공유 코어에는 다음 13개 role/backend 조합이 검증 가능한 전체 catalog로 남아 있습니다. Runtime profile은 이 catalog에서 정확히 세 개를 선택합니다.

| 역할 | 지원 CLI |
| --- | --- |
| Issue tracker | Jira `jira`, Linear `linear`, GitHub `gh`, GitLab `glab` |
| Wiki | Confluence `confluence`, Notion `ntn`, GitHub `gh`, GitLab `glab` |
| Git repository | GitHub `gh`, GitLab `glab` |
| Code review | CodeRabbit `cr`/`coderabbit`, GitHub `gh`, GitLab `glab` |

외부 CLI는 harness package에 포함하지 않습니다. 아래 명령은 runtime profile에서 사용하는 여섯 backend의 설치 상태를 검사하고, 빠진 CLI의 exact npm package, Homebrew formula 또는 WinGet package를 보여줍니다. 설치 명령도 기본값은 preview이며 `--apply`가 있을 때만 변경합니다. Catalog의 CodeRabbit은 `--only coderabbit`처럼 명시적으로 선택할 수 있습니다.

```bash
./omh tools doctor
./omh tools install
./omh tools install --only linear,notion,coderabbit
./omh tools install --only linear,notion,coderabbit --apply
```

Windows에서는 같은 명령을 `.\omh.cmd tools ...` 형태로 실행합니다. GitHub와 GitLab은 WinGet, Linear/Confluence/Notion은 npm을 사용합니다. JiraCLI는 공식 Windows release의 `jira.exe`를 직접 설치해 `PATH`에 추가해야 합니다. CodeRabbit CLI는 vendor가 native Windows 대신 WSL을 지원하므로 Windows에서는 `unsupported`와 WSL 안내를 표시하고 나머지 도구 설치를 계속합니다.

Jira는 `jira init`, Linear는 `linear auth login`과 `linear config`, GitHub/GitLab은 각 CLI의 `auth login`, Confluence는 `confluence init --read-only`, Notion은 `ntn login`, CodeRabbit은 `cr auth login`으로 사람에게 보이는 터미널에서 먼저 인증합니다. 인증 정보는 각 CLI가 소유하며 harness는 token을 저장하거나 명령 인자로 전달하지 않습니다.

GitHub에는 first-class `gh wiki` 명령이 없습니다. `wiki_github_cli`는 repository docs/API 조회와, 명시적으로 확인된 `gh repo clone OWNER/REPO.wiki` 경로를 제공합니다. GitLab Wiki는 `glab api`의 `/wikis` endpoint로 제한됩니다.

## Pi compatibility profile

커밋 가능한 설정 의도와 로컬 secret의 분리는 `docs/blueprints/secret-references.md`에 설명되어 있습니다. 적용 전에 deterministic lock을 검증합니다.

```bash
./omh profiles verify
./omh profiles apply --profile proxy-provider
./omh profiles apply --profile workspace
./omh profiles apply --profile full
```

`omh profiles apply`는 기본적으로 `pi install`을 실행하거나 `.env`와 settings를 수정하거나 OAuth를 시작하지 않습니다. 대신 선택한 profile에 필요한 안전한 checklist와 복사 가능한 `settings.json` package entry를 출력합니다.

그 다음 Pi 안에서 connector 노출 범위를 선택합니다.

```text
/connector-setup full
/connector-setup selective tenant:company capability:git
/connector-setup selective service:linear service:notion
/connector-setup minimal
```

## CWD `.env`

에이전트를 실행하는 작업 디렉터리의 `.env`가 환경변수 source입니다. 값은 기존 `process.env`를 덮어쓰며, 각 확장은 명시적으로 `true`인 토글만 활성화합니다.

```bash
ENABLE_QUOTIO=true
ENABLE_WORKSPACE_CONNECTORS=true
ENABLE_WORKSPACE_CLI_TOOLS=true

LINEAR_API_KEY=<local-linear-api-key>
NOTION_API_KEY=<local-notion-integration-token>
# 또는 NOTION_TOKEN=<local-notion-integration-token>

GITLAB_HOST=<company-gitlab-host>

QUOTIO_BASE_URL=<local-quotio-openai-compatible-base-url>
QUOTIO_API_KEY=<local-quotio-api-key>
```

OAuth token은 저장소 밖의 `~/.pi/agent/workspace-connectors-auth.json`에, connector setup state는 `~/.pi/agent/workspace-connectors-setup.json`에 저장됩니다. Browser OAuth를 쓸 수 없을 때만 CWD `.env`의 access key로 fallback합니다.

## 주요 명령

- `/oh-my-harness`: command palette와 setup 도움말
- `/oh-my-harness-doctor`: 환경, capability, provider, safety policy, CLI auth, 로컬 경로 점검
- `/connector-login linear|notion`: browser OAuth 시작
- `/connector-status [service]`: setup 및 auth 상태 확인
- `/connector-logout <selector> [--confirm]`: preview 후 Pi-managed OAuth state만 삭제
- `/connector-tools linear|notion`: 준비된 connector tool 목록
- `/workspace-cli-status`: Pi profile의 Linear, Notion, GitHub CLI 실행파일과 설치 가이드 확인
- `/quotio-status`: Quotio 연결과 인증 상태 확인

기존 `workspace-connectors`의 hosted Linear/Notion OAuth와 read-only GitHub/GitLab bridge는 Pi 호환 surface로 유지됩니다. 별도 `workspace-cli-tools` extension은 Pi profile의 Linear issue, Notion wiki, GitHub repository 도구만 등록하며, 각 CLI의 이미 설정된 non-interactive 인증만 재사용합니다.

## npm script 호환 surface

기존 자동화는 계속 동작합니다. 새 사용자 문서에서는 `omh`를 canonical surface로 사용하고 아래 npm scripts는 내부 개발과 이전 호출의 호환 wrapper로 유지합니다.

```text
npm run harness:install  → omh agents install
npm run tools:install    → omh tools install
npm run tools:doctor     → omh tools doctor
npm run profile:verify   → omh profiles verify
npm run profile:apply    → omh profiles apply
```

## 커밋하지 않을 항목

- `.env`와 API key 또는 token
- `node_modules/`
- `~/.pi/agent/auth.json`
- `.mcp-auth/`
- `~/.pi/agent/workspace-connectors-auth.json`
- `~/.pi/agent/workspace-connectors-setup.json`
- `~/.pi/agent/sessions/`
