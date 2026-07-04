import type { JsonStore } from "../store/jsonStore.js";
import type { ServiceHealth, ServiceSettings } from "../types.js";
import { AutoBangumiClient } from "./autoBangumiClient.js";
import { JellyfinClient } from "./jellyfinClient.js";
import { QBittorrentClient } from "./qBittorrentClient.js";

const CHECK_TIMEOUT_MS = 3_000;

export interface SystemStatus {
  checkedAt: string;
  overall: ServiceHealth["state"];
  items: ServiceHealth[];
}

export class ServiceHealthService {
  constructor(private readonly store: JsonStore) {}

  async status(): Promise<SystemStatus> {
    const state = await this.store.read();
    const checkedAt = new Date().toISOString();
    const [autoBangumi, qBittorrent, jellyfin] = await Promise.all([
      this.checkAutoBangumi(state.settings, checkedAt),
      this.checkQBittorrent(state.settings, checkedAt),
      this.checkJellyfin(state.settings, checkedAt)
    ]);

    const items: ServiceHealth[] = [
      {
        id: "cluo-server",
        label: "cluo-server",
        configured: true,
        reachable: true,
        state: "ready",
        requiredFor: ["login", "settings", "bff"],
        message: "BFF is running.",
        checkedAt
      },
      autoBangumi,
      qBittorrent,
      jellyfin,
      this.checkPlayback(state.settings, jellyfin, checkedAt)
    ];

    return {
      checkedAt,
      overall: this.overall(items),
      items
    };
  }

  private async checkAutoBangumi(settings: ServiceSettings, checkedAt: string): Promise<ServiceHealth> {
    const baseUrl = settings.autoBangumi.baseUrl;
    if (!baseUrl) {
      return {
        id: "autobangumi",
        label: "AutoBangumi",
        configured: false,
        reachable: false,
        state: "not-configured",
        requiredFor: ["anime-search", "anime-subscribe", "anime-download"],
        message: "AutoBangumi is not configured; local-dev anime flow is available.",
        baseUrl,
        checkedAt
      };
    }

    try {
      const client = new AutoBangumiClient({
        baseUrl,
        token: settings.autoBangumi.token
      });
      const status = await withTimeout(client.status(), CHECK_TIMEOUT_MS, "AutoBangumi status timed out");
      return {
        id: "autobangumi",
        label: "AutoBangumi",
        configured: true,
        reachable: true,
        state: "ready",
        requiredFor: ["anime-search", "anime-subscribe", "anime-download"],
        message: "AutoBangumi is reachable.",
        baseUrl,
        checkedAt,
        details: status
      };
    } catch (error) {
      return {
        id: "autobangumi",
        label: "AutoBangumi",
        configured: true,
        reachable: false,
        state: "unreachable",
        requiredFor: ["anime-search", "anime-subscribe", "anime-download"],
        message: errorMessage(error),
        baseUrl,
        checkedAt
      };
    }
  }

  private async checkQBittorrent(settings: ServiceSettings, checkedAt: string): Promise<ServiceHealth> {
    const baseUrl = settings.qBittorrent.baseUrl;
    if (!baseUrl) {
      return {
        id: "qbittorrent",
        label: "qBittorrent",
        configured: false,
        reachable: false,
        state: "not-configured",
        requiredFor: ["download-control", "manual-download"],
        message: "qBittorrent is not configured; AutoBangumi/local-dev downloads may still be visible.",
        baseUrl,
        checkedAt
      };
    }

    if (!settings.qBittorrent.apiKey && (!settings.qBittorrent.username || !settings.qBittorrent.password)) {
      return {
        id: "qbittorrent",
        label: "qBittorrent",
        configured: false,
        reachable: false,
        state: "degraded",
        requiredFor: ["download-control", "manual-download"],
        message: "qBittorrent URL is set, but username/password or API key is missing.",
        baseUrl,
        checkedAt
      };
    }

    try {
      const client = new QBittorrentClient({
        baseUrl,
        username: settings.qBittorrent.username,
        password: settings.qBittorrent.password,
        apiKey: settings.qBittorrent.apiKey
      });
      const version = await withTimeout(client.version(), CHECK_TIMEOUT_MS, "qBittorrent version check timed out");
      return {
        id: "qbittorrent",
        label: "qBittorrent",
        configured: true,
        reachable: true,
        state: "ready",
        requiredFor: ["download-control", "manual-download"],
        message: "qBittorrent is reachable.",
        baseUrl,
        checkedAt,
        details: { version }
      };
    } catch (error) {
      return {
        id: "qbittorrent",
        label: "qBittorrent",
        configured: true,
        reachable: false,
        state: "unreachable",
        requiredFor: ["download-control", "manual-download"],
        message: errorMessage(error),
        baseUrl,
        checkedAt
      };
    }
  }

