---
tracker:
  kind: github
  provider:
    repo: YOUR_OWNER/YOUR_REPO
    api_key: $GITHUB_TOKEN
    automation:
      enabled: true
      # Omit base_branch to use the GitHub repository's default branch.
      # base_branch: main
      # REQUIRED: replace with your repository's checks. Nonzero exit prevents publication.
      test_command: npm.cmd test # Windows PowerShell; use npm test on Linux/macOS.
      test_timeout_ms: 600000
      git_timeout_ms: 120000
      draft: true
      review_label: symphony:review
      blocked_label: symphony:blocked
      author_name: Symphony
      author_email: symphony@localhost
  active_states: [open]
  terminal_states: [closed]
  required_labels: [symphony]
polling:
  interval_ms: 30000
workspace:
  root: ../.symphony/github-auto-workspaces
hooks:
  # For an npm repository, uncomment after confirming a package-lock.json is committed:
  # before_run: npm ci
  timeout_ms: 300000
agent:
  max_concurrent_agents: 2
  max_turns: 10
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
Implement GitHub issue {{ issue.identifier }}: {{ issue.title }}.
Issue URL: {{ issue.url }}

{{ issue.description }}

Read repository instructions and the issue discussion before changing code.
Implement the requested behavior, add appropriate regression coverage, and run relevant checks.
Keep changes focused on this issue. Preserve existing work when resuming an attempt.
Use the host-provided GitHub tools to report progress and publish the pull request.
If requirements are unclear or a dependency is unavailable, report the concrete blocker with the GitHub tool.
{% if attempt %}This is attempt {{ attempt }}. Inspect the workspace and existing progress before editing.{% endif %}
