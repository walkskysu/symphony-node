# 多 GitHub 仓库

将 `tracker.provider.repo` 替换为 `tracker.provider.repositories`，两者不可同时配置。单仓库 `repo` 配置继续兼容。

```yaml
tracker:
  kind: github
  provider:
    api_key: $GITHUB_TOKEN
    automation:
      enabled: true
      test_command: npm.cmd test
      draft: true
    repositories:
      - walkskysu/space-tetris
      - repo: walkskysu/symphony-node
        api_key: $SYMPHONY_REPO_TOKEN
        automation:
          test_command: npm.cmd test
          base_branch: main
  required_labels: [symphony]
```

未指定仓库级 `api_key` 时共用 `GITHUB_TOKEN`。共用 fine-grained PAT 时需授权列表中的所有仓库；自动开发需要 Contents、Issues、Pull requests 读写权限。若使用第二个变量，在项目根目录 `.env` 中填写 `SYMPHONY_REPO_TOKEN=...`，不要提交令牌。`.env` 只在服务启动时读取，修改令牌后需重启。

仓库条目可用字符串或映射。映射允许覆盖 `api_key`、`assignee` 和 `automation`。`automation` 按字段继承共享设置，仓库级 `enabled: false` 可关闭该仓库的宿主发布集成；此项不等于禁止 Agent 运行，是否派发仍由状态、标签和负责人决定。

API endpoint、调度标签、活跃/终态、钩子、Codex 设置共用一个工作流。不支持在仓库条目中覆盖这些字段；不同 GitHub Enterprise 主机应使用独立工作流/服务。`agent.max_concurrent_agents` 是所有仓库共用的并发上限，当前没有按仓库配额或轮流公平调度保证。

## 隔离与故障处理

- 任务身份使用 `owner/repository#number`；工作区键包含仓库与 Issue，跨仓库同编号不会冲突。
- 查询、评论、测试、Git 推送和 PR 创建均路由到任务所属仓库，分支名可同为 `symphony/issue-1`，但位于不同仓库。
- 所有配置引用的令牌环境变量都会从 Agent、钩子和测试进程环境中剔除，包括其他仓库的令牌。
- 任一仓库查询失败时整次查询失败，不返回部分结果。控制台保留旧快照并提示异常；已有任务不会因为一次读取失败被误判删除。可用仓库也会等待下一次完整刷新，因此应及时修复失效令牌或仓库权限。
- 工作流热更新可增减仓库。被移除仓库的任务在下一次成功核对后停止，工作区保留；在途集成使用任务启动时的仓库与凭据配置。

## 控制台

多仓库时出现“仓库”选择框，可筛选看板和列表；搜索和任务状态筛选可叠加使用。顶部运行指标和活动页仍汇总所有仓库，详情显示所属仓库。服务页列出全部仓库，不返回密钥。

## 启动示例

```powershell
npm.cmd run build
node dist/src/cli.js examples/WORKFLOW.github-multi.md --check
node dist/src/cli.js examples/WORKFLOW.github-multi.md
```

示例监听 `http://127.0.0.1:8082`，使用独立工作区目录。请先检查仓库列表、PAT 权限和各仓库测试命令，再启动。不要与另一实例同时自动处理同一仓库的同一批 Issue。`--check` 只验证本地配置，不验证 GitHub 权限。

已用模拟 GitHub HTTP 验证跨仓库身份、ID 路由、凭据/写入隔离、故障原子性、配置继承和全局并发；单仓库分页行为由既有测试覆盖。2026-10-01 使用现有令牌成功只读查询 `walkskysu/space-tetris` 与 `walkskysu/symphony-node`，查询当时均没有 open Issue。未对第二个真实仓库创建额外测试 Issue 或 PR，多仓库写入路由由模拟接口测试验证。
