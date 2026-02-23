# Kuato - Copilot Session Recall Instructions

Use these instructions when the user asks to resume prior work, recall decisions, or find when something was discussed.

## Trigger Examples

- "where did we leave off"
- "what did we discuss about X"
- "find the session where we changed Y"
- "what did we do yesterday on this feature"

## Workflow

1. Search sessions first:
   ```bash
   # Auto mode (Claude + Copilot)
   bun run /path/to/kuato/file-based/search.ts --query "TOPIC" --days 14

   # Copilot-only mode
   bun run /path/to/kuato/file-based/search.ts --source copilot --query "TOPIC" --days 14
   ```

2. Read `userMessages` in results before loading full transcripts.

3. Cross-reference:
   - `filesFromToolCalls` for touched code paths
   - `toolsUsed` for execution context
   - timestamps for sequence

4. Summarize:
   - goal
   - decisions
   - completed work
   - next likely step

## Optional PostgreSQL API Path

```bash
curl "http://localhost:3847/sessions?search=TOPIC&days=14&limit=5"
curl "http://localhost:3847/sessions/SESSION_ID?with_transcript=true"
```
