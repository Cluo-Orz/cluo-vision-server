import { randomUUID } from "node:crypto";

import type { JsonStore } from "../store/jsonStore.js";
import type { AnimeSearchResult, MediaItem, SearchHistoryEntry } from "../types.js";
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

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
