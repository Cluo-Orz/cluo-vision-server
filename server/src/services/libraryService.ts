import type { JsonStore } from "../store/jsonStore.js";
import type { DownloadTask, MediaItem, ServiceSettings } from "../types.js";
import { JellyfinClient } from "./jellyfinClient.js";

export interface JellyfinSyncInput {
  searchTerm?: string;
  limit?: number;
  scan?: boolean;
}

export interface JellyfinSyncResult {
  configured: boolean;
  scanTriggered: boolean;
  synced: number;
  items: MediaItem[];
}

export interface DownloadImportResult extends JellyfinSyncResult {
  download: DownloadTask;
  status: "imported" | "pending-scan" | "local-only" | "not-configured";
  searchTerms: string[];
  message: string;
}

export class LibraryService {
  constructor(private readonly store: JsonStore) {}

  async list(input: { limit?: number } = {}): Promise<MediaItem[]> {
    const state = await this.store.read();
    const client = this.jellyfinClient(state.settings);
    if (client) {
      try {
        const items = await client.listEpisodes({ limit: input.limit ?? 100 });
        return this.upsert(items);
      } catch {
        return this.localRecentlyAdded(state.mediaItems, input.limit);
      }
    }

    return this.localRecentlyAdded(state.mediaItems, input.limit);
  }

  async listResume(input: { limit?: number } = {}): Promise<MediaItem[]> {
    const state = await this.store.read();
    const client = this.jellyfinClient(state.settings);
    if (client) {
      try {
        const items = await client.listResumeItems({ limit: input.limit ?? 10 });
        return this.upsert(items);
      } catch {
        return this.localResume(state.mediaItems, input.limit);
      }
    }

    return this.localResume(state.mediaItems, input.limit);
  }

  async search(input: { q: string; limit?: number }): Promise<MediaItem[]> {
    const query = input.q.trim();
    if (!query) return [];

    const state = await this.store.read();
    const client = this.jellyfinClient(state.settings);
    if (client) {
      try {
        const items = await client.listEpisodes({
          searchTerm: query,
          limit: input.limit ?? 50
        });
        return this.upsert(items);
      } catch {
        return this.localSearch(state.mediaItems, query, input.limit);
      }
    }

    return this.localSearch(state.mediaItems, query, input.limit);
  }

  async getItem(itemId: string): Promise<MediaItem | null> {
    const state = await this.store.read();
    const local = state.mediaItems.find((item) => item.id === itemId);
    const client = this.jellyfinClient(state.settings);
    const jellyfinItemId = local?.jellyfin?.itemId ?? stripJellyfinPrefix(itemId);

    if (client && (itemId.startsWith("jellyfin:") || local?.source === "jellyfin")) {
      const item = await client.getItem(jellyfinItemId);
      if (!item) return local ?? null;
      const [updated] = await this.upsert([
        {
          ...item,
          id: local?.id ?? item.id,
          createdAt: local?.createdAt ?? item.createdAt
        }
      ]);
      return updated;
    }

    return local ?? null;
  }

  async related(itemId: string, limit = 8): Promise<MediaItem[]> {
    const state = await this.store.read();
    const item = state.mediaItems.find((media) => media.id === itemId);
    if (!item) return [];

    return relatedMediaItems(state.mediaItems, item, limit);
  }

  async setWatched(itemId: string, watched: boolean): Promise<MediaItem | null> {
    const state = await this.store.read();
    const local = state.mediaItems.find((item) => item.id === itemId);
    const client = this.jellyfinClient(state.settings);
    const jellyfinItemId = local?.jellyfin?.itemId ?? stripJellyfinPrefix(itemId);

    if (client && (itemId.startsWith("jellyfin:") || local?.source === "jellyfin")) {
      await client.setWatched(jellyfinItemId, watched);
      return this.getItem(local?.id ?? `jellyfin:${jellyfinItemId}`);
    }

    return this.store.update((state) => {
      const item = state.mediaItems.find((media) => media.id === itemId);
      if (!item) return null;
      item.watched = watched;
      item.playbackPositionSeconds = watched ? item.durationSeconds : 0;
      return item;
    });
  }

