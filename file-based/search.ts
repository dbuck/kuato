#!/usr/bin/env bun
/**
 * File-based session search - no database required
 *
 * Usage:
 *   bun run file-based/search.ts --query "email system" --days 7
 *   bun run file-based/search.ts --tools Edit,Bash --limit 10
 *   bun run file-based/search.ts --file-pattern "components/"
 *
 * Output: JSON array of matching sessions
 */

import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import { parseSessionFile } from '../shared/parser.js';
import type {
  ParsedSession,
  SearchResult,
  SearchOptions,
  SessionSearchSource,
  SessionSource,
} from '../shared/types.js';

const DEFAULT_CLAUDE_SESSIONS_DIR =
  process.env.CLAUDE_SESSIONS_DIR ||
  join(process.env.HOME || '', '.claude', 'projects');
const DEFAULT_COPILOT_SESSION_STATE_DIR =
  process.env.COPILOT_SESSION_STATE_DIR ||
  join(process.env.HOME || '', '.copilot', 'session-state');
const DEFAULT_SOURCE = normalizeSource(process.env.KUATO_SOURCE);

interface SearchRoot {
  baseDir: string;
  source: SessionSource;
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
 * Find all JSONL files in a directory
 */
function findSessionFiles(
  baseDir: string,
  options: SearchOptions,
  source: SessionSource
): string[] {
  const files: string[] = [];
  const sessionDirs = findSessionDirs(baseDir);
  const since = getSinceDate(options);

  for (const dir of sessionDirs) {
    if (source === 'claude') {
      try {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = join(dir, file);
          if (isInDateRange(filePath, since, options.until)) {
            files.push(filePath);
          }
        }
      } catch {
        // Directory not readable
      }
      continue;
    }

    const filePath = join(dir, 'events.jsonl');
    if (isInDateRange(filePath, since, options.until)) {
      files.push(filePath);
    }
  }

  return files;
}

/**
 * Score relevance of a session against search query
 */
function scoreRelevance(session: ParsedSession, query: string): number {
  if (!query) return 1;

  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(Boolean);
  let score = 0;
  const matchedOn: string[] = [];

  // User messages have highest weight
  for (const msg of session.userMessages) {
    const msgLower = msg.toLowerCase();
    for (const term of queryTerms) {
      if (msgLower.includes(term)) {
        score += 10;
        if (!matchedOn.includes('userMessages')) {
          matchedOn.push('userMessages');
        }
      }
    }
  }

  // Tools used have medium weight
  for (const tool of session.toolsUsed) {
    const toolLower = tool.toLowerCase();
    for (const term of queryTerms) {
      if (toolLower.includes(term)) {
        score += 3;
        if (!matchedOn.includes('toolsUsed')) {
          matchedOn.push('toolsUsed');
        }
      }
    }
  }

  // Files touched have medium weight
  for (const file of session.filesFromToolCalls) {
    const fileLower = file.toLowerCase();
    for (const term of queryTerms) {
      if (fileLower.includes(term)) {
        score += 3;
        if (!matchedOn.includes('filesFromToolCalls')) {
          matchedOn.push('filesFromToolCalls');
        }
      }
    }
  }

  return score;
}

/**
 * Check if session matches filter criteria
 */
function matchesFilters(session: ParsedSession, options: SearchOptions): boolean {
  // Filter by tools
  if (options.tools && options.tools.length > 0) {
    const hasMatchingTool = options.tools.some((tool) =>
      session.toolsUsed.some((t) => t.toLowerCase().includes(tool.toLowerCase()))
    );
    if (!hasMatchingTool) return false;
  }

  // Filter by file pattern
  if (options.filePattern) {
    const pattern = options.filePattern.toLowerCase();
    const hasMatchingFile = session.filesFromToolCalls.some((f) =>
      f.toLowerCase().includes(pattern)
    );
    if (!hasMatchingFile) return false;
  }

  return true;
}

/**
 * Search sessions across all project directories
 */
