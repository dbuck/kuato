#!/usr/bin/env bun
/**
 * Sync coding-agent sessions to PostgreSQL
 *
 * Usage:
 *   bun run postgres/sync.ts                    # Incremental sync (new/changed)
 *   bun run postgres/sync.ts --all              # Full sync
 *   bun run postgres/sync.ts --days 7           # Last 7 days only
 *   bun run postgres/sync.ts --force            # Re-sync even if unchanged
 *
 * Environment:
 *   DATABASE_URL          - PostgreSQL connection string
 *   CLAUDE_SESSIONS_DIR   - Claude sessions directory (default: ~/.claude/projects)
 *   COPILOT_SESSION_STATE_DIR - Copilot sessions directory (default: ~/.copilot/session-state)
 *   KUATO_SOURCE          - Source mode: auto|claude|copilot (default: auto)
 */

import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { parseArgs } from 'util';
import postgres from 'postgres';
import { parseSessionFile, getSearchableText } from '../shared/parser.js';
import type { SessionSearchSource, SessionSource } from '../shared/types.js';

// Configuration
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/claude_sessions';
const DEFAULT_CLAUDE_SESSIONS_DIR =
  process.env.CLAUDE_SESSIONS_DIR ||
  join(process.env.HOME || '', '.claude', 'projects');
const DEFAULT_COPILOT_SESSION_STATE_DIR =
  process.env.COPILOT_SESSION_STATE_DIR ||
  join(process.env.HOME || '', '.copilot', 'session-state');
const DEFAULT_SOURCE = normalizeSource(process.env.KUATO_SOURCE);

// Connect to database
const sql = postgres(DATABASE_URL);

interface SyncOptions {
  all?: boolean;
  days?: number;
  force?: boolean;
  limit?: number;
  source?: SessionSearchSource;
}

interface SyncStats {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

interface SyncRoot {
  baseDir: string;
  source: SessionSource;
}

interface SyncFile {
  path: string;
  mtime: Date;
}

/**
 * Calculate MD5 hash of file contents
 */
function fileHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('md5').update(content).digest('hex');
}

/**
 * Get existing session hashes from database
 */
async function getExistingHashes(): Promise<Map<string, string>> {
  const rows = await sql`
    SELECT id, transcript_hash FROM sessions WHERE transcript_hash IS NOT NULL
  `;
  return new Map(rows.map((r) => [r.id, r.transcript_hash]));
}

/**
 * Find all session directories
 */
