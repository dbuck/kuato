# Kuato - Session Memory Skill

*"Open your mind."*

Use this skill when the user asks about previous sessions, what was discussed, or wants to resume work.

## Trigger Examples

- "where did we leave off"
- "what did we discuss about X"
- "find the session where we"
- "when did we work on"
- "resume from where we were"
- "what were we doing with"

## Workflow

### Step 1. Search sessions first:
   ```bash
   # Auto mode (Claude + Copilot)
   bun run ~/code/kuato/file-based/search.ts --query "TOPIC" --days 14

   # Copilot-only mode
   bun run ~/code/kuato/file-based/search.ts --source copilot --query "TOPIC" --days 14
   ```

### Step 2. Read `userMessages` in results before loading full transcripts.

### Step 3. Cross-reference:
   - `filesFromToolCalls` for touched code paths
   - `toolsUsed` for execution context
   - timestamps for sequence

### Step 4. Summarize:
   - goal
   - decisions
   - completed work
   - next likely step


### Step 5. Present and Offer Options

Present a clear summary, then offer relevant next actions:

**Example response:**

> **Email Filtering System (Jan 15)**
>
> - Built Gmail filter system with rule matching
> - Implemented archive, label, and delete actions
> - Created 3 filter rules for newsletters
> - Tested on 50 emails, 94% accuracy
> - Paused at: "Need to add exception handling"
>
> Would you like to:
> - Continue where we left off
> - See the full session transcript
> - Search for related sessions

## Example Queries

**Find recent work on a feature:**
```bash
bun run ~/code/kuato/file-based/search.ts --query "authentication" --days 7
```

**Find sessions that modified specific files:**
```bash
bun run ~/code/kuato/file-based/search.ts --file_pattern "src/auth"
```

**Find sessions where specific tools were used:**
```bash
bun run ~/code/kuato/file-based/search.ts --tools "Edit,Bash" --days 14
```

**Combine filters:**
```bash
bun run ~/code/kuato/file-based/search.ts --query "refactor" --tools "Edit" --file_pattern "components"
```

## Response Format

Search results include:

| Field | Description |
|-------|-------------|
| `id` | Session UUID |
| `startedAt` | Start timestamp |
| `endedAt` | End timestamp |
| `messageCount` | Total messages in session |
| `userMessages` | Array of user inputs |
| `toolsUsed` | Array of tool names |
| `filesFromToolCalls` | Array of file paths |
| `modelsUsed` | Array of model names |
| `inputTokens` | Total input tokens |
| `outputTokens` | Total output tokens |
| `relevance` | Search relevance score |

## Tips

1. **User messages are gold** - They tell the story without needing transcripts
2. **File patterns work well** - Code work usually touches specific paths
3. **Combine search + filters** - Narrow down large result sets
4. **Recent sessions first** - Use `days` param to limit scope
5. **Cross-reference files** - `files_touched` reveals what was actually modified