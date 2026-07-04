import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config.js";
import type { DbState } from "../types.js";

export class JsonStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly config: AppConfig) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await readFile(this.filePath, "utf8");
    } catch {
      await this.write(this.defaultState());
    }
  }

  async read(): Promise<DbState> {
    await this.init();
    const raw = await readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DbState>;
    return this.withDefaults(parsed);
  }

  async update<T>(mutator: (state: DbState) => Promise<T> | T): Promise<T> {
    const task = this.queue.then(async () => {
      const state = await this.read();
      const result = await mutator(state);
      await this.write(state);
      return result;
    });

    this.queue = task.then(
      () => undefined,
      () => undefined
    );

    return task;
  }

  private async write(state: DbState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private defaultState(): DbState {
    return {
      users: [],
      settings: this.config.defaultSettings,
      animeSubscriptions: [],
      downloadTasks: [],
      mediaItems: [],
      history: [],
      searchHistory: [],
      playbackSessions: []
    };
  }

  private withDefaults(state: Partial<DbState>): DbState {
    return {
      users: state.users ?? [],
      settings: {
        autoBangumi: {
          ...this.config.defaultSettings.autoBangumi,
          ...(state.settings?.autoBangumi ?? {})
        },
        qBittorrent: {
          ...this.config.defaultSettings.qBittorrent,
          ...(state.settings?.qBittorrent ?? {})
        },
        jellyfin: {
          ...this.config.defaultSettings.jellyfin,
          ...(state.settings?.jellyfin ?? {})
        },
        playback: {
          ...this.config.defaultSettings.playback,
          ...(state.settings?.playback ?? {})
        }
      },
      animeSubscriptions: state.animeSubscriptions ?? [],
      downloadTasks: state.downloadTasks ?? [],
      mediaItems: state.mediaItems ?? [],
      history: state.history ?? [],
      searchHistory: state.searchHistory ?? [],
      playbackSessions: state.playbackSessions ?? []
    };
  }
}
