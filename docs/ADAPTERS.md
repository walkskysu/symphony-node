# Tracker 适配器约定

调度核心只调用 `fetchByStates(states)`、`fetchByIds(ids)`；空参数直接返回空数组。API 失败抛出 `SymphonyError`，`category` 是稳定错误分类，`message` 是不含凭据的说明。分页失败不会返回部分结果。ID 读取返回完整快照，缺失表示当前作用域不可见。

CLI 启动时先通过 Node 原生 `process.loadEnvFile` 读取当前工作目录的 `.env`，再解析适配器的 `$ENV_NAME` 引用。已有进程环境优先；文件缺失可忽略，其他读取错误以 `env_file_error` 阻止启动。文件变更需重启。后台脚本的当前工作目录固定为项目根目录。直接调用适配器库不会自动读取 `.env`。

## file

- `tracker.kind: file`。
- `tracker.provider.path` 必填，路径相对 WORKFLOW 所在目录；支持 `~`、`$VAR_NAME`。其他 provider 字段忽略。
- `active_states`、`terminal_states` 必填。无密钥、无网络分页；整个 JSON 数组就是作用域。
- 输入 JSON 对应规范 Issue，必填 `id`、`identifier`、`title`、`state` 为非空字符串，`dispatchable` 为显式布尔值。其余字段按空值/空集合补齐。
- `id` 是调度身份，`native_ref` 按输入非密钥 JSON 对象保留。调用方不得在其中放置凭据。
- 标签去空白/小写/去重；优先级仅保留整数；时间要求带时区 RFC3339；无效可空数据变为 null。
- 状态列表读取忽略并记录不合法单条数据，ID 刷新遇到请求记录不合法会整体失败。重复 id/identifier 导致失败。
- `dispatchable` 由输入显式决定，不再解释 blocker 或 assignment。
- 错误：缺少 path 为 `invalid_tracker_config`；读取、JSON、结构错误为 `tracker_response`。
- 无 Agent 工具、无写入能力。

## linear

- `tracker.kind: linear`。
- `tracker.provider.project_slug` 必填，对应 Linear 项目的 `slugId`；所有 GraphQL 请求都带项目过滤，包括按 ID 刷新。
- `tracker.provider.api_key` 可省略，默认 `$LINEAR_API_KEY`；支持完整 `$ENV_NAME` 引用，空值报 `missing_tracker_secret`。也支持字面值，但不建议写入受版本控制文件。
- `tracker.provider.endpoint` 默认 `https://api.linear.app/graphql`，必须为 HTTPS。
- `tracker.provider.assignee_id` 可选，精确匹配才 dispatchable；不支持 `me` 别名。
- 未知 provider 字段保留但不用作请求参数。
- 默认活跃状态 Todo/In Progress；终态 Done/Canceled/Cancelled/Duplicate。
- GraphQL `issues` 每页 50 条、每个请求 30 秒超时，游标重复/缺失或者跨页重复 ID 报错。按 ID 查询每批最多 50 个。为兼容大小写状态比较，状态列表读取遍历项目作用域后本地筛选；大项目需考虑 API 成本。
- 标签每条最多读取 250 个，出现更多页时将该记录视为不可可靠归一化；状态查询忽略并记录，ID 刷新失败。其他可选字段无效时降级 null/空集合。
- `id` 为 Linear issue id，`native_ref = { issue_id }`；identifier 为 Linear 唯一 issue key。priority 1..4 正常排序，0/其他整数进入未知优先级。
- `dispatchable` 仅由可选 assignee 筛选决定；不推断 blocker 语义，`blocked_by` 为空。这是本适配器显式路由策略，可用 required_labels 进一步限定任务。
- 秘密环境变量：始终移除子进程的 `LINEAR_API_KEY`，并移除 api_key 引用的环境变量名（不区分大小写）。
- 错误：配置 `invalid_tracker_config`；密钥 `missing_tracker_secret`；网络/超时 `tracker_request`；HTTP 非成功 `tracker_status`；HTTP 429 或 GraphQL RATELIMITED `tracker_rate_limited`；无效 JSON/GraphQL errors/所需记录异常 `tracker_response`；游标完整性 `tracker_pagination`。不在适配器内部无限重试，由调度器下次轮询/退避处理。
- 无 Agent 工具、无写入能力；不会替操作员更改状态或发布评论。

