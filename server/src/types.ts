export type UserRole = "owner";

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  passwordSalt: string;
  passwordHash: string;
  createdAt: string;
}

export interface ServiceSettings {
  autoBangumi: {
    baseUrl: string | null;
    token: string | null;
    preferredProvider: string;
  };
  qBittorrent: {
    baseUrl: string | null;
    username: string | null;
    password: string | null;
    apiKey: string | null;
  };
  jellyfin: {
    baseUrl: string | null;
    token: string | null;
    userId: string | null;
    deviceId: string;
  };
  playback: {
    preferredProvider: "local-dev" | "external-player" | "jellyfin" | "kodi";
    externalPlayerPackage: string | null;
    externalPlayerMimeType: string;
  };
}

export interface AnimeSearchResult {
  id: string;
  provider: string;
  title: string;
  originalTitle?: string;
  description?: string;
  posterUrl?: string;
  sourceUrl?: string;
  rssUrl?: string;
  confidence: number;
  raw?: unknown;
}

export type AnimeSubscriptionStatus = "active" | "disabled" | "failed";

export interface AnimeSubscription {
  id: string;
  title: string;
  provider: string;
  rssUrl: string | null;
  posterUrl?: string;
  status: AnimeSubscriptionStatus;
  externalId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnimeRule {
  id: string;
  title: string;
  provider: "autobangumi" | "local-dev";
  status: AnimeSubscriptionStatus;
  rssUrls: string[];
  filter?: string;
  posterUrl?: string;
  season?: number;
  episodeOffset?: number;
  seasonOffset?: number;
  archived?: boolean;
  needsReview?: boolean;
  raw?: unknown;
}

export type DownloadState =
  | "queued"
  | "downloading"
  | "paused"
  | "completed"
  | "failed";

export interface DownloadTask {
  id: string;
  animeId: string;
  title: string;
  episodeTitle: string;
  source: "autobangumi" | "qbittorrent" | "local-dev";
  state: DownloadState;
  progress: number;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
  externalHash?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface MediaItem {
  id: string;
  source: "jellyfin" | "local-dev";
  type: "anime-episode";
  title: string;
  animeId: string;
  downloadTaskId: string;
  posterUrl?: string;
  overview?: string;
  genres?: string[];
  year?: number;
  communityRating?: number;
  path?: string;
  durationSeconds: number;
  playbackPositionSeconds?: number;
  watched?: boolean;
  favorite?: boolean;
  createdAt: string;
  jellyfin?: {
    itemId: string;
    mediaSourceId?: string;
    container?: string;
    tag?: string;
  };
}

export interface HistoryEntry {
  id: string;
  userId: string;
  itemId: string;
  title: string;
  type: "anime-episode" | "movie" | "series-episode";
  posterUrl?: string;
  positionSeconds: number;
  durationSeconds: number;
  progress: number;
  completed: boolean;
  playCount: number;
  firstWatchedAt: string;
  lastWatchedAt: string;
}

export interface SearchHistoryEntry {
  id: string;
  userId: string;
  query: string;
  normalizedQuery: string;
  searchCount: number;
  resultCounts: {
    library: number;
    anime: number;
  };
  createdAt: string;
  lastSearchedAt: string;
}

export type PlaybackSessionState = "playing" | "paused" | "stopped" | "completed";

export interface PlaybackIntent {
  action: "android.intent.action.VIEW";
  data: string;
  type: string;
  packageName?: string;
  uri: string;
}

export interface PlaybackSession {
  id: string;
  userId: string;
  itemId: string;
  title: string;
  type: "anime-episode" | "movie" | "series-episode";
  provider: "local-dev" | "external-player" | "jellyfin" | "kodi";
  mode: "mock-stream" | "intent" | "jsonrpc" | "stream-url" | "embedded";
  url?: string;
  intent?: PlaybackIntent;
  reportProvider?: "jellyfin";
  externalItemId?: string;
  mediaSourceId?: string;
  externalPlaySessionId?: string;
  state: PlaybackSessionState;
  positionSeconds: number;
  durationSeconds: number;
  progress: number;
  startedAt: string;
  updatedAt: string;
  stoppedAt?: string;
}

export interface PlaybackTarget {
  provider: PlaybackSession["provider"];
  mode: PlaybackSession["mode"];
  itemId: string;
  title: string;
  url?: string;
  intent?: PlaybackIntent;
  reportProvider?: PlaybackSession["reportProvider"];
  durationSeconds: number;
  externalItemId?: string;
  mediaSourceId?: string;
  externalPlaySessionId?: string;
}

export type ServiceHealthState = "ready" | "not-configured" | "unreachable" | "degraded";

export interface ServiceHealth {
  id: "cluo-server" | "autobangumi" | "qbittorrent" | "jellyfin" | "playback";
  label: string;
  configured: boolean;
  reachable: boolean;
  state: ServiceHealthState;
  requiredFor: string[];
  message: string;
  baseUrl?: string | null;
  checkedAt: string;
  details?: unknown;
}

export interface DbState {
  users: User[];
  settings: ServiceSettings;
  animeSubscriptions: AnimeSubscription[];
  downloadTasks: DownloadTask[];
  mediaItems: MediaItem[];
  history: HistoryEntry[];
  searchHistory: SearchHistoryEntry[];
  playbackSessions: PlaybackSession[];
}
