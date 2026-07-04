import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { createConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

type JsonObject = Record<string, unknown>;

interface FakeDownloadState {
  subscribed: boolean;
  progress: number;
  state: "downloading" | "pausedDL" | "uploading";
  qBittorrentControls: string[];
  jellyfinRefreshes: number;
  playbackReports: string[];
}

class SmokeClient {
  token: string | null = null;

  constructor(private readonly baseUrl: string) {}

  get(pathname: string, expectedStatus = 200): Promise<JsonObject> {
    return this.request("GET", pathname, undefined, expectedStatus);
  }

  post(pathname: string, payload?: unknown, expectedStatus = 200): Promise<JsonObject> {
    return this.request("POST", pathname, payload, expectedStatus);
  }

  patch(pathname: string, payload?: unknown, expectedStatus = 200): Promise<JsonObject> {
    return this.request("PATCH", pathname, payload, expectedStatus);
  }

  private async request(
    method: "GET" | "POST" | "PATCH",
    pathname: string,
    payload: unknown,
    expectedStatus: number
  ): Promise<JsonObject> {
    const headers: Record<string, string> = {
      accept: "application/json"
    };
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }

    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });
    const text = await response.text();
    const body = text ? (JSON.parse(text) as unknown) : {};
    assert.equal(
      response.status,
      expectedStatus,
      `${method} ${pathname} returned ${response.status}: ${text}`
    );
    return asObject(body, `${method} ${pathname} response`);
  }
}

