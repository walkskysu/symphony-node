# 完整 GitHub Issue → PR 流程

启用 `tracker.provider.automation.enabled: true` 后，Symphony 从有指定标签的 Issue 开始，自动准备仓库、创建独立分支、运行 Codex、执行强制检查、提交、推送、创建草稿 PR，并把 Issue 交给人工审查。默认不自动合并 PR；PR 描述包含 `Closes #编号`，合并后由 GitHub 的关联规则关闭 Issue。

## 配置

使用 [examples/WORKFLOW.github-auto.md](../examples/WORKFLOW.github-auto.md)，修改：

1. `tracker.provider.repo`：实际的 `owner/repository`。
2. `automation.test_command`：项目真实的验证命令。该项必填，退出码非 0 时不推送、不创建 PR。Windows PowerShell 使用 `npm.cmd test`，其他平台使用 `npm test`；仅适合 npm 项目。Windows 上显式使用 `.cmd` 可避免 npm 安装的 `.ps1` 入口被脚本执行策略拦截；无需修改系统执行策略。省略 `codex.command` 时服务会自动选择平台对应的入口。
3. 可选 `hooks.before_run`：安装依赖或准备构建环境，例如有 lockfile 的 npm 项目使用 `npm ci`。钩子在 Windows 中使用 PowerShell，多个命令应明确检查每条外部命令的退出码。
4. `base_branch` 默认采用 GitHub 默认分支；可指定其他目标分支。

自动模式使用新的 `github-auto-workspaces` 目录，与旧版 `after_create: git clone` 的目录分开。不要再配置克隆钩子，仓库准备由主进程完成。已有非自动模式仓库没有所有权记录时会拒绝接管，保留原有数据。

在项目根目录 `.env` 填入令牌：

```dotenv
GITHUB_TOKEN=github_pat_你的令牌
```

Fine-grained PAT 选择目标仓库，权限需要：

| Repository permission | 权限 | 用途 |
| --- | --- | --- |
| Contents | Read and write | 拉取仓库、推送任务分支 |
| Issues | Read and write | 读取任务、维护评论和标签 |
| Pull requests | Read and write | 查询、创建 PR |
| Metadata | Read-only（自动附带） | 仓库信息 |

如果需要修改 `.github/workflows`，GitHub 还可能要求 Workflows 写入权限；本版本不会通过扩大令牌权限来绕过服务端限制。组织策略、分支规则、令牌审批也可能限制推送。

参考：[GitHub 创建 PR](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)、[Issue 评论](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)、[Fine-grained PAT 权限](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)。旧版只读模式仍只需要 Issues read。

```powershell
cd C:\aisrc\Symphony
npm run build
npm start -- .\examples\WORKFLOW.github-auto.md --check
npm start -- .\examples\WORKFLOW.github-auto.md
# 或：
# .\scripts\start-background.ps1 -Workflow .\examples\WORKFLOW.github-auto.md
```

`--check` 仅检查配置和密钥存在，不执行网络写入，不证明账号权限已齐备。修改 `.env` 后重启。

## 状态与使用方法

| Issue 标签/状态 | 行为 |
| --- | --- |
| open + `symphony` | 开始或继续处理 |
| `symphony:review` | PR 已准备好，停止调度，工作区保留 |
| `symphony:blocked` | 需要人工提供信息，停止调度，工作区保留 |
| closed | 终态清理工作区，请先保存需要的成果 |

服务会自动创建 review/blocked 标签。完成交接时先更新评论、添加 review 标签，再删除第一个 required_labels 标签，其他业务标签保留。即使删除 dispatch 标签失败，review/blocked 标签也会阻止再次派发。

解决阻塞后，在 Issue 中补充说明，移除 blocked 标签并确保 `symphony` 标签存在。评论与任务正文会通过 `github_issue_context` 提供给 Agent。

当前交接边界是 PR 创建成功；不自动跟随 PR 审查意见继续修改，不自动合并。已有相同分支的 Symphony PR 会恢复原交接，而不是重复创建。关闭但未合并的已有 PR 会标记 blocked，由人工决定下一步。

## 执行与失败恢复

- 分支固定为 `symphony/issue-<number>`，明确推送此单一分支，不 force-push、不推送默认分支。
- 仓库 `.git/symphony-owner.json` 保存仓库、任务、分支和原始基线。重试复用已有提交和未提交修改，不 hard reset。
- 检查成功后提交未忽略的工作区变更；已有提交也会重新检查后再推送。仓库应正确配置 `.gitignore`，避免提交依赖/构建产物。检测到已跟踪或未忽略的 `.env*`（除 example/sample）时拒绝发布。
- GitHub token 仅供主进程 HTTP 和短暂的宿主 Git 认证使用。它不放进 clone URL、命令行参数、Git 配置文件，也不传给 Codex/钩子/测试命令。Git 通过进程专属配置环境接收认证头。
- PR 创建响应丢失时，按仓库、目标分支、任务分支和标记查询并恢复；重启后可找到同一个 PR。
- 同一身份只维护一条带标记的进度评论；不会修改其他用户创建的评论。失败评论只包含分类，不复制原始错误/凭据。
- 测试失败返回有限诊断给 Agent 修复；退出前未创建 PR 或报告阻塞视为失败，进入已有的指数重试流程。
- 取消会终止本地 Git/测试进程并取消 HTTP 请求；已被 GitHub 接受的写入不能回滚，后续尝试通过查询恢复。
- 一次提交/推送/评论并非分布式事务。仅允许一个实例使用同一仓库任务工作区；跨机器并发调度未实现分布式锁。

## Agent 工具边界

启用自动模式时通过 Codex app-server 的 experimental dynamicTools 宣告：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `github_issue_context` | `{}` | 读取本 Issue 及评论 |
| `github_update_progress` | `{summary}` | 更新本 Issue 的进度评论 |
| `github_publish_pull_request` | `{title, summary}` | 强制检查、提交、推送、创建 PR、交接 |
| `github_report_blocked` | `{reason}` | 写阻塞说明并暂停派发 |

参数不能选择其他仓库、Issue、目标分支或测试命令；这些来自本次会话的受信配置。工具串行执行。正在执行的主进程工具发送心跳，避免耗时测试被误判为 Agent 停滞。所有请求有超时或取消边界。

这是受信仓库与受信工作流模式。宿主测试命令/钩子会执行仓库代码；隔离工作目录和隐藏凭据不等同于 OS 级恶意代码隔离。需要更强隔离时应使用独立账户/VM。

## 验证范围

测试使用模拟 GitHub HTTP 与真实本地 bare Git 仓库，覆盖成功交接、失败检查阻断、单评论维护、响应丢失恢复、阻塞标签、跨任务参数拒绝和真实分支推送。Codex dynamicTools 的消息结构与本机 0.148.0 experimental Schema 核对，并通过模拟子进程测试。

没有使用你的真实令牌进行评论、推送或创建 PR。真实 GitHub + 真实模型的完整联调仍需要配置目标仓库和真实测试命令后执行。
