# Symphony Node

用 TypeScript / Node.js 实现的 Symphony 后台调度服务，可在 Windows 本地运行。

当前版本为 **0.1.0 开发实现**，依据 2026-09-29 阅读的 [Symphony Draft v1 规范](https://raw.githubusercontent.com/openai/symphony/refs/heads/main/SPEC.md)。核心链路和模拟协议测试已实现，尚未完成真实 Linear + Codex 的生产验收。Windows 默认 PowerShell 是对规范 `bash -lc` 启动约定的明确平台适配；不宣称已通过完整规范认证。

## 快速运行（PowerShell）

需要 Node.js 22+、npm，以及已经安装并登录的 Codex CLI。开发时核对的本机版本为 `codex-cli 0.148.0`。本项目不需要单独配置 OpenAI API SDK；模型认证由 Codex CLI 管理。

```powershell
cd C:\aisrc\Symphony
npm ci
npm run build
npm start -- --check
npm start
```

打开 <http://127.0.0.1:8080> 查看状态。按 Ctrl+C 停止，运行中的子进程会被清理，任务工作区保留。默认 `examples/issues.json` 是空数组，因此首次启动不会执行真实任务。

管理控制台提供任务看板/列表、搜索筛选、任务详情、运行指标、活动记录和服务概览，接入实时状态接口，详见 [控制台说明](docs/DASHBOARD.md)。使用 space-tetris 示例工作流时地址为 <http://127.0.0.1:8081>。

若 npm 缓存目录没有写权限，可使用 `npm ci --cache .symphony/npm-cache`。

### 后台运行

```powershell
.\scripts\start-background.ps1
Get-Content .\.symphony\stderr.log -Wait
.\scripts\stop-background.ps1
```

启动脚本隐藏窗口，记录 PID 和进程启动时间，防止误停复用 PID 的其他进程。停止脚本使用 Windows `taskkill /T /F` 结束整个进程树，是强制停止，不执行 `after_run`。前台 Ctrl+C 是正常退出路径。日志在 `.symphony`；此版本未实现日志轮转。

这是一项常驻 Node 进程，**尚未注册为 Windows SCM 服务，也不会自动开机启动**。后台进程默认随用户会话运行；需要长期托管时可由 Windows 任务计划程序调用 `node.exe`，参数为 `C:\aisrc\Symphony\dist\src\cli.js C:\aisrc\Symphony\WORKFLOW.md`，起始目录为项目目录。应仅运行一个使用同一工作区根目录的实例。

## 添加本地任务

将 `examples/issue.sample.json` 中的示例复制到 `examples/issues.json` 即可进入调度。真实模型运行可能产生费用，且会按任务内容修改独立工作区中的文件。

```json
[
  {
    "id": "local-1",
    "identifier": "LOCAL-1",
    "title": "创建一个 hello-world 模块",
    "description": "创建 hello.js 和 node:test 测试，并运行验证。",
    "state": "Todo",
    "priority": 2,
    "labels": ["symphony"],
    "dispatchable": true
  }
]
```

- 任务在 `.symphony/workspaces/LOCAL-1` 运行，支持失败后复用目录。
- 将状态改为 `Human Review` 等非活跃状态会停止继续执行，保留工作区。
- 将状态改为 `Done` 会终止运行并删除该任务工作区。请先保存需要保留的结果。
- **模型完成一轮不代表工单完成。** 如果任务一直处于活跃状态，服务会在 `max_turns` 后继续排队执行。示例不提供 Tracker 写入工具，需要操作员及时更新任务状态。
- 更新 JSON 时建议写入临时文件后原子替换；解析失败时服务保持已有运行任务，并等下一次轮询。

## Linear

```powershell
$env:LINEAR_API_KEY = 'your-token'
npm start -- .\examples\WORKFLOW.linear.md --check
npm start -- .\examples\WORKFLOW.linear.md
```

先修改示例中的 `project_slug` 和仓库地址。此适配器使用项目的 **slugId** 筛选。`after_create` 可通过 Git 克隆仓库，Windows 钩子使用 PowerShell 语法。Linear 凭据仅用于主进程读取，不传给 Agent 或钩子。当前未提供写入 Linear 的动态工具，因此状态交接由操作员处理。完整适配器约定见 [docs/ADAPTERS.md](docs/ADAPTERS.md)。

## GitHub 自动开发并创建 PR

已在 `walkskysu/space-tetris` 完成一次真实 Issue → 草稿 PR 测试，包含自动开发、测试、推送和 Issue 进度交接，见 [实测结果与专用配置](docs/SPACE_TETRIS_E2E.md)。

完整流程已经支持：Issue → 独立任务分支 → Codex 开发 → 强制测试 → Git 提交/推送 → 草稿 PR → Issue 评论与审查标签。

使用 [examples/WORKFLOW.github-auto.md](examples/WORKFLOW.github-auto.md)，填写 `provider.repo` 和项目真实的 `automation.test_command`。需要安装依赖时配置 `hooks.before_run`（例如 `npm ci`）。主进程自动准备 Git 仓库，无需克隆钩子。

`.env` 的 fine-grained PAT 需要目标仓库的 **Contents、Issues、Pull requests 三项 Read and write** 权限，详见 [GitHub 权限文档](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)。

```powershell
npm run build
npm start -- .\examples\WORKFLOW.github-auto.md --check
npm start -- .\examples\WORKFLOW.github-auto.md
```

给 open Issue 加 `symphony` 标签后开始执行。完成后自动添加 `symphony:review` 并移除调度标签，等待人工审查；需要人工输入时添加 `symphony:blocked`。不会自动合并 PR。测试失败不推送，重试复用分支和进度评论。完整配置、恢复语义、工具权限见 [GitHub 自动化说明](docs/GITHUB_AUTOMATION.md)。

## GitHub Issues（只读任务源）

编辑 [examples/WORKFLOW.github.md](examples/WORKFLOW.github.md)，把 `provider.repo` 与 `git clone` 地址里的 `YOUR_OWNER/YOUR_REPO` 改成实际仓库，例如 `my-org/my-app`。

```yaml
tracker:
  kind: github
  provider:
    repo: my-org/my-app
    api_key: $GITHUB_TOKEN
  active_states: [open]
  terminal_states: [closed]
  required_labels: [symphony]
```

在 GitHub 创建限定到目标仓库的 fine-grained PAT，Tracker 所需仓库权限为 **Issues: Read-only**（[官方接口权限说明](https://docs.github.com/en/rest/issues/issues#list-repository-issues)）。将令牌填入项目根目录 `.env`（没有此文件时可复制 `.env.example`）：

```dotenv
GITHUB_TOKEN=你的令牌
```

然后在项目目录启动：

```powershell
cd C:\aisrc\Symphony
npm run build
npm start -- .\examples\WORKFLOW.github.md --check
npm start -- .\examples\WORKFLOW.github.md
# 或后台启动（同样自动读取项目根目录 .env）：
# .\scripts\start-background.ps1 -Workflow .\examples\WORKFLOW.github.md
```

`--check` 仅验证本地配置，不验证仓库权限或网络连接。不要把令牌写入 WORKFLOW 或发送到聊天中。

CLI 在启动时自动读取当前工作目录下的 `.env`，不存在时继续使用环境变量；已有环境变量优先，不会被 `.env` 覆盖。如果之前在当前 PowerShell 中设置过旧令牌，可执行 `Remove-Item Env:\GITHUB_TOKEN -ErrorAction SilentlyContinue` 后再启动。修改 `.env` 后需重启服务；`.env` 已在 `.gitignore` 中。使用后台脚本时工作目录固定为项目根目录，因此读取 `C:\aisrc\Symphony\.env`。Linear 的 `LINEAR_API_KEY` 也可以用同样方式配置。

给需要处理的 **open Issue** 添加 `symphony` 标签即可调度。PR 会自动排除。可增加 `provider.assignee: your-login` 限定负责人。GitHub 原生状态是 `open`/`closed`，不读取 Projects 看板的 Todo/In Progress 字段。

此只读配置下，工作完成准备审查时，先移除 `symphony` 标签来停止执行并保留工作区；一直保留标签且不关闭，服务会继续执行。关闭 Issue 会在校对、重试检查或下次启动清理中删除相应工作区，需先保存/推送成果。此模式不自动评论、关 Issue、提交 PR 或推送代码。

私有仓库的 `git clone` 需要提前配置好 Git 自身的认证（例如 Git Credential Manager 或 SSH，并将 clone URL 改为 SSH 地址）。Tracker 的 `GITHUB_TOKEN` 不会传入钩子或 Agent，读取 Issues 的令牌不能替代 Git 的克隆认证。GitHub Enterprise 可配置 `provider.endpoint: https://github.example.com/api/v3`。

本次仅验证模拟 GitHub HTTP 响应；尚未接入你的真实仓库。

## 配置与动态更新

`WORKFLOW.md` 包含 YAML front matter 和 Liquid 提示词，模板输入为 `issue`、`attempt`。未知变量或过滤器使本次执行失败。

支持规范中的 `tracker`、`polling`、`workspace`、`hooks`、`agent`、`codex`。路径相对 WORKFLOW 所在目录解析，支持 `~` 和完整 `$ENV_NAME` 引用；命令字符串原样交给 shell。未知字段保留或忽略。

每秒检查配置，并在调度前重新读取。有效变更自动生效；无效配置保留最后有效版本继续校对运行任务，同时阻止新调度和重试执行。已有 Agent 使用启动时的配置、提示词和 Tracker 快照，未来会话使用新配置。

扩展字段：

| 字段 | 默认值 | 行为 |
| --- | --- | --- |
| `runtime.shell` | Windows `powershell`，其他系统 `bash` | `powershell.exe -NoProfile -NonInteractive -EncodedCommand` 或 `bash -lc`；下次运行生效 |
| `server.port` | 不启用 HTTP | 0 为临时端口；修改需重启；CLI `--port` 优先 |

如需使用规范中的 Bash 启动形式，设置 `runtime.shell: bash` 并提供 PATH 中可用、能运行 Node/Codex 的 Bash 环境。当前实际测试平台为 Windows + PowerShell；没有验证 WSL 路径转换。

默认策略为 `approval_policy: never`、`thread_sandbox: workspace-write`、`turn_sandbox_policy: { type: workspaceWrite }`。这表示 Agent 不能交互请求提权，执行权限仍受 Codex 沙箱限制。如果服务收到审批或用户输入请求，会失败并重试，不会自动授权。协议策略字段透传给 Codex，不硬编码完整枚举。

## 状态与日志

- `GET /`：每 5 秒刷新的人类可读状态页。
- `GET /api/v1/state`：运行、重试、Token、运行时长、限流信息、配置健康状态。
- `GET /api/v1/<identifier>`：当前内存中的任务运行或重试信息；未知任务 404。
- `POST /api/v1/refresh`：请求立即校对和轮询，返回 202。

HTTP 仅绑定 `127.0.0.1`，未提供身份认证，不应通过代理暴露到公网。结构化 JSON 日志写到 stderr，包含任务与会话标识，不记录原始 Agent 输出或 Tracker 凭据。

## 架构

```text
WORKFLOW.md → Workflow / Config → Orchestrator（单一调度状态）
                                   ├── Tracker（file / linear / github）
                                   ├── Workspace / Hooks
                                   └── Agent Runner → Codex app-server（stdio）
                                            └── 事件 / Token → 状态与日志
```

状态保存在内存，重启后重新读取 Tracker、清理终态工作区并复用活跃任务目录；不恢复旧会话或重试计时。重试采用单调时钟，普通完成后 1 秒继续检查，异常重试从 10 秒指数增长并受配置上限约束。

## 验证

```powershell
npm run check
npm test
```

测试覆盖工作流、严格模板、路径越界/junction 防护、钩子、Tracker、分页、调度、重试、热更新错误恢复、Token 去重、HTTP 和模拟 app-server。测试创建独立的系统临时目录，不访问真实 Tracker。

真实 Codex 检查需要显式启用，可能使用模型额度：

```powershell
$env:SYMPHONY_REAL_CODEX = '1'
npm test
Remove-Item Env:\SYMPHONY_REAL_CODEX
```

Windows 进程生命周期测试需要测试进程有权终止自己创建的进程树；受限执行沙箱可能禁止 `taskkill /T`。详见 [兼容性与验收记录](docs/CONFORMANCE.md)。

## 信任边界

WORKFLOW 中的 shell 命令与钩子是受信配置。工作区路径检查防止常规越界与 junction 指向外部目录，但不能替代 OS 级隔离，也不能防御拥有同一账户权限的恶意并发文件系统修改。请仅接入受信仓库/任务。服务不修改全局 Codex 配置、不自动安装 Windows 服务。只有显式启用 GitHub automation 的工作流才会使用主进程提交/推送、创建 PR 和回写 Issue。
