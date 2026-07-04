import { randomUUID } from "node:crypto";

import type { AuthUser } from "../auth.js";
import type { JsonStore } from "../store/jsonStore.js";
import type { DbState, MediaItem, PlaybackSession, PlaybackTarget, ServiceSettings } from "../types.js";
import { HistoryService } from "./historyService.js";
import { JellyfinClient } from "./jellyfinClient.js";

export class PlaybackService {
  constructor(
    private readonly store: JsonStore,
    private readonly historyService: HistoryService
  ) {}

  async resolve(itemId: string): Promise<PlaybackTarget | null> {
    const state = await this.store.read();
    const item = state.mediaItems.find((media) => media.id === itemId);
    if (!item) return null;

    return this.resolveTarget(item, state.settings);
  }

  async start(user: AuthUser, itemId: string): Promise<PlaybackSession | null> {
    const state = await this.store.read();
    const item = state.mediaItems.find((media) => media.id === itemId);
    if (!item) return null;

    const startPositionSeconds = this.resumePositionSeconds(user, item, state);
    const target = await this.resolveTarget(item, state.settings, startPositionSeconds);
    if (!target) return null;

    const now = new Date().toISOString();
    const session = await this.store.update((state) => {
      if (!state.mediaItems.some((media) => media.id === itemId)) return null;

      const created: PlaybackSession = {
        id: randomUUID(),
        userId: user.id,
        itemId: target.itemId,
        title: target.title,
        type: "anime-episode",
        provider: target.provider,
        mode: target.mode,
        url: target.url,
        intent: target.intent,
        reportProvider: target.reportProvider,
        externalItemId: target.externalItemId,
        mediaSourceId: target.mediaSourceId,
        externalPlaySessionId: target.externalPlaySessionId,
        state: "playing",
        positionSeconds: startPositionSeconds,
        durationSeconds: target.durationSeconds,
        progress: progressFor(startPositionSeconds, target.durationSeconds),
        startedAt: now,
        updatedAt: now
      };
      state.playbackSessions.push(created);
      this.syncMediaPlaybackState(state, created);
      return created;
    });

    if (session) {
      await this.historyService.record(
        user,
        {
          itemId: session.itemId,
          title: session.title,
          type: session.type,
          positionSeconds: session.positionSeconds,
          durationSeconds: session.durationSeconds
        },
        { incrementPlayCount: true }
      );
      await this.reportJellyfin("start", session, state.settings);
    }

    return session;
  }

  async heartbeat(
    user: AuthUser,
    sessionId: string,
    input: { positionSeconds: number; state?: "playing" | "paused" }
  ): Promise<PlaybackSession | null> {
    const result = await this.store.update((state) => {
      const session = state.playbackSessions.find(
        (item) => item.id === sessionId && item.userId === user.id
      );
      if (!session) return null;

      this.updateSessionProgress(session, input.positionSeconds, input.state ?? "playing");
      this.syncMediaPlaybackState(state, session);
      return { session, settings: state.settings };
    });

    if (result) {
      await this.writeHistory(user, result.session, false);
      await this.reportJellyfin("progress", result.session, result.settings);
    }

    return result?.session ?? null;
  }

  async stop(
    user: AuthUser,
    sessionId: string,
    input: { positionSeconds?: number } = {}
  ): Promise<PlaybackSession | null> {
    const result = await this.store.update((state) => {
      const session = state.playbackSessions.find(
        (item) => item.id === sessionId && item.userId === user.id
      );
      if (!session) return null;

      this.updateSessionProgress(
        session,
        input.positionSeconds ?? session.positionSeconds,
        session.progress >= 0.9 ? "completed" : "stopped"
      );
      session.stoppedAt = new Date().toISOString();
      this.syncMediaPlaybackState(state, session);
      return { session, settings: state.settings };
    });

    if (result) {
      await this.writeHistory(user, result.session, false);
      await this.reportJellyfin("stopped", result.session, result.settings);
    }

    return result?.session ?? null;
  }

