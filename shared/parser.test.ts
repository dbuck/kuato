import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { parseSessionContent, parseSessionFile } from './parser.js';

const FIXTURES_DIR = join(import.meta.dir, '__fixtures__');

function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

describe('parseSessionFile', () => {
  test('parses Claude session fixtures', () => {
    const session = parseSessionFile(fixturePath('claude-basic.jsonl'));

    expect(session).not.toBeNull();
    expect(session?.source).toBe('claude');
    expect(session?.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(session?.userMessages).toEqual(['Build auth middleware']);
    expect(session?.toolsUsed).toContain('Edit');
    expect(session?.filesFromToolCalls).toContain('src/auth.ts');
    expect(session?.inputTokens).toBe(100);
    expect(session?.outputTokens).toBe(20);
  });

  test('parses Copilot session fixtures', () => {
    const session = parseSessionFile(fixturePath('copilot-basic.jsonl'));

    expect(session).not.toBeNull();
    expect(session?.source).toBe('copilot');
    expect(session?.id).toBe('22222222-2222-2222-2222-222222222222');
    expect(session?.gitBranch).toBe('feature/copilot');
    expect(session?.userMessages).toEqual(['Add retry logic to API client']);
    expect(session?.toolsUsed).toContain('apply_patch');
    expect(session?.toolsUsed).toContain('view');
    expect(session?.filesFromToolCalls).toContain('src/client.ts');
    expect(session?.messageCount).toBe(2);
  });

  test('parses Copilot aborted sessions', () => {
    const session = parseSessionFile(fixturePath('copilot-abort.jsonl'));

    expect(session).not.toBeNull();
    expect(session?.source).toBe('copilot');
    expect(session?.id).toBe('33333333-3333-3333-3333-333333333333');
    expect(session?.userMessages).toEqual(['Investigate flaky tests']);
    expect(session?.messageCount).toBe(1);
  });

  test('returns null for malformed content', () => {
    expect(parseSessionFile(fixturePath('invalid-empty.jsonl'))).toBeNull();
  });
});

describe('parseSessionContent', () => {
  test('derives Copilot session id from file path when session.start is missing', () => {
    const content = JSON.stringify({
      type: 'user.message',
      data: { content: 'Continue work' },
      timestamp: '2026-01-04T10:00:00.000Z',
    });

    const session = parseSessionContent(
      content,
      '/tmp/44444444-4444-4444-4444-444444444444/events.jsonl'
    );

    expect(session).not.toBeNull();
    expect(session?.source).toBe('copilot');
    expect(session?.id).toBe('44444444-4444-4444-4444-444444444444');
    expect(session?.userMessages).toEqual(['Continue work']);
  });

  test('parses fixture file content directly', () => {
    const content = readFileSync(fixturePath('copilot-basic.jsonl'), 'utf-8');
    const session = parseSessionContent(content, fixturePath('copilot-basic.jsonl'));

    expect(session).not.toBeNull();
    expect(session?.source).toBe('copilot');
    expect(session?.toolsUsed.length).toBeGreaterThan(0);
  });
});
