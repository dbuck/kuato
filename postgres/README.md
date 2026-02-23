# PostgreSQL Session Search

Full-featured session search with weighted full-text search, fuzzy matching, and an API server for Claude + Copilot session data.

## Quick Start

```bash
# Start PostgreSQL
bun run db:up

# Install dependencies
bun install

# Set database URL
export DATABASE_URL="postgres://claude:sessions@localhost:5433/claude_sessions"

# Sync your sessions
bun run sync

# Start API server
bun run serve
```

## Sync Options

```bash
# Incremental sync (new/changed files only)
bun run sync

# Copilot-only sync
bun run sync --source copilot

# Full sync (all sessions)
bun run sync --all

# Last 7 days only
bun run sync --days 7

# Force re-sync unchanged files
bun run sync --force

# Limit files processed
bun run sync --limit 100
```

## API Endpoints

### GET /sessions

Search sessions with filters.

```bash
# Full-text search
curl "http://localhost:3847/sessions?search=email+filtering"

# Last 7 days
curl "http://localhost:3847/sessions?days=7"

# Filter by tools
curl "http://localhost:3847/sessions?tools=Edit,Bash"

# Filter by file pattern
curl "http://localhost:3847/sessions?file_pattern=src/components"

# Combine filters
curl "http://localhost:3847/sessions?search=refactor&tools=Edit&days=14&limit=10"
```

**Query Parameters:**

| Param | Description |
|-------|-------------|
| `search` | Full-text search query |
| `days` | Last N days only |
| `since` | After date (YYYY-MM-DD) |
| `until` | Before date |
| `tools` | Tool names (comma-separated) |
| `file_pattern` | File path pattern |
| `source` | Session source (`claude` or `copilot`) |
| `limit` | Max results (default: 20, max: 100) |

### GET /sessions/:id

Get single session by ID.

```bash
# Basic info
curl "http://localhost:3847/sessions/abc123-def456"

# With full transcript
curl "http://localhost:3847/sessions/abc123-def456?with_transcript=true"
```

### GET /sessions/stats

Usage statistics.

```bash
# Last 7 days (default)
curl "http://localhost:3847/sessions/stats"

# Last 30 days
curl "http://localhost:3847/sessions/stats?days=30"
```

Returns:
- Session count
- Total tokens (input, output, cache)
- Breakdown by category
- Breakdown by model

## Database Schema

Key columns in `sessions` table:

| Column | Type | Description |
|--------|------|-------------|
| `id` | VARCHAR(36) | Session UUID |
| `started_at` | TIMESTAMP | Start time |
| `ended_at` | TIMESTAMP | End time |
| `user_messages` | JSONB | All user inputs |
| `tools_used` | JSONB | Tool names |
| `files_touched` | JSONB | File paths |
| `input_tokens` | BIGINT | Total input tokens |
| `output_tokens` | BIGINT | Total output tokens |
| `model_tokens` | JSONB | Per-model breakdown |
| `search_vector` | TSVECTOR | Full-text search |

## Search Weighting

Full-text search is weighted:

1. **Summary** (A weight) - Highest priority
2. **User messages** (B weight) - Medium priority
3. **Tools/files** (C weight) - Lowest priority

This means searching "email" will rank sessions about email higher than sessions that just happened to use an email-related tool.

## Scheduled Sync

Add to crontab for automatic updates:

```bash
*/15 * * * * cd /path/to/postgres && DATABASE_URL="..." bun run sync >> /var/log/session-sync.log 2>&1
```

## Database Management

```bash
# Start database
bun run db:up

# Stop database
bun run db:down

# View logs
bun run db:logs

# Reset database (delete all data)
bun run db:down
docker volume rm postgres_postgres_data
bun run db:up
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgres://localhost/claude_sessions` | Connection string |
| `KUATO_SOURCE` | `auto` | Source mode (`auto`, `claude`, `copilot`) |
| `CLAUDE_SESSIONS_DIR` | `~/.claude/projects` | Claude sessions directory |
| `COPILOT_SESSION_STATE_DIR` | `~/.copilot/session-state` | Copilot sessions directory |
| `PORT` | `3847` | API server port |

## Docker Compose

The included `docker-compose.yml`:
- Uses PostgreSQL 16 Alpine
- Exposes on port 5433 (avoids conflicts with existing Postgres)
- Auto-runs schema on first start
- Persists data in a named volume
