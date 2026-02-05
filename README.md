# pi-parallel-agents

A [pi](https://github.com/badlogic/pi-mono) extension for dynamic parallel agent execution. Run multiple agents with different models in parallel, without requiring pre-defined agent configurations.

## Features

- **Dynamic Model Selection**: Specify model per task inline (e.g., `claude-haiku-4-5`, `gpt-4o-mini`)
- **Four Execution Modes**:
  - **Single**: One task with optional model/tools override
  - **Parallel**: Multiple tasks running concurrently with configurable concurrency
  - **Chain**: Sequential execution with `{previous}` placeholder for context passing
  - **Race**: Multiple models compete on the same task, first to complete wins
- **Streaming Progress**: Real-time updates showing tool calls and output
- **Tool Restrictions**: Optionally restrict tools per task for safety/efficiency
- **Custom System Prompts**: Override system prompts per task

## Installation

```bash
pi install npm:pi-parallel-agents
```

Or for local development:

```bash
pi install /path/to/pi-parallel-agents
```

## Usage

The extension registers a `parallel` tool that the LLM can use. Just describe what you want in natural language:

### Single Task

Run a task with a specific model:

```
Use haiku to scan the codebase for authentication-related files, only allow grep and find tools
```

```
Have gpt-4o-mini review this function for potential bugs
```

### Parallel Tasks

Run multiple tasks at the same time:

```
In parallel:
- Use haiku to find all database queries
- Use haiku to scan for API endpoints  
- Use sonnet to review the security model
```

```
Run these tasks concurrently with haiku:
1. Count lines of code in src/
2. Find TODO comments
3. List all exported functions
```

With shared context:

```
We're migrating from REST to GraphQL. In parallel, have haiku:
- Find all REST endpoint definitions
- Identify data fetching patterns
- Look for API client usage
```

### Chain Mode

Run tasks sequentially, where each step can use the output from the previous:

```
Chain these steps:
1. Use haiku with grep to find all error handling code
2. Have sonnet analyze the patterns found and suggest improvements
3. Have sonnet implement the top 3 suggestions
```

```
First use haiku to scan for performance issues, then have sonnet create a detailed optimization plan based on the findings
```

### Race Mode

Have multiple models compete on the same task - first to finish wins:

```
Race haiku, gpt-4o-mini, and gemini-flash to summarize the README
```

```
Have claude-haiku and gpt-4o-mini race to answer: what's the main purpose of this codebase?
```

## Parameters Reference

### Single Mode

| Parameter | Type | Description |
|-----------|------|-------------|
| `task` | string | Task to execute |
| `model` | string | Model to use (e.g., "claude-haiku-4-5") |
| `tools` | string[] | Restrict to specific tools |
| `systemPrompt` | string | Override system prompt |
| `cwd` | string | Working directory |

### Parallel Mode

| Parameter | Type | Description |
|-----------|------|-------------|
| `tasks` | TaskItem[] | Array of tasks to run |
| `context` | string | Shared context for all tasks |
| `maxConcurrency` | number | Max concurrent tasks (default: 4, max: 8) |

### Chain Mode

| Parameter | Type | Description |
|-----------|------|-------------|
| `chain` | ChainStep[] | Sequential steps with optional `{previous}` placeholder |

### Race Mode

| Parameter | Type | Description |
|-----------|------|-------------|
| `race.task` | string | Task to race |
| `race.models` | string[] | Models to compete |
| `race.tools` | string[] | Tool restrictions |

## Model Names

You can use short names - the LLM will understand:

- `haiku` → claude-haiku-4-5
- `sonnet` → claude-sonnet-4-5
- `opus` → claude-opus-4
- `gpt-4o-mini`, `gpt-4o`
- `gemini-flash`, `gemini-pro`

## Development

```bash
# Clone the repo
git clone https://github.com/messense/pi-parallel-agents
cd pi-parallel-agents

# Install dependencies
npm install

# Test locally
pi -e ./src/index.ts
```

## How It Works

1. Each task spawns a separate `pi` subprocess with `--mode json`
2. Progress is streamed via JSON events from the subprocess
3. Results are stored in the tool result `details` for session persistence
4. On branch/restore, state is automatically correct for that point in history

## License

MIT
