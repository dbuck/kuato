/**
 * Parse session JSONL files from supported coding agents
 *
 * Extracts structured data from raw session transcripts including:
 * - Token usage (total and per-model)
 * - User messages
 * - Tools used
 * - Files touched (from tool calls)
 * - Timestamps
 */

import { readFileSync } from 'fs';
import type {
  ClaudeSessionMessage,
  CopilotEvent,
  AssistantMessage,
  ParsedSession,
  ContentBlock,
} from './types.js';

/**
 * Parse a single JSONL file into structured session data
 */
export function parseSessionFile(filePath: string): ParsedSession | null {
  const content = readFileSync(filePath, 'utf-8');
  return parseSessionContent(content, filePath);
}

/**
 * Parse JSONL content string into structured session data
 */
export function parseSessionContent(
  content: string,
  sessionPath?: string
): ParsedSession | null {
  const lines = content.trim().split('\n').filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  const parsedLines: unknown[] = [];

  for (const line of lines) {
    try {
      parsedLines.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  if (parsedLines.length === 0) {
    return null;
  }

  const claudeMessages = parsedLines.filter(isClaudeMessage);
  if (claudeMessages.length > 0) {
    return parseClaudeMessages(claudeMessages, sessionPath);
  }

  const copilotEvents = parsedLines.filter(isCopilotEvent);
  if (copilotEvents.length > 0) {
    return parseCopilotEvents(copilotEvents, sessionPath);
  }

  return null;
}

function parseClaudeMessages(
  messages: ClaudeSessionMessage[],
  sessionPath?: string
): ParsedSession {
  // Extract session metadata from first and last conversation messages
  const firstMessage = messages[0];
  const lastMessage = messages[messages.length - 1];

  // Initialize accumulators
  const userMessages: string[] = [];
  const toolsUsed = new Set<string>();
  const filesFromToolCalls = new Set<string>();
  const modelsUsed = new Set<string>();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  const modelTokens: Record<
    string,
    { input: number; output: number; cacheCreation: number; cacheRead: number }
  > = {};

  for (const msg of messages) {
    if (msg.type === 'user') {
      // Extract user message text
      const userMsg = msg.message as { role: string; content: string };
      if (typeof userMsg.content === 'string' && userMsg.content.trim()) {
        userMessages.push(userMsg.content);
      }
    } else if (msg.type === 'assistant') {
      const assistantMsg = msg.message as AssistantMessage;

      // Track model
      if (assistantMsg.model) {
        modelsUsed.add(assistantMsg.model);

        // Initialize model token tracking
        if (!modelTokens[assistantMsg.model]) {
          modelTokens[assistantMsg.model] = {
            input: 0,
            output: 0,
            cacheCreation: 0,
            cacheRead: 0,
          };
        }
      }

      // Accumulate token usage
      if (assistantMsg.usage) {
        const usage = assistantMsg.usage;
        inputTokens += usage.input_tokens || 0;
        outputTokens += usage.output_tokens || 0;
        cacheCreationTokens += usage.cache_creation_input_tokens || 0;
        cacheReadTokens += usage.cache_read_input_tokens || 0;

        // Per-model tracking
        if (assistantMsg.model && modelTokens[assistantMsg.model]) {
          modelTokens[assistantMsg.model].input += usage.input_tokens || 0;
          modelTokens[assistantMsg.model].output += usage.output_tokens || 0;
          modelTokens[assistantMsg.model].cacheCreation +=
            usage.cache_creation_input_tokens || 0;
          modelTokens[assistantMsg.model].cacheRead +=
            usage.cache_read_input_tokens || 0;
        }
      }

      // Extract tools and files from content blocks
      if (Array.isArray(assistantMsg.content)) {
        for (const block of assistantMsg.content) {
          extractFromContentBlock(block, toolsUsed, filesFromToolCalls);
        }
      }
    }
  }

  return {
    source: 'claude',
    id: deriveSessionId(sessionPath, firstMessage.sessionId),
    startedAt: new Date(firstMessage.timestamp),
    endedAt: new Date(lastMessage.timestamp),
    gitBranch: firstMessage.gitBranch || 'unknown',
    cwd: firstMessage.cwd || '',
    version: firstMessage.version || '',
    messageCount: messages.length,

    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,

    userMessages,
    toolsUsed: Array.from(toolsUsed),
    filesFromToolCalls: Array.from(filesFromToolCalls),
    modelsUsed: Array.from(modelsUsed),
    modelTokens,
  };
}

function parseCopilotEvents(
  events: CopilotEvent[],
  sessionPath?: string
): ParsedSession | null {
  const sessionStart = events.find((event) => event.type === 'session.start');
  const sessionStartData = isObject(sessionStart?.data) ? sessionStart.data : undefined;
  const context = isObject(sessionStartData?.context)
    ? (sessionStartData.context as Record<string, unknown>)
    : undefined;

  const userMessages: string[] = [];
  const toolsUsed = new Set<string>();
  const filesFromToolCalls = new Set<string>();
  const modelsUsed = new Set<string>();
  const timestamps: Date[] = [];

  let messageCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;

  const modelTokens: Record<
    string,
    { input: number; output: number; cacheCreation: number; cacheRead: number }
  > = {};

  for (const event of events) {
    const timestamp = parseDate(event.timestamp);
    if (timestamp) {
      timestamps.push(timestamp);
    }

    if (event.type === 'user.message') {
      messageCount += 1;
      const data = isObject(event.data) ? event.data : undefined;
      const content = getPrimaryUserMessage(data);
      if (content) {
        userMessages.push(content);
      }
      continue;
    }

    if (event.type === 'assistant.message') {
      messageCount += 1;
      const data = isObject(event.data) ? event.data : undefined;

      const model = typeof data?.model === 'string' ? data.model : undefined;
      if (model) {
        ensureModelTracking(modelTokens, modelsUsed, model);
      }

      const usage = isObject(data?.usage) ? data.usage : undefined;
      if (usage) {
        inputTokens += toNumber(usage.input_tokens);
        outputTokens += toNumber(usage.output_tokens);
        cacheCreationTokens += toNumber(usage.cache_creation_input_tokens);
        cacheReadTokens += toNumber(usage.cache_read_input_tokens);

        if (model) {
          modelTokens[model].input += toNumber(usage.input_tokens);
          modelTokens[model].output += toNumber(usage.output_tokens);
          modelTokens[model].cacheCreation += toNumber(usage.cache_creation_input_tokens);
          modelTokens[model].cacheRead += toNumber(usage.cache_read_input_tokens);
        }
      }

      const toolRequests = Array.isArray(data?.toolRequests) ? data.toolRequests : [];
      for (const request of toolRequests) {
        if (!isObject(request)) continue;
        if (typeof request.name === 'string') {
          toolsUsed.add(request.name);
        }
        if (isObject(request.arguments)) {
          extractFilePaths(request.arguments, filesFromToolCalls);
        }
      }

      continue;
    }

    if (event.type === 'session.model_change') {
      const data = isObject(event.data) ? event.data : undefined;
      if (typeof data?.newModel === 'string') {
        ensureModelTracking(modelTokens, modelsUsed, data.newModel);
      }
      continue;
    }

    if (event.type === 'tool.execution_start') {
      const data = isObject(event.data) ? event.data : undefined;
      if (typeof data?.toolName === 'string') {
        toolsUsed.add(data.toolName);
      } else if (typeof data?.mcpToolName === 'string') {
        toolsUsed.add(data.mcpToolName);
      }
      if (isObject(data?.arguments)) {
        extractFilePaths(data.arguments, filesFromToolCalls);
      }
    }
  }

  if (timestamps.length === 0) {
    return null;
  }

  timestamps.sort((a, b) => a.getTime() - b.getTime());
  const startedAt = timestamps[0];
  const endedAt = timestamps[timestamps.length - 1];

  const contextBranch = typeof context?.branch === 'string' ? context.branch : undefined;
  const contextCwd = typeof context?.cwd === 'string' ? context.cwd : undefined;
  const sessionId = typeof sessionStartData?.sessionId === 'string'
    ? sessionStartData.sessionId
    : undefined;

  let version = '';
  if (typeof sessionStartData?.copilotVersion === 'string') {
    version = sessionStartData.copilotVersion;
  } else if (
    typeof sessionStartData?.version === 'string' ||
    typeof sessionStartData?.version === 'number'
  ) {
    version = String(sessionStartData.version);
  }

  return {
    source: 'copilot',
    id: deriveSessionId(sessionPath, sessionId),
    startedAt,
    endedAt,
    gitBranch: contextBranch || 'unknown',
    cwd: contextCwd || '',
    version,
    messageCount,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    userMessages,
    toolsUsed: Array.from(toolsUsed),
    filesFromToolCalls: Array.from(filesFromToolCalls),
    modelsUsed: Array.from(modelsUsed),
    modelTokens,
  };
}

function isClaudeMessage(value: unknown): value is ClaudeSessionMessage {
  if (!isObject(value)) return false;
  if (value.type !== 'user' && value.type !== 'assistant') return false;
  return isObject(value.message);
}

function isCopilotEvent(value: unknown): value is CopilotEvent {
  if (!isObject(value)) return false;
  if (typeof value.type !== 'string' || !value.type.includes('.')) return false;
  if (typeof value.timestamp !== 'string') return false;
  return true;
}

function deriveSessionId(sourcePath: string | undefined, fallback?: string): string {
  if (fallback) return fallback;
  if (!sourcePath) return 'unknown';

  const match = sourcePath.match(
    /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i
  );
  return match?.[1] || 'unknown';
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function ensureModelTracking(
  modelTokens: Record<
    string,
    { input: number; output: number; cacheCreation: number; cacheRead: number }
  >,
  modelsUsed: Set<string>,
  model: string
): void {
  modelsUsed.add(model);
  if (!modelTokens[model]) {
    modelTokens[model] = {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
    };
  }
}

function getPrimaryUserMessage(data?: Record<string, unknown>): string | null {
  if (!data) return null;
  if (typeof data.content === 'string' && data.content.trim()) {
    return data.content;
  }
  if (typeof data.transformedContent === 'string' && data.transformedContent.trim()) {
    return data.transformedContent;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extract tool names and file paths from a content block
 */
function extractFromContentBlock(
  block: ContentBlock,
  toolsUsed: Set<string>,
  filesFromToolCalls: Set<string>
): void {
  if (block.type === 'tool_use' && block.name) {
    toolsUsed.add(block.name);

    // Extract file paths from tool inputs
    if (block.input) {
      extractFilePaths(block.input, filesFromToolCalls);
    }
  }
}

/**
 * Recursively extract file paths from tool input
 */
function extractFilePaths(
  input: unknown,
  files: Set<string>
): void {
  if (Array.isArray(input)) {
    for (const item of input) {
      extractFilePaths(item, files);
    }
    return;
  }
  if (!isObject(input)) {
    return;
  }

  for (const [key, value] of Object.entries(input)) {
    // Common file path parameter names
    if (
      ['file_path', 'path', 'paths', 'file', 'filename', 'filePath', 'uri'].includes(key) &&
      typeof value === 'string'
    ) {
      // Only add if it looks like a path
      if (value.includes('/') || value.includes('\\')) {
        files.add(value);
      }
    }

    if (
      ['paths', 'files'].includes(key) &&
      Array.isArray(value)
    ) {
      for (const entry of value) {
        if (typeof entry === 'string' && (entry.includes('/') || entry.includes('\\'))) {
          files.add(entry);
        }
      }
    }

    // Recurse into nested objects
    if (value && typeof value === 'object') {
      extractFilePaths(value, files);
    }
  }
}

/**
 * Get a simple text summary suitable for search indexing
 */
export function getSearchableText(session: ParsedSession): string {
  const parts: string[] = [];

  // User messages are highest signal
  parts.push(...session.userMessages);

  // Tools and files provide context
  parts.push(...session.toolsUsed);
  parts.push(...session.filesFromToolCalls);

  return parts.join(' ');
}
