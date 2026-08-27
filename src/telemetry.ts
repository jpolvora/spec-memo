import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  TelemetryCategory,
  TelemetryConfig,
  TelemetryEvent,
  TelemetryEventInput,
  VaultConfig
} from './types.js';
import { getVaultRoot } from './vault.js';
import { sanitizeToolOutput } from './safety.js';

export interface TelemetryOptions {
  vaultRoot?: string;
  maxFileSizeMb?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  enabled?: boolean;
}

export const DEFAULT_TELEMETRY_CONFIG: Required<TelemetryConfig> = {
  maxFileSizeMb: 10,
  flushIntervalMs: 500,
  maxQueueSize: 50
};

const enabledCache = new Map<string, boolean>();

/**
 * Checks whether telemetry is enabled for the vault.
 * Precedence: SPEC_MEMO_ENABLE_TELEMETRY env var > config.json enableTelemetry > true (default).
 * Caches config.json read per vaultRoot to eliminate repeated synchronous disk I/O on the hot path.
 */
export function isTelemetryEnabled(vaultRoot?: string): boolean {
  if (process.env.SPEC_MEMO_ENABLE_TELEMETRY !== undefined) {
    const envVal = process.env.SPEC_MEMO_ENABLE_TELEMETRY.trim().toLowerCase();
    if (envVal === '0' || envVal === 'false' || envVal === 'off' || envVal === 'no') {
      return false;
    }
    if (envVal === '1' || envVal === 'true' || envVal === 'on' || envVal === 'yes') {
      return true;
    }
  }

  const root = getVaultRoot(vaultRoot);
  const cached = enabledCache.get(root);
  if (cached !== undefined) {
    return cached;
  }

  const configPath = path.join(root, 'config.json');
  let enabled = true;
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<VaultConfig>;
      if (parsed.enableTelemetry !== undefined) {
        enabled = Boolean(parsed.enableTelemetry);
      }
    } catch {
      // ignore parse errors and fallback to true
    }
  }
  enabledCache.set(root, enabled);
  return enabled;
}

function loadTelemetryConfig(vaultRoot: string): Partial<TelemetryConfig> {
  const configPath = path.join(vaultRoot, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<VaultConfig>;
      return parsed.telemetry ?? {};
    } catch {
      // ignore
    }
  }
  return {};
}

/**
 * Returns the resolved directory path for telemetry log files ($SPEC_MEMO_ROOT/telemetry).
 */
export function getTelemetryDir(vaultRoot?: string): string {
  const root = getVaultRoot(vaultRoot);
  return path.join(root, 'telemetry');
}

/**
 * Sanitizes metadata payloads to strip sensitive secrets, absolute host paths, and internal vault paths.
 */
function sanitizeMetadata(payload?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  return sanitizeToolOutput(payload) as Record<string, unknown>;
}

/**
 * TelemetryRecorder buffers, rotates, and safely flushes structured telemetry logs.
 */
export class TelemetryRecorder {
  private vaultRoot: string;
  private maxFileSizeBytes: number;
  private flushIntervalMs: number;
  private maxQueueSize: number;
  private queue: TelemetryEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private currentDate: string | null = null;
  private currentPart = 1;
  private currentFileBytes = 0;
  private closed = false;
  private lastError: Error | null = null;