async function main() {
  const fakeState: FakeDownloadState = {
    subscribed: false,
    progress: 0.42,
    state: "downloading",
    qBittorrentControls: [],
    jellyfinRefreshes: 0,
    playbackReports: []
  };

  const fakeAutoBangumi = await startFakeServer((request, response) =>
    handleAutoBangumi(request, response, fakeState)
  );
  const fakeQBittorrent = await startFakeServer((request, response) =>
    handleQBittorrent(request, response, fakeState)
  );
  const fakeJellyfin = await startFakeServer((request, response) =>
    handleJellyfin(request, response, fakeState)
  );
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-download-chain-smoke-"));
  const app = await createServer(
    createConfig({
      dataFile: path.join(dataDir, "db.json"),
      tokenSecret: "download-chain-smoke-secret",
      downloadImportAutomation: { enabled: false }
    })
  );

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve cluo-server smoke address");
    }

    const client = new SmokeClient(`http://127.0.0.1:${(address as AddressInfo).port}`);
    const username = `owner-${Date.now()}`;
    const password = "correct-horse-battery-staple";

    const register = await client.post(
      "/api/auth/register",
      { username, password, displayName: "Owner" },
      201
    );
    assert.equal(asObject(register.user, "register.user").username, username);

    const login = await client.post("/api/auth/login", { username, password });
    client.token = stringValue(login.token, "login.token");

    const settings = await client.patch("/api/settings/services", {
      autoBangumi: {
        baseUrl: fakeAutoBangumi.baseUrl,
        token: "ab-token",
        preferredProvider: "mikan"
      },
      qBittorrent: {
        baseUrl: fakeQBittorrent.baseUrl,
        apiKey: "qb-token"
      },
      jellyfin: {
        baseUrl: fakeJellyfin.baseUrl,
        token: "jf-token",
        userId: "smoke-user",
        deviceId: "cluo-download-chain-smoke"
      },
      playback: {
        preferredProvider: "jellyfin"
      }
    });
    assert.equal(
      asObject(asObject(settings.services, "settings.services").jellyfin, "settings.services.jellyfin")
        .userId,
      "smoke-user"
    );

    const status = await client.get("/api/system/status");
    assert.equal(status.overall, "degraded");
    assert.equal(healthItem(status, "autobangumi").state, "ready");
    assert.equal(healthItem(status, "qbittorrent").state, "ready");
    assert.equal(healthItem(status, "jellyfin").state, "ready");

    const search = await client.get(`/api/anime/search?q=${encodeURIComponent("迷宫饭")}`);
    const anime = asObject(arrayValue(search.results, "search.results")[0], "search.results[0]");
    assert.equal(anime.provider, "mikan");
    assert.equal(anime.rssUrl, "https://example.test/mikan/dungeon.rss");

    const subscribe = await client.post(
      "/api/anime/subscribe",
      {
        title: anime.title,
        provider: anime.provider,
        rssUrl: anime.rssUrl,
        autoBangumi: anime.raw
      },
      201
    );
    assert.equal(asObject(subscribe.subscription, "subscribe.subscription").provider, "autobangumi");
    assert.equal(fakeState.subscribed, true);

    const activeDownloads = await client.get("/api/downloads");
    const activeDownload = asObject(
      arrayValue(activeDownloads.items, "activeDownloads.items")[0],
      "activeDownloads.items[0]"
    );
    const downloadId = stringValue(activeDownload.id, "activeDownload.id");
    assert.equal(downloadId, "smoke-hash-1");
    assert.equal(activeDownload.source, "autobangumi");
    assert.equal(activeDownload.state, "downloading");

    await client.post(`/api/downloads/${encodeURIComponent(downloadId)}/pause`);
    await client.post(`/api/downloads/${encodeURIComponent(downloadId)}/resume`);
    assert.deepEqual(fakeState.qBittorrentControls, ["stop:smoke-hash-1", "start:smoke-hash-1"]);

    fakeState.progress = 1;
    fakeState.state = "uploading";

    const importRun = await client.post("/api/automation/download-import/run");
    assert.equal(importRun.totalCompleted, 1);
    assert.equal(importRun.attempted, 1);
    assert.equal(importRun.imported, 1);
    assert.equal(importRun.synced, 1);
    assert.equal(fakeState.jellyfinRefreshes, 1);
    const importedResult = asObject(
      arrayValue(importRun.results, "importRun.results")[0],
      "importRun.results[0]"
    );
    const importedItem = asObject(
      arrayValue(importedResult.items, "importRun.results[0].items")[0],
      "importRun.results[0].items[0]"
    );
    assert.equal(importedItem.id, "jellyfin:jf-episode-1");
    assert.equal(importedItem.downloadTaskId, downloadId);

    const library = await client.get("/api/library/items?status=unwatched");
    const media = asObject(arrayValue(library.items, "library.items")[0], "library.items[0]");
    const mediaId = stringValue(media.id, "media.id");
    assert.equal(mediaId, "jellyfin:jf-episode-1");
    assert.equal(media.source, "jellyfin");

    const detail = await client.get(`/api/library/items/${encodeURIComponent(mediaId)}`);
    assert.equal(asObject(detail.item, "detail.item").title, "迷宫饭 - S01E01 - 第 1 话");

    const playback = await client.post("/api/playback/sessions", { itemId: mediaId }, 201);
    const session = asObject(playback.session, "playback.session");
    const sessionId = stringValue(session.id, "playback.session.id");
    assert.equal(session.provider, "jellyfin");
    assert.equal(session.mode, "stream-url");
    assert.match(stringValue(session.url, "playback.session.url"), /\/Videos\/jf-episode-1\/stream\.mkv/);

    await client.patch(`/api/playback/sessions/${encodeURIComponent(sessionId)}`, {
      positionSeconds: 600,
      state: "playing"
    });
    await client.post(`/api/playback/sessions/${encodeURIComponent(sessionId)}/stop`, {
      positionSeconds: 900
    });
    assert.deepEqual(fakeState.playbackReports, [
      "/Sessions/Playing",
      "/Sessions/Playing/Progress",
      "/Sessions/Playing/Stopped"
    ]);

    const history = await client.get("/api/history");
    const historyItem = asObject(arrayValue(history.items, "history.items")[0], "history.items[0]");
    assert.equal(historyItem.itemId, mediaId);
    assert.equal(historyItem.positionSeconds, 900);

    console.log(
      JSON.stringify(
        {
          status: "ok",
          checked: [
            "register-login",
            "service-status",
            "autobangumi-search",
            "autobangumi-subscribe",
            "remote-download-visible",
            "qbittorrent-pause-resume",
            "completed-download-import",
            "jellyfin-library-sync",
            "jellyfin-playback-resolve",
            "jellyfin-playback-report",
            "history"
          ],
          downloadId,
          mediaId,
          fakeServices: {
            autoBangumi: fakeAutoBangumi.baseUrl,
            qBittorrent: fakeQBittorrent.baseUrl,
            jellyfin: fakeJellyfin.baseUrl
          }
        },
        null,
        2
      )
    );
  } finally {
    await app.close();
    await fakeAutoBangumi.close();
    await fakeQBittorrent.close();
    await fakeJellyfin.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function startFakeServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createHttpServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const port = (address as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function handleAutoBangumi(
  request: IncomingMessage,
  response: ServerResponse,
  state: FakeDownloadState
): Promise<void> {
  assert.equal(request.headers.authorization, "Bearer ab-token");
  const url = new URL(request.url ?? "/", "http://fake-autobangumi");

  if (request.method === "GET" && url.pathname === "/api/v1/status") {
    writeJson(response, { status: true, version: "fake-ab-1.0", first_run: false });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/search/bangumi") {
    assert.equal(url.searchParams.get("site"), "mikan");
    assert.match(url.searchParams.get("keywords") ?? "", /迷宫/);
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.end(
      [
        `data: ${JSON.stringify({
          id: 1001,
          official_title: "迷宫饭",
          title_raw: "Dungeon Meshi",
          rss_link: ["https://example.test/mikan/dungeon.rss"],
          poster_link: "https://example.test/dungeon.jpg",
          season: 1,
          filter: "1080p,CHS"
        })}`,
        "data: [DONE]",
        ""
      ].join("\n\n")
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/rss/subscribe") {
    const body = asObject(JSON.parse(await readBody(request)) as unknown, "autobangumi subscribe body");
    const data = asObject(body.data, "autobangumi subscribe data");
    assert.equal(data.official_title, "迷宫饭");
    state.subscribed = true;
    writeJson(response, { status: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/bangumi/get/all") {
    writeJson(response, [
      {
        id: 1001,
        official_title: "迷宫饭",
        title_raw: "Dungeon Meshi",
        rss_link: "https://example.test/mikan/dungeon.rss",
        filter: "1080p,CHS",
        season: 1
      }
    ]);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/rss") {
    writeJson(response, [{ id: 1, name: "Mikan Dungeon", url: "https://example.test/mikan/dungeon.rss" }]);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v1/downloader/torrents") {
    writeJson(response, state.subscribed ? [fakeTorrent(state)] : []);
    return;
  }

  notFound(response, request);
}

async function handleQBittorrent(
  request: IncomingMessage,
  response: ServerResponse,
  state: FakeDownloadState
): Promise<void> {
  assert.equal(request.headers.authorization, "Bearer qb-token");
  const url = new URL(request.url ?? "/", "http://fake-qbittorrent");

  if (request.method === "GET" && url.pathname === "/api/v2/app/version") {
    writeText(response, "v5.0.0");
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v2/torrents/info") {
    writeJson(response, state.subscribed ? [fakeTorrent(state)] : []);
    return;
  }

  if (request.method === "POST" && ["/api/v2/torrents/stop", "/api/v2/torrents/start"].includes(url.pathname)) {
    const body = new URLSearchParams(await readBody(request));
    const hash = body.get("hashes");
    assert.equal(hash, "smoke-hash-1");
    const action = url.pathname.endsWith("/stop") ? "stop" : "start";
    state.qBittorrentControls.push(`${action}:${hash}`);
    state.state = action === "stop" ? "pausedDL" : "downloading";
    writeText(response, "");
    return;
  }

  notFound(response, request);
}

async function handleJellyfin(
  request: IncomingMessage,
  response: ServerResponse,
  state: FakeDownloadState
): Promise<void> {
  assert.equal(request.headers["x-emby-token"], "jf-token");
  const url = new URL(request.url ?? "/", "http://fake-jellyfin");

  if (request.method === "GET" && url.pathname === "/health") {
    writeText(response, "Healthy");
    return;
  }

  if (request.method === "POST" && url.pathname === "/Library/Refresh") {
    state.jellyfinRefreshes += 1;
    writeJson(response, {});
    return;
  }

  if (request.method === "GET" && url.pathname === "/Users/smoke-user/Items") {
    const searchTerm = url.searchParams.get("SearchTerm");
    if (!searchTerm || /迷宫|Dungeon/i.test(searchTerm)) {
      writeJson(response, { Items: [fakeJellyfinEpisode()] });
      return;
    }
    writeJson(response, { Items: [] });
    return;
  }

  if (request.method === "GET" && url.pathname === "/Users/smoke-user/Items/jf-episode-1") {
    writeJson(response, fakeJellyfinEpisode());
    return;
  }

  if (request.method === "POST" && url.pathname === "/Items/jf-episode-1/PlaybackInfo") {
    writeJson(response, {
      PlaySessionId: "jf-play-session-1",
      MediaSources: [
        {
          Id: "jf-media-source-1",
          Container: "mkv",
          Path: "/data/media/anime/迷宫饭/Season 01/迷宫饭 - S01E01.mkv",
          RunTimeTicks: 14_400_000_000,
          ETag: "etag-smoke"
        }
      ]
    });
    return;
  }

  if (
    request.method === "POST" &&
    ["/Sessions/Playing", "/Sessions/Playing/Progress", "/Sessions/Playing/Stopped"].includes(url.pathname)
  ) {
    state.playbackReports.push(url.pathname);
    const body = asObject(JSON.parse(await readBody(request)) as unknown, "jellyfin playback report");
    assert.equal(body.ItemId, "jf-episode-1");
    writeJson(response, {});
    return;
  }

  notFound(response, request);
}

function fakeTorrent(state: FakeDownloadState): JsonObject {
  return {
    hash: "smoke-hash-1",
    name: "[Cluo Smoke] 迷宫饭 / Dungeon Meshi - 01 [1080p][CHS].mkv",
    progress: state.progress,
    state: state.state,
    dlspeed: state.progress >= 1 ? 0 : 4_194_304,
    eta: state.progress >= 1 ? 0 : 180,
    category: "Bangumi",
    added_on: 1_783_200_000,
    completion_on: state.progress >= 1 ? 1_783_200_300 : 0
  };
}

function fakeJellyfinEpisode(): JsonObject {
  return {
    Id: "jf-episode-1",
    Name: "第 1 话",
    Type: "Episode",
    SeriesId: "jf-series-1",
    SeriesName: "迷宫饭",
    Overview: "Smoke-test episode imported after a completed download.",
    Genres: ["Anime", "Adventure"],
    ProductionYear: 2024,
    CommunityRating: 8.7,
    ParentIndexNumber: 1,
    IndexNumber: 1,
    DateCreated: "2026-07-05T00:00:00.000Z",
    RunTimeTicks: 14_400_000_000,
    Path: "/data/media/anime/迷宫饭/Season 01/迷宫饭 - S01E01.mkv",
    ImageTags: { Primary: "primary-tag" },
    MediaSources: [
      {
        Id: "jf-media-source-1",
        Container: "mkv",
        RunTimeTicks: 14_400_000_000,
        ETag: "etag-smoke",
        Path: "/data/media/anime/迷宫饭/Season 01/迷宫饭 - S01E01.mkv"
      }
    ],
    UserData: {
      PlaybackPositionTicks: 0,
      Played: false,
      IsFavorite: false
    }
  };
}

function healthItem(status: JsonObject, id: string): JsonObject {
  const item = arrayValue(status.items, "status.items")
    .map((entry) => asObject(entry, "status.items[]"))
    .find((entry) => entry.id === id);
  assert.ok(item, `Missing health item: ${id}`);
  return item;
}

async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let value = "";
    request.on("data", (chunk) => {
      value += chunk;
    });
    request.on("end", () => resolve(value));
  });
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function writeText(response: ServerResponse, value: string): void {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(value);
}

function notFound(response: ServerResponse, request: IncomingMessage): void {
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: `Unexpected request: ${request.method} ${request.url}` }));
}

function asObject(value: unknown, label: string): JsonObject {
  assert.equal(typeof value, "object", `${label} should be an object`);
  assert.notEqual(value, null, `${label} should not be null`);
  assert.equal(Array.isArray(value), false, `${label} should not be an array`);
  return value as JsonObject;
}

function arrayValue(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} should be a string`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
