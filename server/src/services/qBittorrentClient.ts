import type { DownloadTask } from "../types.js";

export interface QBittorrentSettings {
  baseUrl: string;
  username: string | null;
  password: string | null;
  apiKey: string | null;
}

interface QBittorrentTorrent {
  hash?: string;
  name?: string;
  progress?: number;
  state?: string;
  dlspeed?: number;
  eta?: number;
  category?: string;
  added_on?: number;
  completion_on?: number;
}

export class QBittorrentClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: QBittorrentSettings) {
    this.baseUrl = settings.baseUrl.replace(/\/+$/, "");
  }

  async version(): Promise<string> {
    return this.textRequest("/api/v2/app/version");
  }

  async listTorrents(): Promise<DownloadTask[]> {
    const data = await this.jsonRequest("/api/v2/torrents/info");
    const items = Array.isArray(data) ? (data as QBittorrentTorrent[]) : [];
    return items.map((item, index) => this.toDownloadTask(item, index));
  }

  async pause(hash: string): Promise<void> {
    await this.control(hash, ["stop", "pause"]);
  }

  async resume(hash: string): Promise<void> {
    await this.control(hash, ["start", "resume"]);
  }

  private async control(hash: string, endpoints: [string, string]): Promise<void> {
    const body = new URLSearchParams({ hashes: hash });
    try {
      await this.textRequest(`/api/v2/torrents/${endpoints[0]}`, {
        method: "POST",
        body: body.toString()
      });
    } catch (error) {
      if (!isEndpointFallbackError(error)) throw error;
      await this.textRequest(`/api/v2/torrents/${endpoints[1]}`, {
        method: "POST",
        body: body.toString()
      });
    }
  }

  private async jsonRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    const text = await this.textRequest(path, init);
    return text ? JSON.parse(text) : null;
  }

  private async textRequest(path: string, init: RequestInit = {}): Promise<string> {
    const headers = await this.authHeaders(init.body !== undefined);
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: mergeHeaders(headers, init.headers)
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new QBittorrentError(response.status, `qBittorrent ${response.status}: ${body || response.statusText}`);
    }

    return response.text();
  }

  private async authHeaders(hasBody: boolean): Promise<Headers> {
    const headers = new Headers();
    headers.set("accept", "application/json,text/plain,*/*");
    if (hasBody) {
      headers.set("content-type", "application/x-www-form-urlencoded");
    }
    if (this.settings.apiKey) {
      headers.set("authorization", `Bearer ${this.settings.apiKey}`);
      return headers;
    }

    if (!this.settings.username || !this.settings.password) {
      return headers;
    }

    const cookie = await this.login();
    headers.set("cookie", cookie);
    headers.set("referer", this.baseUrl);
    return headers;
  }

  private async login(): Promise<string> {
    const body = new URLSearchParams({
      username: this.settings.username ?? "",
      password: this.settings.password ?? ""
    });
    const response = await fetch(`${this.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: {
        "accept": "text/plain,*/*",
        "content-type": "application/x-www-form-urlencoded",
        "referer": this.baseUrl
      },
      body: body.toString()
    });

    const text = await response.text().catch(() => "");
    const loginSucceeded =
      response.status === 204 || (response.status === 200 && /^ok\.?$/i.test(text.trim()));
    if (!loginSucceeded) {
      throw new QBittorrentError(response.status, `qBittorrent login failed: ${text || response.statusText}`);
    }

    const rawCookie = response.headers.get("set-cookie");
    const cookie = rawCookie?.split(";")[0];
    if (!cookie) {
      throw new QBittorrentError(response.status, "qBittorrent login did not return a SID cookie");
    }
    return cookie;
  }

  private toDownloadTask(item: QBittorrentTorrent, index: number): DownloadTask {
    const hash = item.hash || `qbittorrent-${index}`;
    const progress = Math.max(0, Math.min(100, Number(item.progress ?? 0) * 100));
    const createdAt =
      item.added_on && item.added_on > 0
        ? new Date(item.added_on * 1000).toISOString()
        : new Date().toISOString();
    const completedAt =
      item.completion_on && item.completion_on > 0
        ? new Date(item.completion_on * 1000).toISOString()
        : undefined;

    return {
      id: hash,
      animeId: String(item.category || "qbittorrent"),
      title: String(item.name || "qBittorrent task"),
      episodeTitle: String(item.name || "qBittorrent task"),
      source: "qbittorrent",
      state: mapTorrentState(String(item.state || ""), progress),
      progress,
      speedBytesPerSecond: Number(item.dlspeed ?? 0),
      etaSeconds: Number.isFinite(Number(item.eta)) ? Number(item.eta) : null,
      externalHash: hash,
      createdAt,
      updatedAt: new Date().toISOString(),
      completedAt
    };
  }
}

class QBittorrentError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function mergeHeaders(base: Headers, override?: HeadersInit): Headers {
  const merged = new Headers(base);
  if (!override) return merged;
  new Headers(override).forEach((value, key) => merged.set(key, value));
  return merged;
}

function isEndpointFallbackError(error: unknown): boolean {
  return error instanceof QBittorrentError && [404, 405, 409].includes(error.status);
}

function mapTorrentState(state: string, progress: number): DownloadTask["state"] {
  const normalized = state.toLowerCase();
  if (normalized.includes("error") || normalized.includes("missing")) return "failed";
  if (normalized.includes("pause") || normalized.includes("stop")) return "paused";
  if (normalized.includes("queued")) return "queued";
  if (progress >= 100) return "completed";
  return "downloading";
}