function searchSessions(
  roots: SearchRoot[],
  options: SearchOptions
): SearchResult[] {
  const results: SearchResult[] = [];
  const seenPaths = new Set<string>();

  for (const root of roots) {
    const files = findSessionFiles(root.baseDir, options, root.source);

    for (const filePath of files) {
      if (seenPaths.has(filePath)) continue;
      seenPaths.add(filePath);

      try {
        const session = parseSessionFile(filePath);
        if (!session) continue;

        if (options.source && options.source !== 'auto' && session.source && session.source !== options.source) {
          continue;
        }

        // Skip empty sessions
        if (session.userMessages.length === 0) continue;

        // Apply filters
        if (!matchesFilters(session, options)) continue;

        // Score relevance if query provided
        const relevance = options.query
          ? scoreRelevance(session, options.query)
          : 1;

        // Skip zero-relevance matches when searching
        if (options.query && relevance === 0) continue;

        results.push({
          ...session,
          relevance,
          transcriptPath: filePath,
        });
      } catch {
        // Skip unparseable files
      }
    }
  }

  // Sort by relevance (desc), then by date (desc)
  results.sort((a, b) => {
    if (a.relevance !== b.relevance) {
      return (b.relevance || 0) - (a.relevance || 0);
    }
    return b.endedAt.getTime() - a.endedAt.getTime();
  });

  // Apply limit
  const limit = options.limit || 20;
  return results.slice(0, limit);
}

/**
 * Format results for output
 */
function formatResults(results: SearchResult[]): object[] {
  return results.map((r) => ({
    source: r.source,
    id: r.id,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt.toISOString(),
    gitBranch: r.gitBranch,
    messageCount: r.messageCount,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    toolsUsed: r.toolsUsed,
    filesFromToolCalls: r.filesFromToolCalls,
    userMessages: r.userMessages,
    modelsUsed: r.modelsUsed,
    relevance: r.relevance,
    transcriptPath: r.transcriptPath,
  }));
}

// CLI entry point
async function main() {
  const { values } = parseArgs({
    options: {
      query: { type: 'string', short: 'q' },
      days: { type: 'string', short: 'd' },
      since: { type: 'string' },
      until: { type: 'string' },
      tools: { type: 'string', short: 't' },
      'file-pattern': { type: 'string', short: 'f' },
      limit: { type: 'string', short: 'l' },
      dir: { type: 'string' },
      source: { type: 'string', short: 's' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
Session Search (File-based)

Usage:
  bun run search.ts [options]

Options:
  -q, --query <text>        Search sessions by text
  -d, --days <n>            Limit to last N days
  --since <date>            Sessions after this date (YYYY-MM-DD)
  --until <date>            Sessions before this date (YYYY-MM-DD)
  -t, --tools <list>        Filter by tools (comma-separated)
  -f, --file-pattern <pat>  Filter by file path pattern
  -l, --limit <n>           Max results (default: 20)
  -s, --source <type>       Source: auto|claude|copilot (default: ${DEFAULT_SOURCE})
  --dir <path>              Override source root directory
  -h, --help                Show this help

Examples:
  bun run search.ts --query "email filtering" --days 7
  bun run search.ts --source copilot
  bun run search.ts --tools Edit,Bash --limit 10
  bun run search.ts --file-pattern "components/"
`);
    process.exit(0);
  }

  const options: SearchOptions = {
    query: values.query,
    days: values.days ? parseInt(values.days, 10) : undefined,
    since: values.since ? new Date(values.since) : undefined,
    until: values.until ? new Date(values.until) : undefined,
    tools: values.tools ? values.tools.split(',') : undefined,
    filePattern: values['file-pattern'],
    limit: values.limit ? parseInt(values.limit, 10) : 20,
    source: normalizeSource(values.source) || DEFAULT_SOURCE,
  };

  const roots = resolveSearchRoots(values.dir, options.source || DEFAULT_SOURCE);
  const results = searchSessions(roots, options);
  const formatted = formatResults(results);

  console.log(JSON.stringify(formatted, null, 2));
}

main().catch(console.error);

function normalizeSource(value?: string): SessionSearchSource {
  if (value === 'claude' || value === 'copilot' || value === 'auto') {
    return value;
  }
  return 'auto';
}

function resolveSearchRoots(
  overrideDir: string | undefined,
  source: SessionSearchSource
): SearchRoot[] {
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

function getSinceDate(options: SearchOptions): Date | undefined {
  if (options.since) return options.since;
  if (options.days) {
    return new Date(Date.now() - options.days * 24 * 60 * 60 * 1000);
  }
  return undefined;
}

function isInDateRange(filePath: string, since?: Date, until?: Date): boolean {
  try {
    const stat = statSync(filePath);
    if (since && stat.mtime < since) return false;
    if (until && stat.mtime > until) return false;
    return true;
  } catch {
    return false;
  }
}
