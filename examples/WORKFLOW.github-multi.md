---
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
      - walkskysu/AIAppNest
      - repo: walkskysu/symphony-node
        automation:
          test_command: npm.cmd test
          # base_branch: main
        # Use a separate environment variable if this repository needs another PAT:
        # api_key: $SYMPHONY_REPO_TOKEN
        # assignee: walkskysu
  active_states: [open]
  terminal_states: [closed]
  required_labels: [symphony]
polling:
  interval_ms: 30000
workspace:
  root: ../.symphony/multi-repository-workspaces
agent:
  max_concurrent_agents: 2
  max_turns: 10
codex:
  # Use the locally installed CLI compatible with the configured model.
  command: '& ''C:/aisrc/Symphony/.symphony/codex-runtime/node_modules/.bin/codex.cmd'' app-server'
  approval_policy: never
  read_timeout_ms: 30000
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: false
server:
  port: 8082
---
Implement {{ issue.identifier }}: {{ issue.title }}.
Repository: {{ issue.native_ref.repository }}
Issue URL: {{ issue.url }}

{{ issue.description }}

Read the repository instructions and issue discussion. Work only in the prepared issue workspace.
Implement the requested change and meaningful tests. Use the host-provided GitHub tools to report progress and publish the draft PR.
Write files incrementally and preserve existing progress on retries. Do not merge the PR.
{% if attempt %}Retry attempt {{ attempt }}. Inspect existing work first.{% endif %}
