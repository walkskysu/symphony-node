---
tracker:
  kind: github
  provider:
    repo: walkskysu/space-tetris
    api_key: $GITHUB_TOKEN
    automation:
      enabled: true
      test_command: npm.cmd test
      draft: true
  active_states: [open]
  terminal_states: [closed]
  required_labels: [symphony:e2e]
polling:
  interval_ms: 15000
workspace:
  root: ../.symphony/space-tetris-workspaces
agent:
  max_concurrent_agents: 1
  max_turns: 10
codex:
  command: '& ''C:/aisrc/Symphony/.symphony/codex-runtime/node_modules/.bin/codex.cmd'' app-server'
  approval_policy: never
  thread_sandbox: workspace-write
  read_timeout_ms: 30000
  stall_timeout_ms: 900000
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: false
server:
  port: 8081
---
Implement {{ issue.identifier }}: {{ issue.title }}.
{{ issue.description }}

Read repository instructions and the issue discussion. Complete the implementation and meaningful regression tests in the prepared workspace. Write files incrementally in focused patches, starting with the game engine and tests. Use the host GitHub tools to report progress and publish a draft PR. All dependencies needed by this task are built into Node and the browser. Do not spawn subagents. Preserve existing work on retries.
{% if attempt %}Retry attempt {{ attempt }}. Inspect existing work first.{% endif %}
