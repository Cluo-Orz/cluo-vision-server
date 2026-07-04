import type { AppConfig } from "../config.js";
import type { DownloadTask } from "../types.js";
import type { DownloadImportResult } from "./libraryService.js";

interface DownloadSource {
  listDownloads(): Promise<DownloadTask[]>;
}

interface DownloadImporter {
  importCompletedDownload(download: DownloadTask): Promise<DownloadImportResult>;
}

export interface DownloadAutomationRunResult {
  checkedAt: string;
  totalCompleted: number;
  attempted: number;
  imported: number;
  pending: number;
  failed: number;
  synced: number;
  skipped: number;
  results: DownloadImportResult[];
  errors: Array<{ downloadId: string; error: string }>;
}

export class DownloadAutomationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly successfulDownloadIds = new Set<string>();
  private readonly lastAttemptByDownloadId = new Map<string, number>();

  constructor(
    private readonly downloads: DownloadSource,
    private readonly importer: DownloadImporter,
    private readonly config: AppConfig["downloadImportAutomation"]
  ) {}

  start(): void {
    if (!this.config.enabled || this.timer || this.config.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch(() => {
        // Background automation must not crash the BFF. Diagnostics are exposed
        // through explicit import endpoints and service health checks.
      });
    }, this.config.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()): Promise<DownloadAutomationRunResult> {
    if (this.running) {
      return emptyRunResult(now, "automation-run-in-progress");
    }

    this.running = true;
    try {
      const downloads = await this.downloads.listDownloads();
      const completed = downloads.filter((download) => download.state === "completed");
      this.prune(completed);

      const nowMs = now.getTime();
      const due = completed.filter((download) => this.isDue(download, nowMs));
      for (const download of due) {
        this.lastAttemptByDownloadId.set(download.id, nowMs);
      }

      const results: DownloadImportResult[] = [];
      const errors: Array<{ downloadId: string; error: string }> = [];
      for (const download of due) {
        try {
          const result = await this.importer.importCompletedDownload(download);
          results.push(result);
          if (result.status === "imported" || result.status === "local-only") {
            this.successfulDownloadIds.add(download.id);
          }
        } catch (error) {
          errors.push({
            downloadId: download.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return summarizeRun(now, completed.length, due.length, results, errors);
    } finally {
      this.running = false;
    }
  }

  private isDue(download: DownloadTask, nowMs: number): boolean {
    if (this.successfulDownloadIds.has(download.id)) return false;
    const lastAttempt = this.lastAttemptByDownloadId.get(download.id);
    return lastAttempt === undefined || nowMs - lastAttempt >= this.config.retryMs;
  }

  private prune(completed: DownloadTask[]): void {
    const ids = new Set(completed.map((download) => download.id));
    for (const id of this.successfulDownloadIds) {
      if (!ids.has(id)) this.successfulDownloadIds.delete(id);
    }
    for (const id of this.lastAttemptByDownloadId.keys()) {
      if (!ids.has(id)) this.lastAttemptByDownloadId.delete(id);
    }
  }
}

function summarizeRun(
  now: Date,
  totalCompleted: number,
  attempted: number,
  results: DownloadImportResult[],
  errors: Array<{ downloadId: string; error: string }>
): DownloadAutomationRunResult {
  return {
    checkedAt: now.toISOString(),
    totalCompleted,
    attempted,
    imported: results.filter((item) => item.status === "imported" || item.status === "local-only")
      .length,
    pending: results.filter((item) => item.status === "pending-scan").length,
    failed: results.filter((item) => item.status === "not-configured").length + errors.length,
    synced: results.reduce((sum, item) => sum + item.synced, 0),
    skipped: Math.max(0, totalCompleted - attempted),
    results,
    errors
  };
}

function emptyRunResult(now: Date, error: string): DownloadAutomationRunResult {
  return {
    checkedAt: now.toISOString(),
    totalCompleted: 0,
    attempted: 0,
    imported: 0,
    pending: 0,
    failed: 1,
    synced: 0,
    skipped: 0,
    results: [],
    errors: [{ downloadId: "automation", error }]
  };
}