  async list(user: AuthUser): Promise<PlaybackSession[]> {
    const state = await this.store.read();
    return state.playbackSessions
      .filter((session) => session.userId === user.id)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  private async resolveTarget(
    item: MediaItem,
    settings: ServiceSettings,
    positionSeconds = 0
  ): Promise<PlaybackTarget | null> {
    const jellyfin = this.jellyfinClient(settings);
    const canUseJellyfin =
      Boolean(jellyfin) &&
      (item.source === "jellyfin" ||
        ((settings.playback.preferredProvider === "jellyfin" ||
          settings.playback.preferredProvider === "external-player") &&
          Boolean(item.jellyfin)));

    if (canUseJellyfin && jellyfin) {
      const jellyfinTarget = await jellyfin.resolvePlayback(item, positionSeconds);
      if (settings.playback.preferredProvider === "external-player") {
        return this.toExternalPlayerTarget(jellyfinTarget, settings);
      }
      return jellyfinTarget;
    }

    return this.toLocalDevTarget(item);
  }

  private toExternalPlayerTarget(
    target: PlaybackTarget,
    settings: ServiceSettings
  ): PlaybackTarget | null {
    if (!target.url) return null;

    return {
      ...target,
      provider: "external-player",
      mode: "intent",
      intent: buildAndroidViewIntent(target.url, {
        mimeType: settings.playback.externalPlayerMimeType,
        packageName: settings.playback.externalPlayerPackage
      })
    };
  }

  private toLocalDevTarget(item: MediaItem): PlaybackTarget | null {
    if (!item.path) return null;

    return {
      provider: "local-dev",
      mode: "mock-stream",
      itemId: item.id,
      title: item.title,
      url: item.path,
      durationSeconds: item.durationSeconds
    };
  }

  private resumePositionSeconds(user: AuthUser, item: MediaItem, state: DbState): number {
    const localHistory = state.history.find(
      (entry) => entry.userId === user.id && entry.itemId === item.id && !entry.completed
    );
    if (localHistory) {
      return resumablePosition(localHistory.positionSeconds, localHistory.durationSeconds);
    }
    if (item.watched) return 0;
    return resumablePosition(item.playbackPositionSeconds ?? 0, item.durationSeconds);
  }

  private syncMediaPlaybackState(state: DbState, session: PlaybackSession): void {
    const item = state.mediaItems.find((media) => media.id === session.itemId);
    if (!item) return;

    item.playbackPositionSeconds =
      session.state === "completed" ? session.durationSeconds : session.positionSeconds;
    if (session.state === "completed") {
      item.watched = true;
    }
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

  private async reportJellyfin(
    event: "start" | "progress" | "stopped",
    session: PlaybackSession,
    settings: ServiceSettings
  ): Promise<void> {
    if (session.reportProvider !== "jellyfin" && session.provider !== "jellyfin") return;

    const client = this.jellyfinClient(settings);
    if (!client) return;

    try {
      if (event === "start") {
        await client.reportStart(session);
      } else if (event === "progress") {
        await client.reportProgress(session);
      } else {
        await client.reportStopped(session);
      }
    } catch {
      // Playback state and local history must stay usable even if Jellyfin reporting is unavailable.
    }
  }

  private updateSessionProgress(
    session: PlaybackSession,
    positionSeconds: number,
    state: PlaybackSession["state"]
  ): void {
    const clamped = Math.min(Math.max(0, positionSeconds), session.durationSeconds);
    const progress = progressFor(clamped, session.durationSeconds);

    session.positionSeconds = clamped;
    session.progress = progress;
    session.state = progress >= 0.9 ? "completed" : state;
    session.updatedAt = new Date().toISOString();
    if (session.state === "completed") {
      session.stoppedAt = session.stoppedAt ?? session.updatedAt;
    }
  }

  private async writeHistory(
    user: AuthUser,
    session: PlaybackSession,
    incrementPlayCount: boolean
  ) {
    await this.historyService.record(
      user,
      {
        itemId: session.itemId,
        title: session.title,
        type: session.type,
        positionSeconds: session.positionSeconds,
        durationSeconds: session.durationSeconds
      },
      { incrementPlayCount }
    );
  }
}

function clampPosition(positionSeconds: number, durationSeconds: number): number {
  return Math.min(Math.max(0, positionSeconds), durationSeconds);
}

function progressFor(positionSeconds: number, durationSeconds: number): number {
  return durationSeconds > 0 ? clampPosition(positionSeconds, durationSeconds) / durationSeconds : 0;
}

function resumablePosition(positionSeconds: number, durationSeconds: number): number {
  const clamped = clampPosition(positionSeconds, durationSeconds);
  return progressFor(clamped, durationSeconds) >= 0.9 ? 0 : clamped;
}

function buildAndroidViewIntent(
  data: string,
  input: { mimeType: string; packageName: string | null }
) {
  const mimeType = input.mimeType.trim() || "video/*";
  const packageName = input.packageName?.trim() || undefined;

  return {
    action: "android.intent.action.VIEW" as const,
    data,
    type: mimeType,
    packageName,
    uri: buildIntentUri(data, mimeType, packageName)
  };
}

function buildIntentUri(data: string, mimeType: string, packageName?: string): string {
  const url = new URL(data);
  const pathAndQuery = `${url.host}${url.pathname}${url.search}`;
  const parts = [
    `intent://${pathAndQuery}#Intent`,
    `scheme=${encodeIntentValue(url.protocol.replace(/:$/, ""))}`,
    "action=android.intent.action.VIEW",
    `type=${encodeIntentValue(mimeType)}`
  ];
  if (packageName) {
    parts.push(`package=${encodeIntentValue(packageName)}`);
  }
  parts.push("end");
  return parts.join(";");
}

function encodeIntentValue(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}
