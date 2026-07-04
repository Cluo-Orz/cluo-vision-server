import { randomUUID } from "node:crypto";

import type { JsonStore } from "../store/jsonStore.js";
import type {
  AnimeSearchResult,
  DiscoverSource,
  MediaItem,
  SearchHistoryEntry,
  ServiceSettings
} from "../types.js";
import type { AnimeService } from "./animeService.js";
import type { LibraryService } from "./libraryService.js";

const MAX_HISTORY_PER_USER = 30;

export interface DiscoverSearchInput {
  q: string;
  provider?: string;
  limit?: number;
}

export interface DiscoverSearchResult {
  query: string;
  library: MediaItem[];
  anime: AnimeSearchResult[];
  recent: SearchHistoryEntry[];
}

export class DiscoveryService {
  constructor(
    private readonly store: JsonStore,
    private readonly libraryService: LibraryService,
    private readonly animeService: AnimeService
  ) {}

  async search(userId: string, input: DiscoverSearchInput): Promise<DiscoverSearchResult> {
    const query = input.q.trim();
    if (!query) {
      return {
        query,
        library: [],
        anime: [],
        recent: await this.recent(userId)
      };
    }

    const limit = input.limit ?? 12;
    const [library, anime] = await Promise.all([
      this.libraryService.search({ q: query, limit }),
      this.animeService.search(query, input.provider)
    ]);

    const recent = await this.record(userId, query, {
      library: library.length,
      anime: anime.length
    });

    return { query, library, anime, recent };
  }

  async recent(userId: string, limit = 10): Promise<SearchHistoryEntry[]> {
    const state = await this.store.read();
    return state.searchHistory
      .filter((item) => item.userId === userId)
      .sort((a, b) => Date.parse(b.lastSearchedAt) - Date.parse(a.lastSearchedAt))
      .slice(0, limit);
  }

  async sources(): Promise<DiscoverSource[]> {
    const state = await this.store.read();
    return buildSources(state.settings);
  }

  private async record(
    userId: string,
    query: string,
    resultCounts: SearchHistoryEntry["resultCounts"]
  ): Promise<SearchHistoryEntry[]> {
    const normalizedQuery = normalizeQuery(query);
    const now = new Date().toISOString();

    return this.store.update((state) => {
      const existing = state.searchHistory.find(
        (item) => item.userId === userId && item.normalizedQuery === normalizedQuery
      );

      if (existing) {
        existing.query = query;
        existing.searchCount += 1;
        existing.resultCounts = resultCounts;
        existing.lastSearchedAt = now;
      } else {
        state.searchHistory.push({
          id: randomUUID(),
          userId,
          query,
          normalizedQuery,
          searchCount: 1,
          resultCounts,
          createdAt: now,
          lastSearchedAt: now
        });
      }

      const userHistory = state.searchHistory
        .filter((item) => item.userId === userId)
        .sort((a, b) => Date.parse(b.lastSearchedAt) - Date.parse(a.lastSearchedAt));
      const keepIds = new Set(userHistory.slice(0, MAX_HISTORY_PER_USER).map((item) => item.id));
      state.searchHistory = state.searchHistory.filter(
        (item) => item.userId !== userId || keepIds.has(item.id)
      );

      return userHistory.slice(0, 10);
    });
  }
}

