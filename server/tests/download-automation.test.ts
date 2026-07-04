import assert from "node:assert/strict";
import test from "node:test";

import { DownloadAutomationService } from "../src/services/downloadAutomationService.js";
import type { DownloadImportResult } from "../src/services/libraryService.js";
import type { DownloadTask } from "../src/types.js";

test("download automation imports completed downloads once after success", async () => {
  const completed = downloadTask("done-1", "completed");
  const downloading = downloadTask("active-1", "downloading");
  const importedIds: string[] = [];
  const service = new DownloadAutomationService(
    {
      async listDownloads() {
        return [completed, downloading];
      }
    },
    {
      async importCompletedDownload(download) {
        importedIds.push(download.id);
        return importResult(download, "imported", 1);
      }
    },
    {
      enabled: false,
      intervalMs: 50,
      retryMs: 1_000
    }
  );

  const now = new Date("2026-07-05T12:00:00.000Z");
  const first = await service.runOnce(now);
  assert.equal(first.totalCompleted, 1);
  assert.equal(first.attempted, 1);
  assert.equal(first.imported, 1);
  assert.equal(first.synced, 1);
  assert.deepEqual(importedIds, ["done-1"]);

  const second = await service.runOnce(new Date(now.getTime() + 2_000));
  assert.equal(second.totalCompleted, 1);
  assert.equal(second.attempted, 0);
  assert.equal(second.skipped, 1);
  assert.deepEqual(importedIds, ["done-1"]);
});

test("download automation retries pending scan results after retry delay", async () => {
  const completed = downloadTask("pending-1", "completed");
  let attempts = 0;
  const service = new DownloadAutomationService(
    {
      async listDownloads() {
        return [completed];
      }
    },
    {
      async importCompletedDownload(download) {
        attempts += 1;
        return importResult(download, "pending-scan", 0);
      }
    },
    {
      enabled: false,
      intervalMs: 50,
      retryMs: 1_000
    }
  );

  const now = new Date("2026-07-05T12:00:00.000Z");
  const first = await service.runOnce(now);
  assert.equal(first.attempted, 1);
  assert.equal(first.pending, 1);
  assert.equal(attempts, 1);

  const throttled = await service.runOnce(new Date(now.getTime() + 500));
  assert.equal(throttled.attempted, 0);
  assert.equal(throttled.skipped, 1);
  assert.equal(attempts, 1);

  const retried = await service.runOnce(new Date(now.getTime() + 1_000));
  assert.equal(retried.attempted, 1);
  assert.equal(retried.pending, 1);
  assert.equal(attempts, 2);
});

function downloadTask(id: string, state: DownloadTask["state"]): DownloadTask {
  return {
    id,
    animeId: "anime-1",
    title: "迷宫饭",
    episodeTitle: "迷宫饭 - S01E01",
    source: "qbittorrent",
    state,
    progress: state === "completed" ? 100 : 50,
    speedBytesPerSecond: state === "completed" ? 0 : 1024,
    etaSeconds: state === "completed" ? 0 : 60,
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    completedAt: state === "completed" ? "2026-07-05T00:01:00.000Z" : undefined
  };
}

function importResult(
  download: DownloadTask,
  status: DownloadImportResult["status"],
  synced: number
): DownloadImportResult {
  return {
    configured: status !== "not-configured",
    scanTriggered: status !== "not-configured",
    synced,
    items: [],
    download,
    status,
    searchTerms: [download.title],
    message: status
  };
}
