import type { MediaItem, PlaybackSession, PlaybackTarget } from "../types.js";

const TICKS_PER_SECOND = 10_000_000;

export interface JellyfinSettings {
  baseUrl: string;
  token: string;
  userId: string | null;
  deviceId: string;
}

export interface JellyfinAuthSettings {
  baseUrl: string;
  username: string;
  password: string;
  deviceId: string;
}

export interface JellyfinAuthResult {
  accessToken: string;
  user: {
    id: string;
    name: string;
  };
}

export class JellyfinClientError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

interface PlaybackInfoResponse {
  PlaySessionId?: string | null;
  MediaSources?: Array<{
    Id?: string;
    Container?: string;
    Path?: string;
    RunTimeTicks?: number;
    ETag?: string;
    Size?: number;
  }>;
}

interface JellyfinItemsResponse {
  Items?: JellyfinBaseItem[];
}

interface JellyfinBaseItem {
  Id?: string;
  Name?: string;
  Type?: string;
  SeriesId?: string;
  SeriesName?: string;
  Overview?: string;
  Genres?: string[];
  ProductionYear?: number;
  CommunityRating?: number;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  Path?: string;
  DateCreated?: string;
  RunTimeTicks?: number;
  ImageTags?: {
    Primary?: string;
  };
  MediaSources?: Array<{
    Id?: string;
    Container?: string;
    RunTimeTicks?: number;
    ETag?: string;
    Path?: string;
  }>;
  UserData?: {
    PlaybackPositionTicks?: number;
    Played?: boolean;
    IsFavorite?: boolean;
  };
}

interface JellyfinAuthenticationResponse {
  AccessToken?: string;
  User?: {
    Id?: string;
    Name?: string;
  };
}

