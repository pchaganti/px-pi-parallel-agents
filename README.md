# pi-parallel-agents

A [pi](https://github.com/badlogic/pi-mono) extension for running multiple AI agents in parallel with different models.

## Features

- **Multiple Models**: Run tasks with different models (haiku, sonnet, gpt-4o, etc.)
- **Five Modes**: Single task, parallel tasks, sequential chains, model races, or team coordination
- **Team Mode**: DAG-based task coordination with dependencies, roles, and plan approval
- **Agent Reuse**: Reference your existing agent definitions
- **Smart Context**: Auto-includes git branch/status; optionally add files or full diffs
- **Live Progress**: See what each agent is doing in real-time
- **Cost Tracking**: Per-task and total API costs

## Installation

```bash
pi install npm:pi-parallel-agents
```

## Quick Examples

### Parallel Code Review

```
Have haiku and sonnet review the current changes in parallel
```

The extension automatically includes git branch and status. Each agent can run `git diff` themselves if they need more detail.

### Using Different Models

```
In parallel:
- Use haiku to find all TODO comments
- Use sonnet to analyze the architecture
- Use gpt-4o to review security
```

### Sequential Chain

```
First have haiku find all API endpoints, then have sonnet design tests for them
```

### Model Race

```
Race haiku vs gpt-4o-mini to summarize the README - first one wins
```

### Using Your Agents

If you have agents defined in `~/.pi/agent/agents/`:

```
Use the scout agent to analyze the codebase
```

```
Run a chain: scout analyzes, then planner creates a plan
```

### Team Coordination

Coordinate a team of agents with task dependencies — like Claude Code agent teams but with multi-model support:

```
Create a team to refactor the auth module:
- An architect to analyze and plan (require approval before implementation)
- An implementer to do the refactoring after the plan is approved
- A tester to write tests after implementation
- A reviewer to check everything at the end
```

Or in JSON:
```json
{
  "team": {
    "objective": "Refactor the authentication module",
    "members": [
      { "role": "architect", "model": "claude-sonnet-4-5", "tools": ["read", "bash", "grep", "find"] },
      { "role": "implementer", "model": "claude-sonnet-4-5" },
      { "role": "tester", "model": "claude-sonnet-4-5" },
      { "role": "reviewer", "model": "claude-haiku-4-5", "tools": ["read", "grep", "find"] }
    ],
    "tasks": [
      { "id": "analyze", "assignee": "architect", "task": "Map all auth endpoints, data flows, and dependencies" },
      { "id": "plan", "assignee": "architect", "task": "Create a refactoring plan based on the analysis", "depends": ["analyze"], "requiresApproval": true },
      { "id": "implement", "assignee": "implementer", "task": "Implement the refactoring per the approved plan", "depends": ["plan"] },
      { "id": "test", "assignee": "tester", "task": "Write comprehensive tests for the refactored module", "depends": ["implement"] },
      { "id": "review", "assignee": "reviewer", "task": "Review all changes for quality and security", "depends": ["test"] }
    ]
  }
}
```

Independent tasks (no shared dependencies) run in parallel automatically. Use `{task:id}` to reference output from a completed dependency.

## Automatic Context

By default, all parallel tasks receive:
- **Git branch name** - so agents know what branch they're on
- **Git status** - which files are modified/staged

Agents run in the same directory and have full tool access, so they can:
- Run `git diff` to see actual changes
- Read any files they need
- Use grep, find, etc.

**You don't need to pre-fetch data** - just describe what agents should do.

### Adding More Context

Include specific files:
```
Review these files in parallel with haiku and sonnet:
- contextFiles: ["src/main.rs", "src/lib.rs"]
```

Include full git diff:
```
Review the branch changes with gitContext including the full diff
```

Or in JSON:
```json
{
  "tasks": [...],
  "gitContext": { "diff": true, "log": 5 }
}
```

### Disable Auto-Context

```json
{
  "tasks": [...],
  "gitContext": false
}
```

## Modes

### Single Task
One task with a specific model:
```json
{ "task": "Count files in src/", "model": "claude-haiku-4-5" }
```

### Parallel Tasks
Multiple tasks running concurrently:
```json
{
  "tasks": [
    { "task": "Find TODOs", "model": "haiku" },
    { "task": "Review security", "model": "sonnet" }
  ]
}
```

### Chain
Sequential steps where `{previous}` contains the last output:
```json
{
  "chain": [
    { "task": "Find all error handling code", "model": "haiku" },
    { "task": "Analyze these patterns: {previous}", "model": "sonnet" }
  ]
}
```

### Race
First model to complete wins:
```json
{
  "race": {
    "task": "Summarize the README",
    "models": ["haiku", "gpt-4o-mini", "gemini-flash"]
  }
}
```

### Team
Coordinate agents with task dependencies (DAG-based execution):
```json
{
  "team": {
    "objective": "Review PR #42 from multiple angles",
    "members": [
      { "role": "security", "model": "sonnet", "tools": ["read", "grep", "find"] },
      { "role": "perf", "model": "sonnet", "tools": ["read", "grep", "find"] },
      { "role": "tests", "model": "haiku", "tools": ["read", "grep", "find"] },
      { "role": "synthesizer", "model": "sonnet" }
    ],
    "tasks": [
      { "id": "sec-review", "assignee": "security", "task": "Review for security vulnerabilities" },
      { "id": "perf-review", "assignee": "perf", "task": "Review for performance issues" },
      { "id": "test-review", "assignee": "tests", "task": "Check test coverage" },
      { "id": "synthesis", "assignee": "synthesizer", "task": "Synthesize all findings into a summary", "depends": ["sec-review", "perf-review", "test-review"] }
    ]
  }
}
```

**Key features:**
- **Task dependencies**: `depends` array specifies prerequisites; independent tasks run in parallel
- **Named references**: Use `{task:id}` in task text to include a dependency's output
- **Iterative refinement**: Add `review` to a task for automatic worker→reviewer loops with feedback
- **Plan approval**: Set `requiresApproval: true` to pause for review before dependents proceed
- **Roles**: Members have roles; multiple tasks can be assigned to the same role
- **Simple mode**: Omit `tasks` and give each member a `task` field — they all run in parallel

### Iterative Refinement

Add a `review` config to any task to enable automatic review loops. A reviewer evaluates the worker's output and either approves it or sends revision feedback:

```json
{
  "team": {
    "objective": "Write a high-quality haiku about TypeScript",
    "members": [
      { "role": "writer", "model": "gpt-4o" },
      { "role": "critic", "model": "gpt-4.1" }
    ],
    "tasks": [
      {
        "id": "write-haiku",
        "assignee": "writer",
        "task": "Write a haiku (5-7-5 syllables) about TypeScript",
        "review": {
          "assignee": "critic",
          "maxIterations": 3,
          "task": "Check if this haiku has exactly 5-7-5 syllable pattern. Count carefully. {output}"
        }
      }
    ]
  }
}
```

**How it works:**
1. Worker runs the task and produces output
2. Reviewer evaluates using the `review.task` prompt (use `{output}` for worker output, `{task}` for original task)
3. Reviewer ends with `APPROVED` or `REVISION_NEEDED`
4. If revision needed, worker re-runs with the reviewer's feedback
5. Loop continues until approved or `maxIterations` reached (default: 3)

**Review config options:**
- `assignee` (required): Role of the reviewing member
- `task`: Custom review prompt. Defaults to evaluating against the original task
- `maxIterations`: Max review cycles before auto-accepting (default: 3)
- `model`, `provider`, `tools`: Override reviewer's defaults for this review

## Cross-Task References

In parallel mode, reference earlier results with `{task_N}`:

```json
{
  "tasks": [
    { "task": "Analyze the code structure" },
    { "task": "Based on {task_0}, suggest improvements" }
  ]
}
```

When references are detected, tasks run sequentially.

## Output

Results show what each agent did:

```
## Parallel: 2/2 succeeded | Total cost: $0.0089

### ✓ haiku-review (8 turns, claude-haiku-4-5, $0.0034)
**Tools used:** read×3, bash×2, grep×1

The code looks good. Main findings:
- Line 42: potential null pointer...

---

### ✓ sonnet-review (5 turns, claude-sonnet-4-5, $0.0055)
**Tools used:** read×4, bash×1

Architecture review complete...
```

Long outputs are saved to temp files with a path shown.

## Parameters

### Common Options

| Parameter | Description |
|-----------|-------------|
| `model` | Model name (e.g., "haiku", "claude-sonnet-4-5", "gpt-4o") |
| `agent` | Use an existing agent by name |
| `tools` | Restrict available tools (e.g., `["read", "grep"]`) |
| `thinking` | Thinking budget: `"low"`, `"medium"`, `"high"`, or token count |
| `agentScope` | Where to find agents: `"user"`, `"project"`, or `"both"` |

### Context Options (Parallel Mode)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `gitContext` | `{branch: true, status: true}` | Git info to include |
| `contextFiles` | none | Files to read and include |
| `context` | none | Manual context string |

### Git Context Options

| Option | Description |
|--------|-------------|
| `branch` | Current branch name |
| `status` | Git status (modified files) |
| `diffStats` | Summary of changes (files changed, insertions, deletions) |
| `diff` | Full git diff |
| `log` | Last N commit messages (e.g., `log: 5`) |

## Model Shortcuts

Use short names - they're automatically expanded:

| Short | Full |
|-------|------|
| `haiku` | claude-haiku-4-5 |
| `sonnet` | claude-sonnet-4-5 |
| `opus` | claude-opus-4 |
| `gpt-4o-mini` | gpt-4o-mini |
| `gpt-4o` | gpt-4o |

## Development

```bash
git clone https://github.com/messense/pi-parallel-agents
cd pi-parallel-agents
npm install
pi -e ./src/index.ts  # Test locally
```

## License

MIT