实现参考：[Linear 官方 GraphQL 文档](https://linear.app/developers/graphql)。真实账号集成尚未验收。

## github

- `tracker.kind: github`；一个实例读取一个仓库，不读取 GitHub Projects 看板状态。
- `tracker.provider.repo` 必填，格式 `owner/repository`，不带 URL 或 `.git`；转换为小写作为稳定作用域。切换仓库应使用新的 workspace.root。
- `tracker.provider.api_key` 默认 `$GITHUB_TOKEN`；支持字面值或完整 `$ENV_NAME` 引用，缺失/空值报 `missing_tracker_secret`。即使公开仓库也要求配置令牌，以提供稳定的认证请求行为；不读取 `gh auth` 的凭据存储。
- `tracker.provider.endpoint` 默认 `https://api.github.com`，Enterprise 示例 `https://github.example.com/api/v3`。只接受 HTTPS，不接受内嵌账号密码、query、fragment；HTTP 重定向不自动跟随，仓库迁移后应更新配置。
- `tracker.provider.assignee` 可选，GitHub login，不区分大小写；任何一个 assignee 匹配即可。路由不匹配的任务仍会返回，`dispatchable=false`，交给调度器筛选。`me` 不作为特殊别名。
- 默认活跃 `open`、终态 `closed`；配置只允许这两个原生状态，标签由调度器过滤。未知 provider 字段忽略。
- REST API 固定版本 `2022-11-28`。列表请求 `/repos/{owner}/{repo}/issues`，每页 100 条，30 秒超时；支持 `Link: rel="next"`，验证同 host 和同仓库路径、拒绝重复页或重复 issue。过滤带 `pull_request` 的记录。
- ID 是适配器自有 `owner/repo#number`，identifier 相同；按 ID 在同仓库使用单条 issue 接口刷新，输入去重，外部仓库 ID 不发请求；404/410 表示不可见。列表 404 是请求失败，不是空列表。多条刷新按序完成，任何异常整体失败。
- `native_ref` 包含 repository、issue_number 和 GitHub 数字 issue_id（可空）；正文映射 description，标签归一化，GitHub 的用户数字 id 作为 assignee_id（多负责人时取首位）。无标准优先级映射，priority=null，branch_name=null，blocked_by=[]。不推断依赖阻塞语义。
- 状态查询遇到单条必需字段异常会记录并忽略；单条刷新异常或身份不符整体报 `tracker_response`。其余可空数据沿用核心归一化约定。
- 子进程移除 `GITHUB_TOKEN`、`GH_TOKEN`、`GH_ENTERPRISE_TOKEN`、`GITHUB_ENTERPRISE_TOKEN`，以及 api_key 引用的自定义环境变量。Git 自身认证需要单独配置。
- 网络/超时 `tracker_request`；401/403 等非成功或重定向 `tracker_status`；429、带剩余额度 0 或 Retry-After 的 403 为 `tracker_rate_limited`；JSON/数据结构错误 `tracker_response`；分页完整性/越界 `tracker_pagination`；配置错误 `invalid_tracker_config`。消息不包含服务器原始响应或密钥。
- 默认只读模式无 Agent 工具，Tracker token 只需要指定仓库的 Issues read 权限。
- `provider.automation.enabled: true` 开启 GitHub 原生工具和完整 Issue → PR 执行扩展。`test_command` 必填，base_branch 默认仓库默认分支；其余配置、工具 schema、写入权限、幂等与错误语义见 [GITHUB_AUTOMATION.md](GITHUB_AUTOMATION.md)。启用时 review/blocked 标签令 `dispatchable=false`，同一会话绑定固定配置与凭据。

参考：[GitHub Issues REST API](https://docs.github.com/en/rest/issues/issues)、[分页文档](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)。真实仓库尚未验收。
