import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { createConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

type JsonObject = Record<string, unknown>;

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
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-main-smoke-"));
  const app = await createServer(
    createConfig({
      dataFile: path.join(dataDir, "db.json"),
      tokenSecret: "main-smoke-secret",
      downloadSimulationMs: 50
    })
  );

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve smoke server address");
    }

    const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
    const client = new SmokeClient(baseUrl);
    const username = `owner-${Date.now()}`;
    const password = "correct-horse-battery-staple";

    const health = await client.get("/api/health");
    assert.equal(health.status, "ok");
    assert.deepEqual(asObject(health.services, "health.services").playback, "local-dev");

    const register = await client.post(
      "/api/auth/register",
      {
        username,
        password,
        displayName: "Owner"
      },
      201
    );
    assert.equal(asObject(register.user, "register.user").username, username);
    assert.equal(typeof register.token, "string");

    const login = await client.post("/api/auth/login", { username, password });
    client.token = stringValue(login.token, "login.token");

    const me = await client.get("/api/auth/me");
    assert.equal(asObject(me.user, "me.user").username, username);

    const discover = await client.get(`/api/discover/search?q=${encodeURIComponent("迷宫")}`);
    const animeResults = arrayValue(discover.anime, "discover.anime");
    assert.ok(animeResults.length > 0, "discover search should return anime results");
    const firstAnime = asObject(animeResults[0], "discover.anime[0]");
    assert.match(stringValue(firstAnime.title, "discover.anime[0].title"), /迷宫/);

    const recent = await client.get("/api/discover/recent");
    assert.equal(asObject(arrayValue(recent.items, "recent.items")[0], "recent.items[0]").query, "迷宫");

    const subscribe = await client.post(
      "/api/anime/subscribe",
      {
        title: stringValue(firstAnime.title, "anime.title"),
        provider: stringValue(firstAnime.provider, "anime.provider"),
        rssUrl: firstAnime.rssUrl
      },
      201
    );
    const download = asObject(subscribe.download, "subscribe.download");
    const downloadId = stringValue(download.id, "subscribe.download.id");
    assert.equal(download.source, "local-dev");

    const paused = await client.post(`/api/downloads/${encodeURIComponent(downloadId)}/pause`);
    assert.equal(asObject(paused.item, "paused.item").state, "paused");

    const resumed = await client.post(`/api/downloads/${encodeURIComponent(downloadId)}/resume`);
    assert.equal(asObject(resumed.item, "resumed.item").state, "downloading");

    const complete = await client.post(`/api/anime/downloads/${encodeURIComponent(downloadId)}/complete`);
    assert.equal(asObject(complete.item, "complete.item").state, "completed");
    const completedMedia = asObject(arrayValue(complete.mediaItems, "complete.mediaItems")[0], "media[0]");
    const mediaId = stringValue(completedMedia.id, "media.id");

    const imported = await client.post(`/api/downloads/${encodeURIComponent(downloadId)}/import`);
    assert.equal(asObject(arrayValue(imported.items, "import.items")[0], "import.items[0]").id, mediaId);

    const library = await client.get("/api/library/items");
    assert.equal(asObject(arrayValue(library.items, "library.items")[0], "library.items[0]").id, mediaId);

    const playback = await client.post("/api/playback/sessions", { itemId: mediaId }, 201);
    const session = asObject(playback.session, "playback.session");
    assert.equal(session.mode, "mock-stream");
    assert.equal(session.provider, "local-dev");
    const sessionId = stringValue(session.id, "playback.session.id");

    const heartbeat = await client.patch(`/api/playback/sessions/${encodeURIComponent(sessionId)}`, {
      positionSeconds: 600,
      state: "playing"
    });
    assert.ok(numberValue(asObject(heartbeat.session, "heartbeat.session").progress, "progress") > 0.4);

    const history = await client.get("/api/history");
    const historyEntry = asObject(arrayValue(history.items, "history.items")[0], "history.items[0]");
    assert.equal(historyEntry.itemId, mediaId);
    assert.equal(historyEntry.playCount, 1);
    assert.equal(historyEntry.positionSeconds, 600);

    const resumePlayback = await client.post("/api/playback/sessions", { itemId: mediaId }, 201);
    const resumeSession = asObject(resumePlayback.session, "resume.session");
    assert.equal(resumeSession.positionSeconds, 600);

    const stopped = await client.post(
      `/api/playback/sessions/${encodeURIComponent(stringValue(resumeSession.id, "resume.id"))}/stop`,
      { positionSeconds: 700 }
    );
    assert.equal(asObject(stopped.session, "stopped.session").state, "stopped");

    const completed = await client.patch(`/api/playback/sessions/${encodeURIComponent(sessionId)}`, {
      positionSeconds: 1300
    });
    assert.equal(asObject(completed.session, "completed.session").state, "completed");

    const detail = await client.get(`/api/library/items/${encodeURIComponent(mediaId)}`);
    const detailItem = asObject(detail.item, "detail.item");
    assert.equal(detailItem.watched, true);
    assert.equal(detailItem.playbackPositionSeconds, 1440);

    const sessions = await client.get("/api/playback/sessions");
    assert.ok(arrayValue(sessions.items, "sessions.items").length >= 2);

    const home = await client.get("/api/home");
    assert.ok(arrayValue(home.recentlyAdded, "home.recentlyAdded").length >= 1);
    assert.ok(arrayValue(home.continueWatching, "home.continueWatching").length >= 1);

    const finalHealth = await client.get("/api/health");
    assert.equal(finalHealth.status, "ok");
    assert.equal(finalHealth.users, 1);

    console.log(
      JSON.stringify(
        {
          status: "ok",
          baseUrl,
          checked: [
            "register",
            "login",
            "discover",
            "subscribe",
            "download-control",
            "complete",
            "import",
            "library",
            "playback",
            "history",
            "home"
          ],
          mediaId
        },
        null,
        2
      )
    );
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
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

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`${label} should be a number`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