  async setFavorite(itemId: string, favorite: boolean): Promise<MediaItem | null> {
    const state = await this.store.read();
    const local = state.mediaItems.find((item) => item.id === itemId);
    const client = this.jellyfinClient(state.settings);
    const jellyfinItemId = local?.jellyfin?.itemId ?? stripJellyfinPrefix(itemId);

    if (client && (itemId.startsWith("jellyfin:") || local?.source === "jellyfin")) {
      await client.setFavorite(jellyfinItemId, favorite);
      return this.getItem(local?.id ?? `jellyfin:${jellyfinItemId}`);
    }

    return this.store.update((state) => {
      const item = state.mediaItems.find((media) => media.id === itemId);
      if (!item) return null;
      item.favorite = favorite;
      return item;
    });
  }

  async syncJellyfin(input: JellyfinSyncInput = {}): Promise<JellyfinSyncResult> {
    const state = await this.store.read();
    const client = this.jellyfinClient(state.settings);
    if (!client) {
      return {
        configured: false,
        scanTriggered: false,
        synced: 0,
        items: []
      };
    }

    if (input.scan) {
      await client.refreshLibrary();
    }

    const items = await client.listEpisodes(input);
    const syncedItems = await this.upsert(items);

    return {
      configured: true,
      scanTriggered: Boolean(input.scan),
      synced: syncedItems.length,
      items: syncedItems
    };
  }

  async importCompletedDownload(download: DownloadTask): Promise<DownloadImportResult> {
    const state = await this.store.read();
    const existing = state.mediaItems.filter((item) => item.downloadTaskId === download.id);
    const searchTerms = downloadSearchTerms(download);
    const client = this.jellyfinClient(state.settings);
    if (!client) {
      return {
        configured: false,
        scanTriggered: false,
        synced: existing.length,
        items: existing,
        download,
        status: existing.length > 0 ? "local-only" : "not-configured",
        searchTerms,
        message:
          existing.length > 0
            ? "Local media item already exists."
            : "Jellyfin is not configured; remote completed downloads cannot be imported."
      };
    }

    await client.refreshLibrary();
    let syncedItems: MediaItem[] = [];

    for (const searchTerm of searchTerms) {
      const items = await client.listEpisodes({ searchTerm, limit: 20 });
      if (items.length === 0) continue;
      syncedItems = await this.upsert(
        items.map((item) => ({
          ...item,
          downloadTaskId: download.id
        }))
      );
      break;
    }

    return {
      configured: true,
      scanTriggered: true,
      synced: syncedItems.length,
      items: syncedItems,
      download,
      status: syncedItems.length > 0 ? "imported" : "pending-scan",
      searchTerms,
      message:
        syncedItems.length > 0
          ? "Imported matched Jellyfin items."
          : "Jellyfin library scan was triggered, but no matching episode was found yet. Retry after Jellyfin finishes scanning."
    };
  }

  private async upsert(items: MediaItem[]): Promise<MediaItem[]> {
    return this.store.update((state) => {
      const updated: MediaItem[] = [];

      for (const item of items) {
        const existing = state.mediaItems.find(
          (media) => media.id === item.id || media.jellyfin?.itemId === item.jellyfin?.itemId
        );

        if (existing) {
          Object.assign(existing, {
            ...item,
            id: existing.id,
            createdAt: existing.createdAt
          });
          updated.push(existing);
        } else {
          state.mediaItems.push(item);
          updated.push(item);
        }
      }

      return updated;
    });
  }

  private jellyfinClient(settings: ServiceSettings): JellyfinClient | null {
    if (!settings.jellyfin.baseUrl || !settings.jellyfin.token) return null;

    return new JellyfinClient({
      baseUrl: settings.jellyfin.baseUrl,
      token: settings.jellyfin.token,
      userId: settings.jellyfin.userId,
      deviceId: settings.jellyfin.deviceId
    });
  }

  private localSearch(items: MediaItem[], query: string, limit = 50): MediaItem[] {
    const normalized = query.toLowerCase();
    return this.localRecentlyAdded(
      items.filter((item) => item.title.toLowerCase().includes(normalized)),
      limit
    );
  }

