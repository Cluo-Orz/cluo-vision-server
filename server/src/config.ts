import path from "node:path";

import type { ServiceSettings } from "./types.js";

export interface AppConfig {
  host: string;
  port: number;
  dataFile: string;
  tokenSecret: string;
  tokenTtlSeconds: number;
  downloadSimulationMs: number;
  downloadImportAutomation: {
    enabled: boolean;
    intervalMs: number;
    retryMs: number;
  };
  defaultSettings: ServiceSettings;
}

export interface ConfigOverrides {
  dataFile?: string;
  tokenSecret?: string;
  downloadSimulationMs?: number;
  downloadImportAutomation?: Partial<AppConfig["downloadImportAutomation"]>;
}

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return fallback;
}

export function createConfig(overrides: ConfigOverrides = {}): AppConfig {
  const dataDir = process.env.CLUO_DATA_DIR ?? path.resolve(process.cwd(), "data");
  const defaultDownloadImportAutomation = {
    enabled: booleanFromEnv("CLUO_DOWNLOAD_IMPORT_AUTOMATION_ENABLED", true),
    intervalMs: numberFromEnv("CLUO_DOWNLOAD_IMPORT_AUTOMATION_INTERVAL_MS", 60_000),
    retryMs: numberFromEnv("CLUO_DOWNLOAD_IMPORT_AUTOMATION_RETRY_MS", 120_000)
  };

  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: numberFromEnv("PORT", 3000),
    dataFile: overrides.dataFile ?? path.join(dataDir, "cluo-server.json"),
    tokenSecret:
      overrides.tokenSecret ??
      process.env.CLUO_TOKEN_SECRET ??
      "dev-only-change-me-before-production",
    tokenTtlSeconds: numberFromEnv("CLUO_TOKEN_TTL_SECONDS", 60 * 60 * 24 * 14),
    downloadSimulationMs:
      overrides.downloadSimulationMs ??
      numberFromEnv("CLUO_DOWNLOAD_SIMULATION_MS", 1_000),
    downloadImportAutomation: {
      ...defaultDownloadImportAutomation,
      ...overrides.downloadImportAutomation
    },
    defaultSettings: {
      autoBangumi: {
        baseUrl: process.env.AUTO_BANGUMI_URL ?? null,
        token: process.env.AUTO_BANGUMI_TOKEN ?? null,
        preferredProvider: process.env.AUTO_BANGUMI_PROVIDER ?? "mikan"
      },
      qBittorrent: {
        baseUrl: process.env.QBITTORRENT_URL ?? null,
        username: process.env.QBITTORRENT_USERNAME ?? null,
        password: process.env.QBITTORRENT_PASSWORD ?? null,
        apiKey: process.env.QBITTORRENT_API_KEY ?? null
      },
      jellyfin: {
        baseUrl: process.env.JELLYFIN_URL ?? null,
        token: process.env.JELLYFIN_TOKEN ?? null,
        userId: process.env.JELLYFIN_USER_ID ?? null,
        deviceId: process.env.JELLYFIN_DEVICE_ID ?? "cluo-server-dev"
      },
      playback: {
        preferredProvider: playbackProviderFromEnv(process.env.PLAYBACK_PROVIDER),
        externalPlayerPackage: process.env.PLAYBACK_EXTERNAL_PLAYER_PACKAGE ?? null,
        externalPlayerMimeType: process.env.PLAYBACK_EXTERNAL_PLAYER_MIME_TYPE ?? "video/*"
      }
    }
  };
}

function playbackProviderFromEnv(
  value: string | undefined
): ServiceSettings["playback"]["preferredProvider"] {
  if (
    value === "local-dev" ||
    value === "external-player" ||
    value === "jellyfin" ||
    value === "kodi"
  ) {
    return value;
  }
  return "local-dev";
}
