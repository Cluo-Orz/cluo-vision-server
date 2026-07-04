import { createConfig } from "../src/config.js";
import { loadEnvFiles } from "../src/env.js";
import { AutoBangumiClient } from "../src/services/autoBangumiClient.js";
import { JellyfinClient } from "../src/services/jellyfinClient.js";
import { QBittorrentClient } from "../src/services/qBittorrentClient.js";

type CheckState = "passed" | "skipped" | "failed";

interface CheckResult {
  id: string;
  state: CheckState;
  message: string;
  details?: Record<string, unknown>;
}

async function main() {
  const env = loadEnvFiles();
  const config = createConfig();
  const serviceChecks = await Promise.all([
    checkAutoBangumi(config.defaultSettings.autoBangumi),
    checkQBittorrent(config.defaultSettings.qBittorrent),
    checkJellyfin(config.defaultSettings.jellyfin)
  ]);
  const checks = [
    ...serviceChecks,
    checkDownloadImportAutomation(config.downloadImportAutomation)
  ];

  const configured = serviceChecks.filter((item) => item.state !== "skipped");
  const failed = checks.filter((item) => item.state === "failed");
  const requireConfigured = process.env.CLUO_REAL_SMOKE_REQUIRE === "1";
  const noConfiguredFailure =
    requireConfigured && configured.length === 0
      ? [
          {
            id: "configuration",
            state: "failed" as const,
            message:
              "No real services are configured. Set AUTO_BANGUMI_URL, QBITTORRENT_URL, or JELLYFIN_URL."
          }
        ]
      : [];
  const allFailed = [...failed, ...noConfiguredFailure];

  const summary = {
    status: allFailed.length > 0 ? "failed" : "ok",
    checkedAt: new Date().toISOString(),
    envFiles: env.loaded,
    checks: [...checks, ...noConfiguredFailure]
  };

  console.log(JSON.stringify(summary, null, 2));
  if (allFailed.length > 0) {
    process.exitCode = 1;
  }
}

async function checkAutoBangumi(settings: {
  baseUrl: string | null;
  token: string | null;
  preferredProvider: string;
}): Promise<CheckResult> {
  if (!settings.baseUrl) {
    return skipped("autobangumi", "AUTO_BANGUMI_URL is not configured.");
  }

  const query = process.env.CLUO_SMOKE_ANIME_QUERY ?? "迷宫饭";
  const provider = settings.preferredProvider || "mikan";
  const client = new AutoBangumiClient({
    baseUrl: settings.baseUrl,
    token: settings.token
  });

  try {
    const [status, search, rules, rss, torrents] = await Promise.all([
      client.status(),
      client.searchBangumi(query, provider),
      client.listBangumiRules(),
      client.listRss(),
      client.listTorrents()
    ]);

    return passed("autobangumi", "AutoBangumi is reachable.", {
      baseUrl: settings.baseUrl,
      provider,
      query,
      statusType: typeof status,
      searchResults: search.length,
      rules: rules.length,
      rssFeeds: rss.length,
      torrents: torrents.length
    });
  } catch (error) {
    return failed("autobangumi", error);
  }
}

async function checkQBittorrent(settings: {
  baseUrl: string | null;
  username: string | null;
  password: string | null;
  apiKey: string | null;
}): Promise<CheckResult> {
  if (!settings.baseUrl) {
    return skipped("qbittorrent", "QBITTORRENT_URL is not configured.");
  }
  if (!settings.apiKey && (!settings.username || !settings.password)) {
    return failed(
      "qbittorrent",
      "QBITTORRENT_URL is configured, but QBITTORRENT_USERNAME/PASSWORD or QBITTORRENT_API_KEY is missing."
    );
  }

  const client = new QBittorrentClient({
    baseUrl: settings.baseUrl,
    username: settings.username,
    password: settings.password,
    apiKey: settings.apiKey
  });

  try {
    const [version, torrents] = await Promise.all([client.version(), client.listTorrents()]);
    return passed("qbittorrent", "qBittorrent is reachable.", {
      baseUrl: settings.baseUrl,
      authMode: settings.apiKey ? "api-key" : "username-password",
      version,
      torrents: torrents.length
    });
  } catch (error) {
    return failed("qbittorrent", error);
  }
}

async function checkJellyfin(settings: {
  baseUrl: string | null;
  token: string | null;
  userId: string | null;
  deviceId: string;
}): Promise<CheckResult> {
  if (!settings.baseUrl) {
    return skipped("jellyfin", "JELLYFIN_URL is not configured.");
  }

  const username = process.env.JELLYFIN_USERNAME ?? null;
  const password = process.env.JELLYFIN_PASSWORD ?? null;
  const searchTerm = process.env.CLUO_SMOKE_JELLYFIN_SEARCH ?? "迷宫";
  let token = settings.token;
  let userId = settings.userId;
  let authMode = "token";

  try {
    if (!token && username && password) {
      const auth = await JellyfinClient.authenticateByName({
        baseUrl: settings.baseUrl,
        username,
        password,
        deviceId: settings.deviceId
      });
      token = auth.accessToken;
      userId = auth.user.id;
      authMode = "username-password";
    }

    if (!token) {
      return failed(
        "jellyfin",
        "JELLYFIN_URL is configured, but JELLYFIN_TOKEN or JELLYFIN_USERNAME/PASSWORD is missing."
      );
    }

    const client = new JellyfinClient({
      baseUrl: settings.baseUrl,
      token,
      userId,
      deviceId: settings.deviceId
    });
    await client.health();
    const [episodes, resume] = await Promise.all([
      client.listEpisodes({ searchTerm, limit: 10 }),
      client.listResumeItems({ limit: 10 })
    ]);

    return passed("jellyfin", "Jellyfin is reachable.", {
      baseUrl: settings.baseUrl,
      authMode,
      userIdConfigured: Boolean(userId),
      searchTerm,
      episodes: episodes.length,
      resumeItems: resume.length
    });
  } catch (error) {
    return failed("jellyfin", error);
  }
}

function checkDownloadImportAutomation(settings: {
  enabled: boolean;
  intervalMs: number;
  retryMs: number;
}): CheckResult {
  if (!settings.enabled) {
    return skipped(
      "download-automation",
      "Download import automation is disabled by CLUO_DOWNLOAD_IMPORT_AUTOMATION_ENABLED."
    );
  }

  if (settings.intervalMs <= 0 || settings.retryMs < 0) {
    return failed(
      "download-automation",
      "CLUO_DOWNLOAD_IMPORT_AUTOMATION_INTERVAL_MS must be > 0 and CLUO_DOWNLOAD_IMPORT_AUTOMATION_RETRY_MS must be >= 0."
    );
  }

  return passed("download-automation", "Download import automation configuration is valid.", {
    enabled: settings.enabled,
    intervalMs: settings.intervalMs,
    retryMs: settings.retryMs
  });
}

function skipped(id: string, message: string): CheckResult {
  return { id, state: "skipped", message };
}

function passed(id: string, message: string, details: Record<string, unknown>): CheckResult {
  return { id, state: "passed", message, details };
}

function failed(id: string, error: unknown): CheckResult {
  return {
    id,
    state: "failed",
    message: error instanceof Error ? error.message : String(error)
  };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
