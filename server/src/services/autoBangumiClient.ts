import type { AnimeRule, AnimeSearchResult, DownloadTask } from "../types.js";

interface AutoBangumiClientOptions {
  baseUrl: string;
  token?: string | null;
}

export class AutoBangumiClient {
  private readonly baseUrl: string;

  constructor(private readonly options: AutoBangumiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async status(): Promise<unknown> {
    return this.requestJson("/api/v1/status");
  }

  async listBangumiRules(): Promise<AnimeRule[]> {
    const result = await this.requestJson("/api/v1/bangumi/get/all");
    const items = Array.isArray(result) ? result : [];
    return items.map((item, index) => this.toAnimeRule(item, index));
  }

  async listRss(): Promise<unknown[]> {
    const result = await this.requestJson("/api/v1/rss");
    return Array.isArray(result) ? result : [];
  }

  async searchBangumi(keyword: string, provider: string): Promise<AnimeSearchResult[]> {
    const url = new URL(`${this.baseUrl}/api/v1/search/bangumi`);
    url.searchParams.set("site", provider);
    url.searchParams.set("keywords", keyword);

    const response = await this.request(url, { method: "GET" });
    const text = await response.text();
    return this.parseSearchSse(text, provider);
  }

  async subscribeBangumi(input: {
    bangumi: Record<string, unknown>;
    rssUrl: string;
    rssName?: string;
    parser?: string;
  }): Promise<unknown> {
    return this.requestJson("/api/v1/rss/subscribe", {
      method: "POST",
      body: JSON.stringify({
        data: this.normalizeBangumiPayload(input.bangumi, input.rssUrl),
        rss: {
          id: 0,
          name:
            input.rssName ??
            String(input.bangumi.official_title ?? input.bangumi.title_raw ?? input.rssUrl),
          url: input.rssUrl,
          aggregate: false,
          parser: input.parser ?? "mikan",
          enabled: true,
          connection_status: null,
          last_checked_at: null,
          last_error: null
        }
      })
    });
  }

  async addRss(url: string, parser = "mikan"): Promise<unknown> {
    return this.requestJson("/api/v1/rss/add", {
      method: "POST",
      body: JSON.stringify({ url, aggregate: true, parser })
    });
  }

  async listTorrents(): Promise<DownloadTask[]> {
    const result = await this.requestJson("/api/v1/downloader/torrents");
    const items = Array.isArray(result) ? result : (result as { data?: unknown[] }).data ?? [];

    return items.map((item, index) => {
      const record = item as Record<string, unknown>;
      const progress = Number(record.progress ?? 0);
      const state = String(record.state ?? "downloading");
      return {
        id: String(record.hash ?? record.id ?? `autobangumi-${index}`),
        animeId: String(record.category ?? "autobangumi"),
        title: String(record.name ?? record.title ?? "AutoBangumi task"),
        episodeTitle: String(record.name ?? record.title ?? "AutoBangumi task"),
        source: "autobangumi",
        state: state.includes("complete") || progress >= 1 ? "completed" : "downloading",
        progress: progress <= 1 ? progress * 100 : progress,
        speedBytesPerSecond: Number(record.dlspeed ?? record.speed ?? 0),
        etaSeconds: Number.isFinite(Number(record.eta)) ? Number(record.eta) : null,
        externalHash: String(record.hash ?? ""),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    });
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(new URL(`${this.baseUrl}${path}`), init);
    if (response.status === 204) return null;
    return response.json();
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", headers.get("accept") ?? "application/json");
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (this.options.token) {
      headers.set("authorization", `Bearer ${this.options.token}`);
    }

    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`AutoBangumi ${response.status}: ${body || response.statusText}`);
    }
    return response;
  }

  private parseSearchSse(text: string, provider: string): AnimeSearchResult[] {
    const results: AnimeSearchResult[] = [];

    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload) as unknown;
        const records = Array.isArray(parsed) ? parsed : [parsed];
        for (const record of records) {
          const item = record as Record<string, unknown>;
          const title = String(
            item.official_title ?? item.title ?? item.name ?? item.bangumi_name ?? ""
          );
          if (!title) continue;
          results.push({
            id: String(item.id ?? item.url ?? `${provider}:${title}`),
            provider,
            title,
            originalTitle: typeof item.title_raw === "string" ? item.title_raw : undefined,
            description: typeof item.description === "string" ? item.description : undefined,
            posterUrl: typeof item.poster_link === "string" ? item.poster_link : undefined,
            sourceUrl: typeof item.url === "string" ? item.url : undefined,
            rssUrl: this.firstRssUrl(item.rss_link),
            confidence: Number(item.confidence ?? 0.8),
            raw: item
          });
        }
      } catch {
        continue;
      }
    }

    return results;
  }

  private firstRssUrl(value: unknown): string | undefined {
    if (Array.isArray(value)) {
      return typeof value[0] === "string" ? value[0] : undefined;
    }
    if (typeof value === "string") {
      return value.split(",").find(Boolean);
    }
    return undefined;
  }

  private toAnimeRule(item: unknown, index: number): AnimeRule {
    const record = item as Record<string, unknown>;
    const rssUrls = this.rssUrls(record.rss_link);
    const deleted = Boolean(record.deleted ?? false);
    const archived = Boolean(record.archived ?? false);

    return {
      id: String(record.id ?? `autobangumi-${index}`),
      title: String(record.official_title ?? record.title_raw ?? record.title ?? "AutoBangumi rule"),
      provider: "autobangumi",
      status: deleted ? "disabled" : "active",
      rssUrls,
      filter: typeof record.filter === "string" ? record.filter : undefined,
      posterUrl: typeof record.poster_link === "string" ? record.poster_link : undefined,
      season: numericOrUndefined(record.season),
      episodeOffset: numericOrUndefined(record.episode_offset),
      seasonOffset: numericOrUndefined(record.season_offset),
      archived,
      needsReview: Boolean(record.needs_review ?? false),
      raw: record
    };
  }

  private rssUrls(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item.length > 0);
    }
    if (typeof value === "string") {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
    return [];
  }

  private normalizeBangumiPayload(
    bangumi: Record<string, unknown>,
    fallbackRssUrl: string
  ): Record<string, unknown> {
    return {
      ...bangumi,
      id: Number(bangumi.id ?? 0),
      official_title: String(bangumi.official_title ?? bangumi.title ?? bangumi.title_raw ?? ""),
      title_raw: String(bangumi.title_raw ?? bangumi.official_title ?? bangumi.title ?? ""),
      season: Number(bangumi.season ?? 1),
      filter: Array.isArray(bangumi.filter)
        ? bangumi.filter.join(",")
        : String(bangumi.filter ?? "720,\\d+-\\d+"),
      rss_link: Array.isArray(bangumi.rss_link)
        ? bangumi.rss_link.join(",")
        : String(bangumi.rss_link ?? fallbackRssUrl),
      added: Boolean(bangumi.added ?? false),
      deleted: Boolean(bangumi.deleted ?? false),
      archived: Boolean(bangumi.archived ?? false),
      eps_collect: Boolean(bangumi.eps_collect ?? false),
      episode_offset: Number(bangumi.episode_offset ?? 0),
      season_offset: Number(bangumi.season_offset ?? 0),
      weekday_locked: Boolean(bangumi.weekday_locked ?? false),
      needs_review: Boolean(bangumi.needs_review ?? false)
    };
  }
}

function numericOrUndefined(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