  private localResume(items: MediaItem[], limit = 10): MediaItem[] {
    return this.localRecentlyAdded(
      items.filter((item) => (item.playbackPositionSeconds ?? 0) > 0 && !item.watched),
      limit
    );
  }

  private localRecentlyAdded(items: MediaItem[], limit = 100): MediaItem[] {
    return [...items]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
  }
}

function relatedMediaItems(items: MediaItem[], item: MediaItem, limit: number): MediaItem[] {
  const genres = new Set((item.genres ?? []).map((value) => value.toLowerCase()));

  return items
    .filter((candidate) => candidate.id !== item.id)
    .map((candidate) => ({
      item: candidate,
      score: relatedScore(candidate, item, genres)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Date.parse(b.item.createdAt) - Date.parse(a.item.createdAt);
    })
    .map((entry) => entry.item)
    .slice(0, limit);
}

function relatedScore(candidate: MediaItem, item: MediaItem, genres: Set<string>): number {
  let score = 0;
  if (candidate.animeId && candidate.animeId === item.animeId) score += 100;
  if (candidate.type === item.type) score += 10;
  for (const genre of candidate.genres ?? []) {
    if (genres.has(genre.toLowerCase())) score += 5;
  }
  if (candidate.source === item.source) score += 1;
  return score;
}

function stripJellyfinPrefix(itemId: string): string {
  return itemId.startsWith("jellyfin:") ? itemId.slice("jellyfin:".length) : itemId;
}

function uniqueSearchTerms(values: Array<string | null | undefined>): string[] {
  const terms: string[] = [];
  for (const value of values) {
    const term = normalizeSearchTerm(value);
    if (term && !terms.includes(term)) {
      terms.push(term);
    }
  }
  return terms;
}

function titleWithoutEpisodeSuffix(value: string): string | null {
  return value
    .replace(/\s+-\s+S\d{1,2}E\d{1,3}$/i, "")
    .replace(/\s+-\s+\d{1,4}$/i, "")
    .trim() || null;
}

function downloadSearchTerms(download: DownloadTask): string[] {
  const cleaned = [cleanTorrentTitle(download.title), cleanTorrentTitle(download.episodeTitle)].filter(
    (item): item is string => Boolean(item)
  );
  const alternateTitles = cleaned.flatMap(splitAlternateTitles);

  return uniqueSearchTerms([
    download.title,
    download.episodeTitle,
    titleWithoutEpisodeSuffix(download.episodeTitle),
    ...cleaned,
    ...cleaned.map((item) => titleWithoutEpisodeSuffix(item)),
    ...alternateTitles,
    ...alternateTitles.map((item) => titleWithoutEpisodeSuffix(item))
  ]);
}

function cleanTorrentTitle(value: string): string | null {
  let cleaned = value
    .replace(/\.[a-z0-9]{2,5}$/i, " ")
    .replace(/[\[【][^\]】]*[\]】]/g, " ")
    .replace(/\([^)]*(?:1080|720|2160|4k|hevc|avc|x26[45]|aac|flac|web|baha|chs|cht|gb|big5|繁|简)[^)]*\)/gi, " ")
    .replace(/\s+-\s+(?:S\d{1,2}E\d{1,3}|\d{1,4})(?:\s|$).*/i, " ")
    .replace(/\s+(?:S\d{1,2}E\d{1,3}|第?\d{1,4}[话話集])(?:\s|$).*/i, " ")
    .replace(/\b(?:1080p?|720p?|2160p?|4k|web-?dl|webrip|bdrip|hevc|avc|x26[45]|aac|flac)\b/gi, " ");

  cleaned = normalizeSearchTerm(cleaned) ?? "";
  return cleaned || null;
}

function splitAlternateTitles(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/\s*(?:\/|／|\||｜)\s*/)
    .map((item) => normalizeSearchTerm(item))
    .filter((item): item is string => Boolean(item));
}

function normalizeSearchTerm(value: string | null | undefined): string | null {
  const term = value
    ?.replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.\-–—]+|[\s.\-–—]+$/g, "")
    .trim();
  return term && term.length >= 2 ? term : null;
}
