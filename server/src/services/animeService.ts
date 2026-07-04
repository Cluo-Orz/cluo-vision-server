import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { JsonStore } from "../store/jsonStore.js";
import type {
  AnimeRule,
  AnimeSearchResult,
  AnimeSubscription,
  DownloadTask,
  MediaItem
} from "../types.js";
import { AutoBangumiClient } from "./autoBangumiClient.js";
import { QBittorrentClient } from "./qBittorrentClient.js";

type DownloadControlResult =
  | { status: "ok"; task: DownloadTask }
  | { status: "not-found" }
  | { status: "not-controllable"; error: string };

type DownloadCompleteResult = DownloadControlResult;

const localCatalog: AnimeSearchResult[] = [
  {
    id: "local:mikan:delicious-in-dungeon",
    provider: "local-dev",
    title: "迷宫饭",
    originalTitle: "Dungeon Meshi",
    description: "本地开发目录中的模拟番剧，用于验证发现、订阅、下载和播放主链路。",
    rssUrl: "mock://rss/delicious-in-dungeon",
    confidence: 0.95
  },
  {
    id: "local:mikan:frieren",
    provider: "local-dev",
    title: "葬送的芙莉莲",
    originalTitle: "Sousou no Frieren",
    description: "本地开发目录中的模拟番剧。",
    rssUrl: "mock://rss/frieren",
    confidence: 0.92
  },
  {
    id: "local:mikan:bocchi",
    provider: "local-dev",
    title: "孤独摇滚！",
    originalTitle: "Bocchi the Rock!",
    description: "本地开发目录中的模拟番剧。",
    rssUrl: "mock://rss/bocchi",
    confidence: 0.9
  }
];

export class AnimeService {
  constructor(private readonly store: JsonStore, private readonly config: AppConfig) {}

