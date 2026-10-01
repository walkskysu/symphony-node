---
tracker:
  kind: linear
  provider:
    api_key: $LINEAR_API_KEY
    project_slug: replace-with-project-slug-id
  active_states: [Todo, In Progress]
  terminal_states: [Done, Canceled, Duplicate]
  required_labels: [symphony]
workspace:
  root: ../.symphony/linear-workspaces
hooks:
  after_create: |
    git clone --depth 1 https://github.com/YOUR_ORG/YOUR_REPO.git .
  timeout_ms: 120000
agent:
  max_concurrent_agents: 2
  max_turns: 5
server:
  port: 8080
---
Work on {{ issue.identifier }}: {{ issue.title }}.
{{ issue.description }}
Use the existing repository instructions and run relevant checks.
Summarize the result for human review. The operator manages Linear state transitions.
