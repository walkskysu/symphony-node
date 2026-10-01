# 兼容性与验收记录

基线：[Symphony SPEC.md，Draft v1](https://raw.githubusercontent.com/openai/symphony/refs/heads/main/SPEC.md)，阅读日期 2026-09-29。上游 main 可变，后续升级需再次核对。

协议参考：[Codex App Server 官方文档](https://developers.openai.com/codex/app-server/)，并在本机使用 `codex-cli 0.148.0` 生成 JSON Schema，核对了 initialize、thread/start、thread/name/set、turn/start、turn/completed、token usage 及 dynamic tool failure 结构。生成目录 `.protocol-schema` 不纳入发布文件。

| 规范模块 | 本版本实现 | 验证方式 |
| --- | --- | --- |
| 工作流和配置 | YAML/Liquid、默认值、路径、环境变量、严格模板、动态重载 | 自动化测试 |
| Tracker | 本地 JSON、Linear 项目、GitHub 仓库 Issues 读取/分页/ID 刷新 | 本地文件和模拟 HTTP |
| 编排 | claim、排序、全局/状态并发、启动清理、校对、退避、继续执行 | 可控时钟与模拟 worker |
| 工作区 | 确定性命名、哈希后缀、根目录校验、junction 拒绝、4 类钩子 | Windows 文件系统与真实 PowerShell |
| Agent | stdio NDJSON、握手、同线程多轮、超时、取消、拒绝交互请求 | 子进程模拟 app-server |
| GitHub 自动化扩展 | 主进程工具、强制测试、Git 分支/提交/推送、草稿 PR、评论与标签交接 | 模拟 HTTP + 真实本地 bare Git + 模拟 app-server |
| 可观测性 | JSON 日志、Token 去重、时长、限流快照、HTTP API | 自动化测试 |
| Windows 后台 | 隐藏启动、PID/启动时间校验、进程树结束 | 本机启动/停止 smoke |

## 已知差异和限制

1. Windows 默认 PowerShell 启动 Codex，规范第 5.3.6/10.1/17.5 节写的是 Bash。可配置 `runtime.shell: bash`，但本次未验证 Git Bash/WSL 环境。
2. Windows 不可表示的原始 identifier（CON、NUL、末尾点、`.`、`..`）拒绝运行；不静默改写为另一个可碰撞目录。长路径仍受宿主配置约束。
3. 已提供 GitHub provider-native 工具和 Issue → PR 扩展；未实现 SSH worker、持久重试队列、Windows SCM 注册、日志轮转。GitHub 自动化不包含自动合并或 PR 审查反馈循环。
4. Tracker/API 请求带 30 秒超时；停止可能等待已发出的 Tracker 请求结束。强制终止无法保证 `after_run`，正常停止会执行。
5. 配置检查使用 1 秒文件轮询，定时调度分辨率约 200ms。重试由单调时钟的到期队列实现，无独立每任务 OS timer。
6. `after_run` 与现有 Agent 会话沿用启动时配置；已有会话不会因热更新而重启。HTTP 端口重载需重启。
7. 测试不是完整规范矩阵的独立认证；真实 Linear 权限、数据、限流场景仍需验收。真实 GitHub + Codex 已完成一次端到端测试，见下述记录。默认可选真实 Codex 测试显式 SKIP。

## 开发验证

Windows / Node.js v24.19.0：`npm run check`、`npm run build`、`npm test`。测试先编译 TypeScript，再使用 Node 原生 `node:test`，无需 tsx。

2026-09-29 加入 GitHub 适配器后的结果：35 项测试，34 通过、0 失败、1 项真实 Codex 集成显式跳过。GitHub 测试覆盖分页、PR 排除、作用域、身份刷新、负责人、凭据隔离、错误分类和 Enterprise 路径，真实 GitHub 仓库尚未验证。配置示例已通过本地 `--check`。此前后台脚本使用空任务源和端口 18881 完成启动、HTTP 200 状态检查及停止；验证结束后已停止测试守护进程。

2026-09-30：增加 GitHub 自动开发交接扩展，协议基线使用本机 Codex 0.148.0 `generate-json-schema --experimental` 核对 dynamicTools 的 function 类型、输入 schema 和调用响应。完整回归 49 项：48 通过、0 失败、1 项真实 Codex 集成显式跳过；新增自动化配置通过 `--check`。覆盖实际本地 Git 推送、检查失败阻断、PR 响应丢失恢复、进度评论复用、工具心跳和取消。真实账号上的 GitHub 写入与真实模型完整联调尚未执行。

2026-10-01 复核：真实 GitHub + Codex 0.159.2 已完成 `walkskysu/space-tetris` Issue #1 → 草稿 PR #2，全流程含 22 项游戏测试、真实推送、评论和标签交接。修复 Windows 默认启动入口及持久交接后模型错误误报，最新回归 51 项：50 通过、0 失败、1 项可选测试跳过。详见 [实测记录](SPACE_TETRIS_E2E.md)。这不代表所有异常场景或完整 Symphony 规范均已认证。

受限沙箱内的 Windows `taskkill /T` 被 OS 拒绝；已在正常宿主权限下运行进程相关测试并清理模拟进程。此问题说明进程树终止权限是部署验收的一部分。
