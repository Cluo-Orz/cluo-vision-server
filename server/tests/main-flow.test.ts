import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

test("cluo-server main anime flow", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));

  try {
    const app = await createServer(
      createConfig({
        dataFile: path.join(dataDir, "db.json"),
        tokenSecret: "test-secret",
        downloadSimulationMs: 50
      })
    );

    const register = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        username: "owner",
        password: "correct-horse-battery-staple",
        displayName: "Owner"
      }
    });
    assert.equal(register.statusCode, 201);
    const token = register.json().token as string;
    const auth = { authorization: `Bearer ${token}` };

    const settings = await app.inject({
      method: "PATCH",
      url: "/api/settings/services",
      headers: auth,
      payload: {
        playback: { preferredProvider: "jellyfin" },
        jellyfin: {
          baseUrl: "http://127.0.0.1:8096",
          token: "secret-jellyfin-token",
          userId: "jellyfin-user",
          deviceId: "cluo-test"
        }
      }
    });
    assert.equal(settings.statusCode, 200);
    assert.equal(settings.json().services.jellyfin.tokenConfigured, true);
    assert.equal(settings.json().services.jellyfin.token, undefined);
    assert.equal(settings.json().services.jellyfin.userId, "jellyfin-user");
    assert.equal(settings.json().services.playback.preferredProvider, "jellyfin");

    const providers = await app.inject({
      method: "GET",
      url: "/api/playback/providers",
      headers: auth
    });
    assert.equal(providers.statusCode, 200);
    assert.equal(providers.json().preferredProvider, "jellyfin");
    assert.equal(
      providers.json().items.find((item: { id: string }) => item.id === "jellyfin").available,
      true
    );
    assert.equal(
      providers.json().items.find((item: { id: string }) => item.id === "external-player").available,
      true
    );

    const search = await app.inject({
      method: "GET",
      url: "/api/anime/search?q=%E8%BF%B7%E5%AE%AB",
      headers: auth
    });
    assert.equal(search.statusCode, 200);
    assert.match(search.json().results[0].title, /迷宫/);

    const result = search.json().results[0];
    const subscribe = await app.inject({
      method: "POST",
      url: "/api/anime/subscribe",
      headers: auth,
      payload: {
        title: result.title,
        provider: result.provider,
        rssUrl: result.rssUrl
      }
    });
    assert.equal(subscribe.statusCode, 201);
    const downloadId = subscribe.json().download.id as string;

    const complete = await app.inject({
      method: "POST",
      url: `/api/anime/downloads/${downloadId}/complete`,
      headers: auth
    });
    assert.equal(complete.statusCode, 200);
    assert.equal(complete.json().mediaItems.length, 1);
    assert.equal(complete.json().mediaItems[0].downloadTaskId, downloadId);

    const library = await app.inject({
      method: "GET",
      url: "/api/library/items",
      headers: auth
    });
    assert.equal(library.statusCode, 200);
    assert.equal(library.json().items.length, 1);
    const media = library.json().items[0];

    const playback = await app.inject({
      method: "POST",
      url: "/api/playback/sessions",
      headers: auth,
      payload: { itemId: media.id }
    });
    assert.equal(playback.statusCode, 201);
    assert.equal(playback.json().session.mode, "mock-stream");
    const sessionId = playback.json().session.id as string;

    const heartbeat = await app.inject({
      method: "PATCH",
      url: `/api/playback/sessions/${sessionId}`,
      headers: auth,
      payload: {
        positionSeconds: 600,
        state: "playing"
      }
    });
    assert.equal(heartbeat.statusCode, 200);
    assert.ok(Math.abs(heartbeat.json().session.progress - 600 / 1440) < 0.001);

    const progressDetail = await app.inject({
      method: "GET",
      url: `/api/library/items/${encodeURIComponent(media.id)}`,
      headers: auth
    });
    assert.equal(progressDetail.statusCode, 200);
    assert.equal(progressDetail.json().item.playbackPositionSeconds, 600);
    assert.equal(progressDetail.json().item.watched, undefined);

    const continueItems = await app.inject({
      method: "GET",
      url: "/api/library/items?status=continue",
      headers: auth
    });
    assert.equal(continueItems.statusCode, 200);
    assert.equal(continueItems.json().items.length, 1);
    assert.equal(continueItems.json().items[0].id, media.id);

    const history = await app.inject({
      method: "GET",
      url: "/api/history",
      headers: auth
    });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().items.length, 1);
    assert.ok(Math.abs(history.json().items[0].progress - 600 / 1440) < 0.001);
    assert.equal(history.json().items[0].playCount, 1);

    const resumePlayback = await app.inject({
      method: "POST",
      url: "/api/playback/sessions",
      headers: auth,
      payload: { itemId: media.id }
    });
    assert.equal(resumePlayback.statusCode, 201);
    assert.equal(resumePlayback.json().session.positionSeconds, 600);
    assert.ok(Math.abs(resumePlayback.json().session.progress - 600 / 1440) < 0.001);

    const stoppedPlayback = await app.inject({
      method: "POST",
      url: `/api/playback/sessions/${resumePlayback.json().session.id as string}/stop`,
      headers: auth,
      payload: {
        positionSeconds: 700
      }
    });
    assert.equal(stoppedPlayback.statusCode, 200);
    assert.equal(stoppedPlayback.json().session.state, "stopped");
    assert.equal(stoppedPlayback.json().session.positionSeconds, 700);

    const completePlayback = await app.inject({
      method: "PATCH",
      url: `/api/playback/sessions/${sessionId}`,
      headers: auth,
      payload: {
        positionSeconds: 1300
      }
    });
    assert.equal(completePlayback.statusCode, 200);
    assert.equal(completePlayback.json().session.state, "completed");

    const completedDetail = await app.inject({
      method: "GET",
      url: `/api/library/items/${encodeURIComponent(media.id)}`,
      headers: auth
    });
    assert.equal(completedDetail.statusCode, 200);
    assert.equal(completedDetail.json().item.playbackPositionSeconds, 1440);
    assert.equal(completedDetail.json().item.watched, true);

    const watchedItems = await app.inject({
      method: "GET",
      url: "/api/library/items?status=watched",
      headers: auth
    });
    assert.equal(watchedItems.statusCode, 200);
    assert.equal(watchedItems.json().items.length, 1);
    assert.equal(watchedItems.json().items[0].id, media.id);

    const watchedSearch = await app.inject({
      method: "GET",
      url: "/api/library/search?q=%E8%BF%B7%E5%AE%AB&status=watched",
      headers: auth
    });
    assert.equal(watchedSearch.statusCode, 200);
    assert.equal(watchedSearch.json().items.length, 1);
    assert.equal(watchedSearch.json().items[0].id, media.id);

    const favorite = await app.inject({
      method: "POST",
      url: `/api/library/items/${encodeURIComponent(media.id)}/favorite`,
      headers: auth,
      payload: { favorite: true }
    });
    assert.equal(favorite.statusCode, 200);
    assert.equal(favorite.json().item.favorite, true);

    const favoriteItems = await app.inject({
      method: "GET",
      url: "/api/library/items?status=favorite",
      headers: auth
    });
    assert.equal(favoriteItems.statusCode, 200);
    assert.equal(favoriteItems.json().items.length, 1);
    assert.equal(favoriteItems.json().items[0].id, media.id);

    const secondSubscribe = await app.inject({
      method: "POST",
      url: "/api/anime/subscribe",
      headers: auth,
      payload: {
        title: "葬送的芙莉莲",
        provider: "local-dev",
        rssUrl: "mock://rss/frieren"
      }
    });
    assert.equal(secondSubscribe.statusCode, 201);

    const secondComplete = await app.inject({
      method: "POST",
      url: `/api/anime/downloads/${secondSubscribe.json().download.id as string}/complete`,
      headers: auth
    });
    assert.equal(secondComplete.statusCode, 200);
    const secondMedia = secondComplete.json().mediaItems[0];

    const unwatchedItems = await app.inject({
      method: "GET",
      url: "/api/library/items?status=unwatched",
      headers: auth
    });
    assert.equal(unwatchedItems.statusCode, 200);
    assert.equal(unwatchedItems.json().items.length, 1);
    assert.equal(unwatchedItems.json().items[0].id, secondMedia.id);

    const related = await app.inject({
      method: "GET",
      url: `/api/library/items/${encodeURIComponent(media.id)}/related`,
      headers: auth
    });
    assert.equal(related.statusCode, 200);
    assert.equal(related.json().item.id, media.id);
    assert.equal(related.json().items.length, 1);
    assert.match(related.json().items[0].title, /芙莉莲/);

    const home = await app.inject({
      method: "GET",
      url: "/api/home",
      headers: auth
    });
    assert.equal(home.statusCode, 200);
    assert.equal(home.json().continueWatching.length, 1);

    await app.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
