---
tracker:
  kind: github
  provider:
    repo: YOUR_OWNER/YOUR_REPO
    api_key: $GITHUB_TOKEN
    # assignee: your-github-username
  active_states: [open]
  terminal_states: [closed]
  required_labels: [symphony]
polling:
  interval_ms: 30000
workspace:
  root: ../.symphony/github-workspaces
hooks:
  after_create: |
    git clone --depth 1 https://github.com/YOUR_OWNER/YOUR_REPO.git .
  timeout_ms: 120000
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
Work on GitHub issue {{ issue.identifier }}: {{ issue.title }}.
Issue URL: {{ issue.url }}

{{ issue.description }}

Follow the repository instructions. Implement the requested change and run appropriate checks.
Do not publish changes, push branches, close the issue, or post comments without explicit instructions.
Provide a concise summary of files changed, checks run, and any remaining questions for human review.
The operator removes the symphony label to pause dispatch for review; closing the issue cleans its workspace.
{% if attempt %}This is attempt {{ attempt }}. Inspect existing workspace progress before making changes.{% endif %}
