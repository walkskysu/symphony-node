# Space Tetris 真实集成测试

目标仓库：<https://github.com/walkskysu/space-tetris>。

工作流：`examples/WORKFLOW.space-tetris.md`，使用启动目录 `.env` 的 `GITHUB_TOKEN`。只处理带 `symphony:e2e` 标签的 open Issue，单任务运行，在 `symphony/issue-N` 分支开发，通过 `npm.cmd test` 后发布草稿 PR。完成后回写进度并添加 `symphony:review` 标签；人工审查和合并。

Windows 启动：

```powershell
npm.cmd run build
node dist/src/cli.js examples/WORKFLOW.space-tetris.md --check
node dist/src/cli.js examples/WORKFLOW.space-tetris.md
```

状态接口：`http://127.0.0.1:8081/api/v1/state`。Ctrl+C 正常停止。不要同时启动两个使用相同工作区根目录的实例。

首次实测的 Issue：<https://github.com/walkskysu/space-tetris/issues/1>，任务是实现无第三方依赖的可玩太空 Tetris 原型，并用 Node 内建测试覆盖游戏核心逻辑。

## 完成结果（2026-10-01 复核）

- 已完成真实 Issue → Codex 开发 → 强制测试 → Git 提交/推送 → 草稿 PR → 评论/标签交接。
- 草稿 PR：<https://github.com/walkskysu/space-tetris/pull/2>，提交 `d9fe185d5470ba8c809ff8c6bcbef4a621ac1bcf`，分支 `symphony/issue-1`。尚未合并。
- Issue 保持 open，标签为 `symphony:review`；调度标签已移除，进度评论指向 PR。不会因普通轮询再次派发。
- 游戏最终 22 项测试全部通过，覆盖核心规则、输入事件和 HTTP 服务；本地工作树干净，与 PR 提交一致。
- 当前对话曾独立进行浏览器检查：开始、移动、旋转、硬降计分、暂停、重开正常，控制台无错误。截图位于 `.symphony/space-tetris-preview.jpg`。PR 中“无浏览器”的说明仅针对后台 CLI 会话。
- 测试守护进程已停止。日志中交接后的 `turn_failed` 来自模型额度耗尽，发布早已成功；现已修复 runner，以宿主持久交接结果为准，并单独记录交接后的模型错误。
- 修复后 Symphony 回归测试 51 项：50 通过、0 失败、1 项可选真实模型测试跳过；新增测试同时验证交接前失败仍按失败处理。

实测发现的环境问题：

- PowerShell 默认会选中 npm 安装的 `.ps1` 启动脚本，本机执行策略会拒绝它。Windows 工作流显式使用 `npm.cmd`，服务默认入口改为 `codex.cmd`，无需修改执行策略。
- 本机 Codex CLI 0.148.0 被所配置模型拒绝，提示升级 CLI。新版 CLI 隔离安装在 `.symphony/codex-runtime`，不覆盖全局安装。该目录被 Git 忽略。

若需重装隔离 CLI：

```powershell
npm.cmd install --prefix .symphony/codex-runtime @openai/codex@0.159.2 --no-audit --no-fund
```

工作流中的 CLI 路径必须指向本机实际安装位置；移动项目目录后同步更新该路径。仅提供相应测试仓库的 Contents、Issues、Pull requests 读写权限；不要把令牌写入工作流、Git URL 或提交内容。