  constructor(options: TelemetryOptions = {}) {
    this.vaultRoot = getVaultRoot(options.vaultRoot);
    const maxMb = options.maxFileSizeMb ?? DEFAULT_TELEMETRY_CONFIG.maxFileSizeMb;
    this.maxFileSizeBytes = Math.max(1, maxMb) * 1024 * 1024;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_TELEMETRY_CONFIG.flushIntervalMs;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_TELEMETRY_CONFIG.maxQueueSize;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public getLastError(): Error | null {
    return this.lastError;
  }

  /**
   * Enqueues a telemetry event. Discards immediately if telemetry is disabled.
   */
  public record(input: TelemetryEventInput): void {
    if (this.closed) return;
    if (!isTelemetryEnabled(input.vaultRoot || this.vaultRoot)) {
      return;
    }

    try {
      const event: TelemetryEvent = {
        timestamp: input.timestamp || new Date().toISOString(),
        eventId: input.eventId || `tel-${crypto.randomUUID()}`,
        category: input.category,
        operation: input.operation,
        durationMs: Math.max(0, Math.round(input.durationMs * 10) / 10),
        success: Boolean(input.success),
        errorCode: input.errorCode,
        projectId: input.projectId,
        metadata: sanitizeMetadata(input.metadata)
      };

      this.queue.push(event);

      if (this.queue.length >= this.maxQueueSize) {
        void this.flush();
      } else if (!this.flushTimer && !this.isFlushing) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flush();
        }, this.flushIntervalMs);
        if (typeof this.flushTimer.unref === 'function') {
          this.flushTimer.unref();
        }
      }
    } catch (err: unknown) {
      this.lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Resolves the rolling part file path for the given date, advancing part numbers when size limit is exceeded.
   */
  public resolveCurrentPartFile(dateStr: string, incomingBytes: number): { filePath: string; part: number } {
    const telemetryDir = getTelemetryDir(this.vaultRoot);
    if (!fs.existsSync(telemetryDir)) {
      fs.mkdirSync(telemetryDir, { recursive: true });
    }

    if (this.currentDate !== dateStr) {
      this.currentDate = dateStr;
      // Scan existing files for this date to locate the highest part number
      const prefix = `telemetry-${dateStr}.part-`;
      const suffix = `.jsonl`;
      let highestPart = 1;
      let existingBytes = 0;

      try {
        const files = fs.readdirSync(telemetryDir);
        for (const file of files) {
          if (file.startsWith(prefix) && file.endsWith(suffix)) {
            const partStr = file.slice(prefix.length, file.length - suffix.length);
            const partNum = parseInt(partStr, 10);
            if (!isNaN(partNum) && partNum >= highestPart) {
              highestPart = partNum;
            }
          }
        }

        const candidateFile = path.join(telemetryDir, `telemetry-${dateStr}.part-${highestPart}.jsonl`);
        if (fs.existsSync(candidateFile)) {
          existingBytes = fs.statSync(candidateFile).size;
          if (existingBytes + incomingBytes > this.maxFileSizeBytes) {
            highestPart += 1;
            existingBytes = 0;
          }
        }
      } catch {
        // fallback to part 1
      }

      this.currentPart = highestPart;
      this.currentFileBytes = existingBytes;
    } else {
      if (this.currentFileBytes + incomingBytes > this.maxFileSizeBytes) {
        this.currentPart += 1;
        this.currentFileBytes = 0;
      }
    }

    const fileName = `telemetry-${dateStr}.part-${this.currentPart}.jsonl`;
    const filePath = path.join(telemetryDir, fileName);
    return { filePath, part: this.currentPart };
  }

  /**
   * Asynchronously flushes all buffered telemetry events to disk.
   */
  public async flush(): Promise<void> {
    if (this.queue.length === 0 || this.isFlushing) {
      return;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.isFlushing = true;
    const batch = this.queue.splice(0, this.queue.length);

    try {
      this.writeBatch(batch);
    } catch (err: unknown) {
      this.lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      this.isFlushing = false;
      if (this.queue.length > 0 && !this.closed) {
        void this.flush();
      }
    }
  }

  /**
   * Synchronously flushes all remaining buffered events. Safe for exit handlers.
   */
  public flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.queue.length === 0) {
      return;
    }

    const batch = this.queue.splice(0, this.queue.length);
    try {
      this.writeBatch(batch);
    } catch (err: unknown) {
      this.lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  private writeBatch(batch: TelemetryEvent[]): void {
    if (batch.length === 0) return;

    // Group events by UTC date (YYYY-MM-DD)
    const byDate = new Map<string, TelemetryEvent[]>();
    for (const ev of batch) {
      const d = (ev.timestamp && ev.timestamp.length >= 10) ? ev.timestamp.slice(0, 10) : new Date().toISOString().slice(0, 10);
      const list = byDate.get(d) || [];
      list.push(ev);
      byDate.set(d, list);
    }

    for (const [dateStr, events] of byDate.entries()) {
      const payloadLines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      const buf = Buffer.from(payloadLines, 'utf8');
      const { filePath } = this.resolveCurrentPartFile(dateStr, buf.length);
      fs.appendFileSync(filePath, buf);
      this.currentFileBytes += buf.length;
    }
  }

  /**
   * Closes the recorder, clearing any active timer and draining pending records.
   */
  public async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.flushSync();
  }
}