function findSessionDirs(baseDir: string): string[] {
  try {
    return readdirSync(baseDir)
      .map((name) => join(baseDir, name))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Find JSONL files to sync
 */
function findFilesToSync(
  roots: SyncRoot[],
  options: SyncOptions
): SyncFile[] {
  const files: SyncFile[] = [];

  const cutoffDate = options.all
    ? null
    : options.days
    ? new Date(Date.now() - options.days * 24 * 60 * 60 * 1000)
    : null;

  for (const root of roots) {
    const sessionDirs = findSessionDirs(root.baseDir);
    for (const dir of sessionDirs) {
      if (root.source === 'claude') {
        try {
          for (const file of readdirSync(dir)) {
            if (!file.endsWith('.jsonl')) continue;

            const filePath = join(dir, file);
            const stat = statSync(filePath);

            // Skip old files unless doing full sync
            if (cutoffDate && stat.mtime < cutoffDate) continue;

            files.push({ path: filePath, mtime: stat.mtime });
          }
        } catch {
          // Directory not readable
        }
        continue;
      }

      const filePath = join(dir, 'events.jsonl');
      try {
        const stat = statSync(filePath);
        if (cutoffDate && stat.mtime < cutoffDate) continue;
        files.push({ path: filePath, mtime: stat.mtime });
      } catch {
        // Missing events.jsonl
      }
    }
  }

  const deduped = new Map<string, SyncFile>();
  for (const file of files) {
    if (!deduped.has(file.path)) {
      deduped.set(file.path, file);
    }
  }

  // Sort by modification time (newest first)
  const sorted = Array.from(deduped.values()).sort(
    (a, b) => b.mtime.getTime() - a.mtime.getTime()
  );

  // Apply limit
  if (options.limit) {
    return sorted.slice(0, options.limit);
  }

  return sorted;
}

/**
 * Sync a single session to the database
 */
async function syncSession(
  filePath: string,
  existingHashes: Map<string, string>,
  options: SyncOptions
): Promise<'created' | 'updated' | 'skipped' | 'error'> {
  try {
    // Parse session
    const session = parseSessionFile(filePath);
    if (!session) {
      return 'skipped';
    }

    // Skip empty sessions
    if (session.userMessages.length === 0) {
      return 'skipped';
    }

    // Check if already synced with same hash
    const hash = fileHash(filePath);
    const existingHash = existingHashes.get(session.id);

    if (existingHash === hash && !options.force) {
      return 'skipped';
    }

    // Build search text from normalized session content
    const searchText = getSearchableText(session);

    // Upsert session
    await sql`
      INSERT INTO sessions (
        id,
        started_at,
        ended_at,
        git_branch,
        cwd,
        version,
        source,
        message_count,
        input_tokens,
        output_tokens,
        cache_creation_tokens,
        cache_read_tokens,
        user_messages,
        tools_used,
        files_touched,
        models_used,
        model_tokens,
        search_text,
        transcript_path,
        transcript_hash,
        synced_at
      ) VALUES (
        ${session.id},
        ${session.startedAt},
        ${session.endedAt},
        ${session.gitBranch},
        ${session.cwd},
        ${session.version},
        ${session.source || 'claude'},
        ${session.messageCount},
        ${session.inputTokens},
        ${session.outputTokens},
        ${session.cacheCreationTokens},
        ${session.cacheReadTokens},
        ${sql.json(session.userMessages)},
        ${sql.json(session.toolsUsed)},
        ${sql.json(session.filesFromToolCalls)},
        ${sql.json(session.modelsUsed)},
        ${sql.json(session.modelTokens)},
        ${searchText},
        ${filePath},
        ${hash},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        git_branch = EXCLUDED.git_branch,
        cwd = EXCLUDED.cwd,
        version = EXCLUDED.version,
        source = EXCLUDED.source,
        message_count = EXCLUDED.message_count,
        input_tokens = EXCLUDED.input_tokens,
        output_tokens = EXCLUDED.output_tokens,
        cache_creation_tokens = EXCLUDED.cache_creation_tokens,
        cache_read_tokens = EXCLUDED.cache_read_tokens,
        user_messages = EXCLUDED.user_messages,
        tools_used = EXCLUDED.tools_used,
        files_touched = EXCLUDED.files_touched,
        models_used = EXCLUDED.models_used,
        model_tokens = EXCLUDED.model_tokens,
        search_text = EXCLUDED.search_text,
        transcript_path = EXCLUDED.transcript_path,
        transcript_hash = EXCLUDED.transcript_hash,
        synced_at = NOW()
    `;

    return existingHash ? 'updated' : 'created';
  } catch (error) {
    console.error(`Error syncing ${filePath}:`, error);
    return 'error';
  }
}

/**
 * Main sync function
 */
async function sync(roots: SyncRoot[], options: SyncOptions): Promise<SyncStats> {
  const stats: SyncStats = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  console.log(
    `Syncing source=${options.source || DEFAULT_SOURCE} from ${roots
      .map((root) => `${root.source}:${root.baseDir}`)
      .join(', ')}`
  );

  // Get existing hashes for change detection
  const existingHashes = await getExistingHashes();
  console.log(`Found ${existingHashes.size} existing sessions in database`);

  // Find files to sync
  const files = findFilesToSync(roots, options);
  console.log(`Found ${files.length} session files to process`);

  // Process each file
  for (const { path: filePath } of files) {
    const result = await syncSession(filePath, existingHashes, options);
    stats[result]++;

    if (result !== 'skipped') {
      console.log(`  ${result}: ${filePath}`);
    }
  }

  return stats;
}

// CLI entry point
async function main() {
  const { values } = parseArgs({
    options: {
      all: { type: 'boolean', short: 'a' },
      days: { type: 'string', short: 'd' },
      force: { type: 'boolean', short: 'f' },
      limit: { type: 'string', short: 'l' },
      dir: { type: 'string' },
      source: { type: 'string', short: 's' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    console.log(`
Session Sync (PostgreSQL)

Usage:
  bun run sync.ts [options]

Options:
  -a, --all              Sync all sessions (not just recent)
  -d, --days <n>         Only sync last N days
  -f, --force            Re-sync even if file unchanged
  -l, --limit <n>        Max files to process
  -s, --source <type>    Source: auto|claude|copilot (default: ${DEFAULT_SOURCE})
  --dir <path>           Override source root directory
  -h, --help             Show this help

Environment:
  DATABASE_URL           PostgreSQL connection string
  CLAUDE_SESSIONS_DIR    Default Claude sessions directory
  COPILOT_SESSION_STATE_DIR Default Copilot sessions directory
  KUATO_SOURCE           Default source mode

Examples:
  bun run sync.ts                    # Incremental sync
  bun run sync.ts --source copilot
  bun run sync.ts --all              # Full sync
  bun run sync.ts --days 7           # Last week only
  bun run sync.ts --force            # Force re-sync
`);
    process.exit(0);
  }

  const options: SyncOptions = {
    all: values.all,
    days: values.days ? parseInt(values.days, 10) : undefined,
    force: values.force,
    limit: values.limit ? parseInt(values.limit, 10) : undefined,
    source: normalizeSource(values.source) || DEFAULT_SOURCE,
  };

  const roots = resolveSyncRoots(values.dir, options.source || DEFAULT_SOURCE);

  try {
    const stats = await sync(roots, options);

    console.log('\nSync complete:');
    console.log(`  Created: ${stats.created}`);
    console.log(`  Updated: ${stats.updated}`);
    console.log(`  Skipped: ${stats.skipped}`);
    console.log(`  Errors:  ${stats.errors}`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('Sync failed:', error);
  process.exit(1);
});

function normalizeSource(value?: string): SessionSearchSource {
  if (value === 'claude' || value === 'copilot' || value === 'auto') {
    return value;
  }
  return 'auto';
}

function resolveSyncRoots(
  overrideDir: string | undefined,
  source: SessionSearchSource
): SyncRoot[] {
  if (source === 'claude') {
    return [{ source: 'claude', baseDir: overrideDir || DEFAULT_CLAUDE_SESSIONS_DIR }];
  }
  if (source === 'copilot') {
    return [{ source: 'copilot', baseDir: overrideDir || DEFAULT_COPILOT_SESSION_STATE_DIR }];
  }
  if (overrideDir) {
    return [
      { source: 'claude', baseDir: overrideDir },
      { source: 'copilot', baseDir: overrideDir },
    ];
  }
  return [
    { source: 'claude', baseDir: DEFAULT_CLAUDE_SESSIONS_DIR },
    { source: 'copilot', baseDir: DEFAULT_COPILOT_SESSION_STATE_DIR },
  ];
}