  private async checkJellyfin(settings: ServiceSettings, checkedAt: string): Promise<ServiceHealth> {
    const baseUrl = settings.jellyfin.baseUrl;
    const token = settings.jellyfin.token;
    if (!baseUrl || !token) {
      return {
        id: "jellyfin",
        label: "Jellyfin",
        configured: false,
        reachable: false,
        state: "not-configured",
        requiredFor: ["library", "playback", "history-sync"],
        message: "Jellyfin URL and token are required for real library and playback.",
        baseUrl,
        checkedAt
      };
    }

    try {
      const client = new JellyfinClient({
        baseUrl,
        token,
        userId: settings.jellyfin.userId,
        deviceId: settings.jellyfin.deviceId
      });
      await withTimeout(client.health(), CHECK_TIMEOUT_MS, "Jellyfin health timed out");
      return {
        id: "jellyfin",
        label: "Jellyfin",
        configured: true,
        reachable: true,
        state: settings.jellyfin.userId ? "ready" : "degraded",
        requiredFor: ["library", "playback", "history-sync"],
        message: settings.jellyfin.userId
          ? "Jellyfin is reachable."
          : "Jellyfin is reachable, but userId is missing; watched/favorite updates are limited.",
        baseUrl,
        checkedAt
      };
    } catch (error) {
      return {
        id: "jellyfin",
        label: "Jellyfin",
        configured: true,
        reachable: false,
        state: "unreachable",
        requiredFor: ["library", "playback", "history-sync"],
        message: errorMessage(error),
        baseUrl,
        checkedAt
      };
    }
  }

  private checkPlayback(
    settings: ServiceSettings,
    jellyfin: ServiceHealth,
    checkedAt: string
  ): ServiceHealth {
    const provider = settings.playback.preferredProvider;
    if (provider === "local-dev") {
      return {
        id: "playback",
        label: "Playback",
        configured: true,
        reachable: true,
        state: "ready",
        requiredFor: ["watch"],
        message: "local-dev mock playback is available.",
        checkedAt,
        details: { preferredProvider: provider }
      };
    }

    if (provider === "jellyfin") {
      return {
        id: "playback",
        label: "Playback",
        configured: jellyfin.configured,
        reachable: jellyfin.reachable,
        state: jellyfin.reachable ? "ready" : "degraded",
        requiredFor: ["watch"],
        message: jellyfin.reachable
          ? "Jellyfin stream-url playback is available."
          : "Preferred playback is Jellyfin, but Jellyfin is not reachable.",
        checkedAt,
        details: { preferredProvider: provider }
      };
    }

    if (provider === "external-player") {
      return {
        id: "playback",
        label: "Playback",
        configured: jellyfin.configured,
        reachable: jellyfin.reachable,
        state: jellyfin.reachable ? "ready" : "degraded",
        requiredFor: ["watch"],
        message: jellyfin.reachable
          ? "External Android player intent playback is available through Jellyfin stream URLs."
          : "Preferred playback is external-player, but Jellyfin is not reachable.",
        checkedAt,
        details: {
          preferredProvider: provider,
          externalPlayerPackage: settings.playback.externalPlayerPackage,
          externalPlayerMimeType: settings.playback.externalPlayerMimeType
        }
      };
    }

    return {
      id: "playback",
      label: "Playback",
      configured: false,
      reachable: false,
      state: "degraded",
      requiredFor: ["watch"],
      message: `${provider} provider is reserved for TV/Kodi POC and is not enabled yet.`,
      checkedAt,
      details: { preferredProvider: provider }
    };
  }

  private overall(items: ServiceHealth[]): ServiceHealth["state"] {
    if (items.some((item) => item.state === "unreachable")) return "unreachable";
    if (items.some((item) => item.state === "degraded")) return "degraded";
    if (items.some((item) => item.state === "not-configured")) return "degraded";
    return "ready";
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