function buildSources(settings: ServiceSettings): DiscoverSource[] {
  const jellyfinConfigured = Boolean(settings.jellyfin.baseUrl && settings.jellyfin.token);
  const qBittorrentConfigured = Boolean(
    settings.qBittorrent.baseUrl &&
      (settings.qBittorrent.apiKey ||
        (settings.qBittorrent.username && settings.qBittorrent.password))
  );
  const autoBangumiConfigured = Boolean(settings.autoBangumi.baseUrl);
  const playbackProvider = settings.playback.preferredProvider;
  const playbackAvailable =
    playbackProvider === "local-dev" ||
    ((playbackProvider === "jellyfin" || playbackProvider === "external-player") &&
      jellyfinConfigured);

  return [
    {
      id: "jellyfin-library",
      label: "Jellyfin 媒体库",
      kind: "library",
      configured: jellyfinConfigured,
      available: jellyfinConfigured,
      status: jellyfinConfigured ? "ready" : "needs-config",
      description: jellyfinConfigured
        ? "已接入 Jellyfin，可搜索、同步和播放已入库 Episode。"
        : "配置 Jellyfin URL 和 token 后，可浏览真实媒体库和同步播放进度。",
      provider: "jellyfin",
      baseUrl: settings.jellyfin.baseUrl,
      tags: ["媒体库", "海报墙", "进度"],
      requiredFor: ["library", "playback", "history-sync"]
    },
    {
      id: "autobangumi-anime",
      label: "AutoBangumi 番剧",
      kind: "anime",
      configured: autoBangumiConfigured,
      available: autoBangumiConfigured,
      status: autoBangumiConfigured ? "ready" : "needs-config",
      description: autoBangumiConfigured
        ? `已接入 AutoBangumi，默认搜索 provider 为 ${settings.autoBangumi.preferredProvider}。`
        : "配置 AutoBangumi 后，可搜索番剧、订阅 RSS 规则并跟踪下载。",
      provider: settings.autoBangumi.preferredProvider,
      baseUrl: settings.autoBangumi.baseUrl,
      tags: ["番剧", "RSS", settings.autoBangumi.preferredProvider],
      requiredFor: ["anime-search", "anime-subscribe", "anime-download"]
    },
    {
      id: "qbittorrent-downloads",
      label: "qBittorrent 下载器",
      kind: "download",
      configured: qBittorrentConfigured,
      available: qBittorrentConfigured,
      status: qBittorrentConfigured ? "ready" : "needs-config",
      description: qBittorrentConfigured
        ? "已接入 qBittorrent，可查看真实下载队列并执行暂停/恢复。"
        : "配置 qBittorrent 地址和认证后，可控制真实下载任务。",
      provider: "qbittorrent",
      baseUrl: settings.qBittorrent.baseUrl,
      tags: ["下载", settings.qBittorrent.apiKey ? "api-key" : "webui"],
      requiredFor: ["download-control", "manual-download"]
    },
    {
      id: `playback-${playbackProvider}`,
      label: "播放出口",
      kind: "playback",
      configured: playbackAvailable,
      available: playbackAvailable,
      status:
        playbackProvider === "kodi" ? "reserved" : playbackAvailable ? "ready" : "needs-config",
      description: describePlaybackSource(playbackProvider, jellyfinConfigured),
      provider: playbackProvider,
      tags: ["播放", playbackProvider],
      requiredFor: ["watch"]
    },
    {
      id: "local-dev-fallback",
      label: "本地开发回退",
      kind: "fallback",
      configured: true,
      available: true,
      status: "ready",
      description: "未配置真实服务时，仍可用本地模拟数据验证搜索、下载、入库、播放和历史主链路。",
      provider: "local-dev",
      tags: ["开发", "离线", "回退"],
      requiredFor: ["local-validation"]
    }
  ];
}

function describePlaybackSource(
  provider: ServiceSettings["playback"]["preferredProvider"],
  jellyfinConfigured: boolean
): string {
  if (provider === "local-dev") return "当前使用本地模拟播放，适合开发验证。";
  if (provider === "jellyfin") {
    return jellyfinConfigured
      ? "当前使用 Jellyfin stream-url 播放。"
      : "Jellyfin 播放需要先配置 Jellyfin URL 和 token。";
  }
  if (provider === "external-player") {
    return jellyfinConfigured
      ? "当前通过 Android Intent 调起外部播放器，播放源来自 Jellyfin stream URL。"
      : "外部播放器需要先配置 Jellyfin，才能生成真实播放流。";
  }
  return "Kodi provider 已预留，需要完成实机 POC 后启用。";
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