  async autoBangumiStatus(): Promise<{
    configured: boolean;
    reachable: boolean;
    status: unknown;
    error?: string;
  }> {
    const state = await this.store.read();
    const client = this.autoBangumiClient(state.settings.autoBangumi);
    if (!client) {
      return {
        configured: false,
        reachable: false,
        status: null
      };
    }

    try {
      return {
        configured: true,
        reachable: true,
        status: await client.status()
      };
    } catch (error) {
      return {
        configured: true,
        reachable: false,
        status: null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async search(keyword: string, provider?: string): Promise<AnimeSearchResult[]> {
    const query = keyword.trim();
    if (!query) return [];

    const state = await this.store.read();
    const settings = state.settings.autoBangumi;

    if (settings.baseUrl) {
      try {
        const client = this.autoBangumiClient(settings);
        if (!client) throw new Error("AutoBangumi is not configured");
        const results = await client.searchBangumi(
          query,
          provider ?? settings.preferredProvider ?? "mikan"
        );
        if (results.length > 0) return results;
      } catch {
        // Fall through to the local provider. This keeps the main chain usable
        // when AutoBangumi is not running on the development machine.
      }
    }

    const normalized = query.toLowerCase();
    const matched = localCatalog.filter((item) => {
      return (
        item.title.toLowerCase().includes(normalized) ||
        item.originalTitle?.toLowerCase().includes(normalized)
      );
    });

    if (matched.length > 0) return matched;

    return [
      {
        id: `local:generated:${encodeURIComponent(query)}`,
        provider: "local-dev",
        title: query,
        description: "本地生成的模拟搜索结果。连接 AutoBangumi 后会替换为真实搜索结果。",
        rssUrl: `mock://rss/${encodeURIComponent(query)}`,
        confidence: 0.5
      }
    ];
  }

  starterSuggestions(limit = 3): AnimeSearchResult[] {
    return localCatalog.slice(0, limit);
  }

  async subscribe(input: {
    title: string;
    provider?: string;
    rssUrl?: string | null;
    posterUrl?: string;
    autoBangumi?: Record<string, unknown>;
  }): Promise<{ subscription: AnimeSubscription; download: DownloadTask }> {
    const now = new Date().toISOString();

    return this.store.update(async (state) => {
      const subscription: AnimeSubscription = {
        id: randomUUID(),
        title: input.title,
        provider: input.provider ?? "local-dev",
        rssUrl: input.rssUrl ?? null,
        posterUrl: input.posterUrl,
        status: "active",
        createdAt: now,
        updatedAt: now
      };

      if (state.settings.autoBangumi.baseUrl && input.rssUrl && !input.rssUrl.startsWith("mock://")) {
        try {
          const client = this.autoBangumiClient(state.settings.autoBangumi);
          if (!client) throw new Error("AutoBangumi is not configured");
          await client.subscribeBangumi({
            bangumi:
              input.autoBangumi ??
              ({
                id: 0,
                official_title: input.title,
                title_raw: input.title,
                rss_link: input.rssUrl,
                filter: "720,\\d+-\\d+"
              } satisfies Record<string, unknown>),
            rssUrl: input.rssUrl,
            rssName: input.title,
            parser: state.settings.autoBangumi.preferredProvider
          });
          subscription.externalId = input.rssUrl;
          subscription.provider = "autobangumi";
        } catch (error) {
          subscription.status = "failed";
          subscription.provider = "autobangumi";
        }
      }

      const isRemoteAutoBangumi =
        subscription.provider === "autobangumi" && subscription.status === "active";
      const download: DownloadTask = {
        id: randomUUID(),
        animeId: subscription.id,
        title: subscription.title,
        episodeTitle: `${subscription.title} - S01E01`,
        source: isRemoteAutoBangumi ? "autobangumi" : "local-dev",
        state: isRemoteAutoBangumi ? "queued" : "downloading",
        progress: 0,
        speedBytesPerSecond: 0,
        etaSeconds: isRemoteAutoBangumi ? null : Math.ceil(this.config.downloadSimulationMs / 1000),
        createdAt: now,
        updatedAt: now,
        startedAt: isRemoteAutoBangumi ? undefined : now,
        error:
          subscription.status === "failed"
            ? "AutoBangumi subscribe failed; local-dev fallback task created."
            : undefined
      };

      state.animeSubscriptions.push(subscription);
      state.downloadTasks.push(download);

      return { subscription, download };
    });
  }

  async listSubscriptions(): Promise<AnimeSubscription[]> {
    const state = await this.store.read();
    return state.animeSubscriptions;
  }

  async listRules(): Promise<{ configured: boolean; items: AnimeRule[]; error?: string }> {
    const state = await this.store.read();
    const client = this.autoBangumiClient(state.settings.autoBangumi);
    if (!client) {
      return {
        configured: false,
        items: this.localRules(state.animeSubscriptions)
      };
    }

    try {
      return {
        configured: true,
        items: await client.listBangumiRules()
      };
    } catch (error) {
      return {
        configured: true,
        items: this.localRules(state.animeSubscriptions),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listRss(): Promise<{ configured: boolean; items: unknown[]; error?: string }> {
    const state = await this.store.read();
    const client = this.autoBangumiClient(state.settings.autoBangumi);
    if (!client) {
      return {
        configured: false,
        items: []
      };
    }

    try {
      return {
        configured: true,
        items: await client.listRss()
      };
    } catch (error) {
      return {
        configured: true,
        items: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listDownloads(): Promise<DownloadTask[]> {
    await this.refreshLocalDownloads();
    const state = await this.store.read();
    const localTasks = state.downloadTasks;
    const client = this.autoBangumiClient(state.settings.autoBangumi);
    const qBittorrent = this.qBittorrentClient(state.settings.qBittorrent);
    const remoteTasks: DownloadTask[] = [];

    if (client) {
      try {
        remoteTasks.push(...(await client.listTorrents()));
      } catch {
        // Keep local tasks visible when AutoBangumi is temporarily unavailable.
      }
    }

    if (qBittorrent) {
      try {
        remoteTasks.push(...(await qBittorrent.listTorrents()));
      } catch {
        // A qBittorrent outage should not hide AutoBangumi/local tasks.
      }
    }

    if (remoteTasks.length === 0) return localTasks;

    const visibleLocalTasks = localTasks.filter((task) => {
      if (task.source !== "autobangumi" || Boolean(task.error)) return true;
      return !remoteTasks.some((remote) => sameAnimeDownload(task, remote));
    });
    return this.dedupeDownloads([...visibleLocalTasks, ...remoteTasks]);
  }

  async listMedia(): Promise<MediaItem[]> {
    await this.refreshLocalDownloads();
    const state = await this.store.read();
    return state.mediaItems;
  }

  async completeDownload(downloadId: string): Promise<DownloadCompleteResult> {
    return this.store.update((state) => {
      const task = state.downloadTasks.find((item) => item.id === downloadId);
      if (!task) return { status: "not-found" as const };
      if (task.source !== "local-dev") {
        return {
          status: "not-controllable" as const,
          error: "Only local-dev downloads can be completed locally."
        };
      }
      this.markCompleted(state, task, new Date().toISOString());
      return { status: "ok" as const, task };
    });
  }

  async pauseDownload(downloadId: string): Promise<DownloadControlResult> {
    return this.controlDownload(downloadId, "pause");
  }

  async resumeDownload(downloadId: string): Promise<DownloadControlResult> {
    return this.controlDownload(downloadId, "resume");
  }

  private async controlDownload(
    downloadId: string,
    action: "pause" | "resume"
  ): Promise<DownloadControlResult> {
    const local = await this.controlLocalDownload(downloadId, action);
    if (local.status !== "not-found") return local;

    const state = await this.store.read();
    const qBittorrent = this.qBittorrentClient(state.settings.qBittorrent);
    if (!qBittorrent) {
      return {
        status: "not-controllable",
        error: "qBittorrent is not configured; remote download cannot be controlled."
      };
    }

    try {
      if (action === "pause") {
        await qBittorrent.pause(downloadId);
      } else {
        await qBittorrent.resume(downloadId);
      }
      const downloads = await this.listDownloads();
      return {
        status: "ok",
        task:
          downloads.find((task) => task.id === downloadId || task.externalHash === downloadId) ??
          {
            id: downloadId,
            animeId: "qbittorrent",
            title: downloadId,
            episodeTitle: downloadId,
            source: "qbittorrent",
            state: action === "pause" ? "paused" : "downloading",
            progress: 0,
            speedBytesPerSecond: 0,
            etaSeconds: null,
            externalHash: downloadId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
      };
    } catch (error) {
      return {
        status: "not-controllable",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async controlLocalDownload(
    downloadId: string,
    action: "pause" | "resume"
  ): Promise<DownloadControlResult> {
    return this.store.update((state) => {
      const task = state.downloadTasks.find((item) => item.id === downloadId);
      if (!task) return { status: "not-found" as const };
      if (task.source !== "local-dev") {
        return {
          status: "not-controllable" as const,
          error: "Only local-dev tasks can be controlled without qBittorrent."
        };
      }
      if (task.state === "completed") {
        return {
          status: "not-controllable" as const,
          error: "Completed downloads cannot be paused or resumed."
        };
      }

      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      if (action === "pause") {
        task.state = "paused";
        task.speedBytesPerSecond = 0;
        task.etaSeconds = null;
      } else {
        task.state = "downloading";
        task.startedAt = new Date(now - (task.progress / 100) * this.config.downloadSimulationMs).toISOString();
        task.etaSeconds = Math.max(
          1,
          Math.ceil(((100 - task.progress) / 100) * this.config.downloadSimulationMs / 1000)
        );
      }
      task.updatedAt = nowIso;
      return { status: "ok" as const, task };
    });
  }

  private async refreshLocalDownloads(): Promise<void> {
    await this.store.update((state) => {
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      for (const task of state.downloadTasks) {
        if (task.source !== "local-dev" || task.state !== "downloading" || !task.startedAt) continue;

        const elapsed = now - new Date(task.startedAt).getTime();
        const progress = Math.min(100, Math.round((elapsed / this.config.downloadSimulationMs) * 100));
        task.progress = progress;
        task.speedBytesPerSecond = progress >= 100 ? 0 : 4 * 1024 * 1024;
        task.etaSeconds =
          progress >= 100
            ? 0
            : Math.max(1, Math.ceil((this.config.downloadSimulationMs - elapsed) / 1000));
        task.updatedAt = nowIso;

        if (progress >= 100) {
          this.markCompleted(state, task, nowIso);
        }
      }
    });
  }

  private markCompleted(
    state: { mediaItems: MediaItem[]; downloadTasks: DownloadTask[] },
    task: DownloadTask,
    nowIso: string
  ): void {
    task.state = "completed";
    task.progress = 100;
    task.speedBytesPerSecond = 0;
    task.etaSeconds = 0;
    task.completedAt = task.completedAt ?? nowIso;
    task.updatedAt = nowIso;

    if (state.mediaItems.some((item) => item.downloadTaskId === task.id)) return;

    state.mediaItems.push({
      id: randomUUID(),
      source: "local-dev",
      type: "anime-episode",
      title: task.episodeTitle,
      animeId: task.animeId,
      downloadTaskId: task.id,
      path: `mock://media/${task.id}.mkv`,
      durationSeconds: 24 * 60,
      createdAt: nowIso
    });
  }

  private autoBangumiClient(settings: {
    baseUrl: string | null;
    token: string | null;
  }): AutoBangumiClient | null {
    if (!settings.baseUrl) return null;
    return new AutoBangumiClient({
      baseUrl: settings.baseUrl,
      token: settings.token
    });
  }

  private qBittorrentClient(settings: {
    baseUrl: string | null;
    username: string | null;
    password: string | null;
    apiKey: string | null;
  }): QBittorrentClient | null {
    if (!settings.baseUrl) return null;
    return new QBittorrentClient({
      baseUrl: settings.baseUrl,
      username: settings.username,
      password: settings.password,
      apiKey: settings.apiKey
    });
  }

  private dedupeDownloads(tasks: DownloadTask[]): DownloadTask[] {
    const byHash = new Map<string, DownloadTask>();
    const ordered: DownloadTask[] = [];

    for (const task of tasks) {
      const key = task.externalHash || task.id;
      const existing = byHash.get(key);
      if (!existing) {
        byHash.set(key, task);
        ordered.push(task);
        continue;
      }

      if (existing.source === "qbittorrent" && task.source === "autobangumi") {
        Object.assign(existing, task);
      }
    }

    return ordered;
  }

  private localRules(subscriptions: AnimeSubscription[]): AnimeRule[] {
    return subscriptions.map((item) => ({
      id: item.id,
      title: item.title,
      provider: item.provider === "autobangumi" ? "autobangumi" : "local-dev",
      status: item.status,
      rssUrls: item.rssUrl ? [item.rssUrl] : [],
      posterUrl: item.posterUrl,
      raw: item
    }));
  }
}

function sameAnimeDownload(left: DownloadTask, right: DownloadTask): boolean {
  const title = normalizeTitle(left.title);
  if (!title) return false;
  return normalizeTitle(right.title).includes(title) || normalizeTitle(right.episodeTitle).includes(title);
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, "").toLowerCase();
}
