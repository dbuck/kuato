# File-Based Session Search

Zero-dependency session search. Works directly with Claude Code and copilot-cli local session files.

## Usage

```bash
# Search by keyword
bun run search.ts --query "email system"

# Search Copilot sessions
bun run search.ts --source copilot --query "email system"

# Limit to recent sessions
bun run search.ts --query "refactor" --days 7

# Filter by tools
bun run search.ts --tools Edit,Bash

# Filter by file patterns
bun run search.ts --file-pattern "components/"

# Combine filters
bun run search.ts --query "api" --tools Edit --days 14 --limit 10
```

## Options

| Flag | Short | Description |
|------|-------|-------------|
| `--query` | `-q` | Search text |
| `--days` | `-d` | Last N days only |
| `--since` | | After date (YYYY-MM-DD) |
| `--until` | | Before date |
| `--tools` | `-t` | Filter by tools (comma-separated) |
| `--file-pattern` | `-f` | Filter by file path |
| `--limit` | `-l` | Max results (default: 20) |
| `--source` | `-s` | Source mode (`auto`, `claude`, `copilot`) |
| `--dir` | | Sessions directory |
| `--help` | `-h` | Show help |

## Output

JSON array of matching sessions:

```json
[
  {
    "source": "claude",
    "id": "abc123-def456",
    "startedAt": "2025-01-15T10:30:00.000Z",
    "endedAt": "2025-01-15T11:45:00.000Z",
    "gitBranch": "main",
    "messageCount": 42,
    "inputTokens": 125000,
    "outputTokens": 15000,
    "toolsUsed": ["Edit", "Bash", "Read"],
    "filesFromToolCalls": ["src/api/email.ts"],
    "userMessages": [
      "Build email filtering",
      "Yes, that approach",
      "Commit this"
    ],
    "modelsUsed": ["claude-sonnet-4-20250514"],
    "relevance": 23,
    "transcriptPath": "/home/user/.claude/projects/-home-user-myproject/abc123-def456.jsonl"
  }
]
```

## How Search Works

1. Scans source directories (default `auto` mode):
   - Claude: `~/.claude/projects/*/*.jsonl`
   - Copilot: `~/.copilot/session-state/*/events.jsonl`
2. Parses each file to extract metadata
3. Filters by date, tools, file patterns
4. Scores relevance against search query:
   - User messages: 10 points per match
   - Tools: 3 points per match
   - Files: 3 points per match
5. Returns sorted by relevance, then date

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KUATO_SOURCE` | `auto` | Source mode (`auto`, `claude`, `copilot`) |
| `CLAUDE_SESSIONS_DIR` | `~/.claude/projects` | Claude sessions directory |
| `COPILOT_SESSION_STATE_DIR` | `~/.copilot/session-state` | Copilot sessions directory |

## Performance

- ~100 sessions: < 1 second
- ~500 sessions: 1-3 seconds
- ~1000+ sessions: Consider PostgreSQL version

The bottleneck is file I/O. Each session file must be read and parsed.

## Integration with Agents

Add this to your skill/instructions file:

```markdown
To search past sessions, run:
bun run /path/to/claude-session-memory/file-based/search.ts --query "TOPIC"

The results include `userMessages` which contain all user inputs from each session.
```