const recorders = new Map<string, TelemetryRecorder>();

function recorderKey(vaultRoot?: string): string {
  return getVaultRoot(vaultRoot);
}

export function getTelemetryRecorder(vaultRoot?: string, options?: Partial<TelemetryOptions>): TelemetryRecorder {
  const root = recorderKey(vaultRoot);
  let recorder = recorders.get(root);
  if (!recorder) {
    const fileCfg = loadTelemetryConfig(root);
    recorder = new TelemetryRecorder({
      vaultRoot: root,
      maxFileSizeMb: options?.maxFileSizeMb ?? fileCfg.maxFileSizeMb,
      flushIntervalMs: options?.flushIntervalMs ?? fileCfg.flushIntervalMs,
      maxQueueSize: options?.maxQueueSize ?? fileCfg.maxQueueSize,
      ...options
    });
    recorders.set(root, recorder);
  }
  return recorder;
}

export function recordTelemetry(input: TelemetryEventInput): void {
  try {
    const recorder = getTelemetryRecorder(input.vaultRoot);
    recorder.record(input);
  } catch {
    // Zero-crash guarantee: telemetry never fails caller
  }
}

export async function flushTelemetry(vaultRoot?: string): Promise<void> {
  if (vaultRoot !== undefined) {
    const recorder = recorders.get(recorderKey(vaultRoot));
    if (recorder) {
      await recorder.flush();
    }
    return;
  }
  await Promise.all([...recorders.values()].map((r) => r.flush()));
}

export function flushTelemetrySync(vaultRoot?: string): void {
  if (vaultRoot !== undefined) {
    const recorder = recorders.get(recorderKey(vaultRoot));
    if (recorder) {
      recorder.flushSync();
    }
    return;
  }
  for (const recorder of recorders.values()) {
    recorder.flushSync();
  }
}

export async function closeTelemetry(vaultRoot?: string): Promise<void> {
  if (vaultRoot !== undefined) {
    const key = recorderKey(vaultRoot);
    const recorder = recorders.get(key);
    if (recorder) {
      await recorder.close();
      recorders.delete(key);
    }
    enabledCache.delete(key);
    return;
  }
  await Promise.all([...recorders.values()].map((r) => r.close()));
  recorders.clear();
  enabledCache.clear();
}

export function resetTelemetryRecorderForTest(vaultRoot?: string): void {
  if (vaultRoot !== undefined) {
    const key = recorderKey(vaultRoot);
    const recorder = recorders.get(key);
    if (recorder) {
      recorder.flushSync();
      recorders.delete(key);
    }
    enabledCache.delete(key);
    return;
  }
  for (const recorder of recorders.values()) {
    recorder.flushSync();
  }
  recorders.clear();
  enabledCache.clear();
}

/**
 * Lists all rolling telemetry files in the vault.
 */
export function listTelemetryFiles(vaultRoot?: string): string[] {
  const dir = getTelemetryDir(vaultRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('telemetry-') && f.endsWith('.jsonl'))
    .sort();
}

/**
 * Reads and parses telemetry events from vault telemetry files.
 */
export function readTelemetryEvents(
  vaultRoot?: string,
  options?: { date?: string; part?: number }
): TelemetryEvent[] {
  const dir = getTelemetryDir(vaultRoot);
  if (!fs.existsSync(dir)) return [];

  const files = listTelemetryFiles(vaultRoot);
  const events: TelemetryEvent[] = [];

  for (const file of files) {
    if (options?.date && !file.includes(`telemetry-${options.date}.`)) {
      continue;
    }
    if (options?.part !== undefined && !file.includes(`.part-${options.part}.jsonl`)) {
      continue;
    }

    const fullPath = path.join(dir, file);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // ignore corrupted lines
        }
      }
    } catch {
      // ignore file read errors
    }
  }

  return events;
}

// Global exit handler to drain pending telemetry
process.on('beforeExit', () => {
  try {
    flushTelemetrySync();
  } catch {
    // ignore
  }
});