export class JellyfinClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: JellyfinSettings) {
    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
  }

  static async authenticateByName(input: JellyfinAuthSettings): Promise<JellyfinAuthResult> {
    const baseUrl = input.baseUrl.replace(/\/+$/, "");
    const headers = new Headers();
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    headers.set(
      "authorization",
      `MediaBrowser Client="Cluo Vision", Device="cluo-server", DeviceId="${input.deviceId}", Version="0.1.0"`
    );

    const response = await fetch(`${baseUrl}/Users/AuthenticateByName`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        Username: input.username,
        Pw: input.password
      })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new JellyfinClientError(
        response.status,
        `Jellyfin authentication failed (${response.status}): ${text || response.statusText}`
      );
    }

    const data = (await response.json()) as JellyfinAuthenticationResponse;
    const accessToken = data.AccessToken;
    const userId = data.User?.Id;
    const userName = data.User?.Name ?? input.username;
    if (!accessToken || !userId) {
      throw new Error("Jellyfin authentication response is missing access token or user id");
    }

    return {
      accessToken,
      user: {
        id: userId,
        name: userName
      }
    };
  }

  async resolvePlayback(item: MediaItem, positionSeconds = 0): Promise<PlaybackTarget> {
    const jellyfinItemId = item.jellyfin?.itemId ?? item.id;
    const playbackInfo = await this.getPlaybackInfo(jellyfinItemId, secondsToTicks(positionSeconds));
    const mediaSource = playbackInfo.MediaSources?.[0];
    const mediaSourceId = item.jellyfin?.mediaSourceId ?? mediaSource?.Id ?? jellyfinItemId;
    const externalPlaySessionId = playbackInfo.PlaySessionId ?? undefined;
    const container = item.jellyfin?.container ?? mediaSource?.Container ?? "mkv";
    const durationSeconds =
      mediaSource?.RunTimeTicks !== undefined
        ? Math.round(mediaSource.RunTimeTicks / TICKS_PER_SECOND)
        : item.durationSeconds;

    return {
      provider: "jellyfin",
      mode: "stream-url",
      itemId: item.id,
      title: item.title,
      url: this.buildStreamUrl({
        itemId: jellyfinItemId,
        mediaSourceId,
        playSessionId: externalPlaySessionId,
        container,
        tag: item.jellyfin?.tag ?? mediaSource?.ETag,
        startTimeTicks: secondsToTicks(positionSeconds)
      }),
      durationSeconds,
      reportProvider: "jellyfin",
      externalItemId: jellyfinItemId,
      mediaSourceId,
      externalPlaySessionId
    };
  }

  async reportStart(session: PlaybackSession): Promise<void> {
    await this.report("/Sessions/Playing", this.playbackPayload(session));
  }

  async reportProgress(session: PlaybackSession): Promise<void> {
    await this.report("/Sessions/Playing/Progress", this.playbackPayload(session));
  }

  async reportStopped(session: PlaybackSession): Promise<void> {
    await this.report("/Sessions/Playing/Stopped", this.playbackPayload(session));
  }

  async refreshLibrary(): Promise<void> {
    const response = await this.fetch("/Library/Refresh", { method: "POST" });
    await response.body?.cancel().catch(() => undefined);
  }

  async health(): Promise<void> {
    const response = await this.fetch("/health");
    await response.body?.cancel().catch(() => undefined);
  }

  async getItem(itemId: string): Promise<MediaItem | null> {
    const jellyfinItemId = stripJellyfinPrefix(itemId);
    const response = await this.fetch(`${this.userItemPath(jellyfinItemId)}`);
    const data = (await response.json()) as JellyfinBaseItem;
    return this.toMediaItem(data);
  }

  async listResumeItems(input: { limit?: number } = {}): Promise<MediaItem[]> {
    const query = new URLSearchParams();
    query.set("Limit", String(input.limit ?? 10));
    query.set("MediaTypes", "Video");
    query.set("IncludeItemTypes", "Episode");
    query.set("Fields", "Path,Overview,ParentId,Genres,DateCreated,PrimaryImageAspectRatio");
    query.set("EnableImages", "true");
    query.set("EnableUserData", "true");
    query.set("ExcludeActiveSessions", "false");
    if (this.settings.userId) {
      query.set("UserId", this.settings.userId);
    }

    const response = await this.fetch(`/UserItems/Resume?${query}`);
    const data = (await response.json()) as JellyfinItemsResponse;
    return (data.Items ?? [])
      .map((item) => this.toMediaItem(item))
      .filter((item): item is MediaItem => Boolean(item));
  }

  async setWatched(itemId: string, watched: boolean): Promise<void> {
    if (!this.settings.userId) {
      throw new Error("Jellyfin userId is required to update watched state");
    }

    const method = watched ? "POST" : "DELETE";
    const response = await this.fetch(
      `/Users/${encodeURIComponent(this.settings.userId)}/PlayedItems/${encodeURIComponent(stripJellyfinPrefix(itemId))}`,
      { method }
    );
    await response.body?.cancel().catch(() => undefined);
  }

  async setFavorite(itemId: string, favorite: boolean): Promise<void> {
    if (!this.settings.userId) {
      throw new Error("Jellyfin userId is required to update favorite state");
    }

    const method = favorite ? "POST" : "DELETE";
    const response = await this.fetch(
      `/Users/${encodeURIComponent(this.settings.userId)}/FavoriteItems/${encodeURIComponent(stripJellyfinPrefix(itemId))}`,
      { method }
    );
    await response.body?.cancel().catch(() => undefined);
  }

  private async getPlaybackInfo(
    itemId: string,
    startTimeTicks: number
  ): Promise<PlaybackInfoResponse> {
    const path = `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`;
    const query = new URLSearchParams();
    query.set("StartTimeTicks", String(startTimeTicks));
    query.set("EnableDirectPlay", "true");
    query.set("EnableDirectStream", "true");
    query.set("EnableTranscoding", "true");
    if (this.settings.userId) {
      query.set("UserId", this.settings.userId);
    }

    const response = await this.fetch(`${path}?${query}`, {
      method: "POST",
      body: JSON.stringify({})
    });
    return response.json() as Promise<PlaybackInfoResponse>;
  }

  async listEpisodes(input: { searchTerm?: string; limit?: number } = {}): Promise<MediaItem[]> {
    const query = new URLSearchParams();
    query.set("Recursive", "true");
    query.set("IncludeItemTypes", "Episode");
    query.set("MediaTypes", "Video");
    query.set("Fields", "Path,Overview,ParentId,Genres,DateCreated,PrimaryImageAspectRatio");
    query.set("SortBy", "DateCreated");
    query.set("SortOrder", "Descending");
    query.set("EnableImages", "true");
    query.set("Limit", String(input.limit ?? 100));
    if (input.searchTerm) {
      query.set("SearchTerm", input.searchTerm);
    }
    if (this.settings.userId) {
      query.set("UserId", this.settings.userId);
      query.set("EnableUserData", "true");
    }

    const response = await this.fetch(`${this.itemsPath()}?${query}`);
    const data = (await response.json()) as JellyfinItemsResponse;
    return (data.Items ?? [])
      .map((item) => this.toMediaItem(item))
      .filter((item): item is MediaItem => Boolean(item));
  }

  private itemsPath(): string {
    return this.settings.userId
      ? `/Users/${encodeURIComponent(this.settings.userId)}/Items`
      : "/Items";
  }

  private userItemPath(itemId: string): string {
    return this.settings.userId
      ? `/Users/${encodeURIComponent(this.settings.userId)}/Items/${encodeURIComponent(itemId)}`
      : `/Items/${encodeURIComponent(itemId)}`;
  }

  private toMediaItem(item: JellyfinBaseItem): MediaItem | null {
    if (!item.Id || !item.Name) return null;

    const mediaSource = item.MediaSources?.[0];
    const durationTicks = mediaSource?.RunTimeTicks ?? item.RunTimeTicks ?? 0;
    const seasonEpisode = formatSeasonEpisode(item.ParentIndexNumber, item.IndexNumber);
    const title =
      item.SeriesName && seasonEpisode
        ? `${item.SeriesName} - ${seasonEpisode} - ${item.Name}`
        : item.SeriesName
          ? `${item.SeriesName} - ${item.Name}`
          : item.Name;

    return {
      id: `jellyfin:${item.Id}`,
      source: "jellyfin",
      type: "anime-episode",
      title,
      animeId: item.SeriesId ? `jellyfin:${item.SeriesId}` : `jellyfin:${item.Id}`,
      downloadTaskId: `jellyfin:${item.Id}`,
      posterUrl: this.imageUrl(item),
      overview: item.Overview,
      genres: item.Genres,
      year: item.ProductionYear,
      communityRating: item.CommunityRating,
      path: mediaSource?.Path ?? item.Path,
      durationSeconds: durationTicks > 0 ? Math.round(durationTicks / TICKS_PER_SECOND) : 0,
      playbackPositionSeconds:
        item.UserData?.PlaybackPositionTicks !== undefined
          ? Math.round(item.UserData.PlaybackPositionTicks / TICKS_PER_SECOND)
          : undefined,
      watched: item.UserData?.Played,
      favorite: item.UserData?.IsFavorite,
      createdAt: item.DateCreated ?? new Date().toISOString(),
      jellyfin: {
        itemId: item.Id,
        mediaSourceId: mediaSource?.Id,
        container: mediaSource?.Container,
        tag: mediaSource?.ETag
      }
    };
  }

  private imageUrl(item: JellyfinBaseItem): string | undefined {
    const tag = item.ImageTags?.Primary;
    if (!item.Id || !tag) return undefined;

    const url = new URL(`${this.baseUrl}/Items/${encodeURIComponent(item.Id)}/Images/Primary`);
    url.searchParams.set("tag", tag);
    url.searchParams.set("api_key", this.settings.token);
    return url.toString();
  }

  private buildStreamUrl(input: {
    itemId: string;
    mediaSourceId: string;
    playSessionId?: string;
    container: string;
    tag?: string;
    startTimeTicks: number;
  }): string {
    const extension = input.container.replace(/^\.+/, "") || "mkv";
    const url = new URL(`${this.baseUrl}/Videos/${encodeURIComponent(input.itemId)}/stream.${extension}`);
    url.searchParams.set("Static", "true");
    url.searchParams.set("mediaSourceId", input.mediaSourceId);
    url.searchParams.set("deviceId", this.settings.deviceId);
    url.searchParams.set("api_key", this.settings.token);
    url.searchParams.set("startTimeTicks", String(input.startTimeTicks));
    if (input.playSessionId) {
      url.searchParams.set("playSessionId", input.playSessionId);
    }
    if (input.tag) {
      url.searchParams.set("Tag", input.tag);
    }
    return url.toString();
  }

  private playbackPayload(session: PlaybackSession) {
    return {
      ItemId: session.externalItemId ?? session.itemId,
      MediaSourceId: session.mediaSourceId,
      PlaySessionId: session.externalPlaySessionId,
      PositionTicks: secondsToTicks(session.positionSeconds),
      CanSeek: true,
      IsPaused: session.state === "paused",
      IsMuted: false,
      PlaybackRate: 1,
      EventName: session.state === "completed" ? "timeupdate" : undefined
    };
  }

  private async report(path: string, body: unknown): Promise<void> {
    const response = await this.fetch(path, {
      method: "POST",
      body: JSON.stringify(body)
    });
    await response.body?.cancel().catch(() => undefined);
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    headers.set("x-emby-token", this.settings.token);
    headers.set(
      "authorization",
      `MediaBrowser Client="Cluo Vision", Device="cluo-server", DeviceId="${this.settings.deviceId}", Version="0.1.0", Token="${this.settings.token}"`
    );

    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new JellyfinClientError(response.status, `Jellyfin ${response.status}: ${text || response.statusText}`);
    }
    return response;
  }
}

export function secondsToTicks(seconds: number): number {
  return Math.max(0, Math.round(seconds * TICKS_PER_SECOND));
}

function formatSeasonEpisode(season?: number, episode?: number): string | null {
  const parts: string[] = [];
  if (season !== undefined) {
    parts.push(`S${String(season).padStart(2, "0")}`);
  }
  if (episode !== undefined) {
    parts.push(`E${String(episode).padStart(2, "0")}`);
  }
  return parts.length > 0 ? parts.join("") : null;
}

function stripJellyfinPrefix(itemId: string): string {
  return itemId.startsWith("jellyfin:") ? itemId.slice("jellyfin:".length) : itemId;
}
