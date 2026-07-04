import { randomUUID } from "node:crypto";

import type { JsonStore } from "../store/jsonStore.js";
import type { AuthUser } from "../auth.js";
import type { HistoryEntry } from "../types.js";

export class HistoryService {
  constructor(private readonly store: JsonStore) {}

  async list(user: AuthUser): Promise<HistoryEntry[]> {
    const state = await this.store.read();
    return state.history
      .filter((item) => item.userId === user.id)
      .sort((a, b) => Date.parse(b.lastWatchedAt) - Date.parse(a.lastWatchedAt));
  }

  async record(
    user: AuthUser,
    input: {
      itemId: string;
      title: string;
      type: HistoryEntry["type"];
      posterUrl?: string;
      positionSeconds: number;
      durationSeconds: number;
    },
    options: { incrementPlayCount?: boolean } = {}
  ): Promise<HistoryEntry> {
    const now = new Date().toISOString();
    return this.store.update((state) => {
      const progress =
        input.durationSeconds > 0
          ? Math.min(1, Math.max(0, input.positionSeconds / input.durationSeconds))
          : 0;
      const completed = progress >= 0.9;
      let entry = state.history.find(
        (item) => item.userId === user.id && item.itemId === input.itemId
      );

      if (!entry) {
        entry = {
          id: randomUUID(),
          userId: user.id,
          itemId: input.itemId,
          title: input.title,
          type: input.type,
          posterUrl: input.posterUrl,
          positionSeconds: input.positionSeconds,
          durationSeconds: input.durationSeconds,
          progress,
          completed,
          playCount: 0,
          firstWatchedAt: now,
          lastWatchedAt: now
        };
        state.history.push(entry);
      }

      entry.title = input.title;
      entry.type = input.type;
      entry.posterUrl = input.posterUrl;
      entry.positionSeconds = input.positionSeconds;
      entry.durationSeconds = input.durationSeconds;
      entry.progress = progress;
      entry.completed = completed;
      if (options.incrementPlayCount ?? true) {
        entry.playCount += 1;
      }
      entry.lastWatchedAt = now;

      return entry;
    });
  }
}
