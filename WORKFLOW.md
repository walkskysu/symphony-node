---
tracker:
  kind: file
  provider:
    path: ./examples/issues.json
  active_states: [Todo, In Progress]
  terminal_states: [Done, Canceled]
  required_labels: [symphony]
polling:
  interval_ms: 5000
workspace:
  root: ./.symphony/workspaces
agent:
  max_concurrent_agents: 2
  max_turns: 5
codex:
  # Omit command to select the platform-specific Codex entry point.
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: false
server:
  port: 8080
---
You are working on {{ issue.identifier }}: {{ issue.title }}.

{{ issue.description }}

Work only inside your issue workspace. Inspect the repository before changing it.
Implement the requested work and run appropriate checks. Do not invent missing requirements.
When work is ready, provide a concise handoff summary. The operator manages the issue state.
{% if attempt %}This is retry or continuation attempt {{ attempt }}. Inspect existing progress first.{% endif %}
