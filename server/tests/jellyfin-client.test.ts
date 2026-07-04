import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { JellyfinClient, secondsToTicks } from "../src/services/jellyfinClient.js";
import type { MediaItem, PlaybackSession } from "../src/types.js";

interface CapturedRequest {
  method?: string;
  url: URL;
  headers: IncomingMessage["headers"];
  body: string;
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

async function withFakeServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (baseUrl: string) => Promise<void>
) {
  const server = createHttpServer((request, response) => {
    void handler(request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const info = address as AddressInfo;

  try {
    await run(`http://127.0.0.1:${info.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("JellyfinClient authenticates by username and password", async () => {
  const requests: CapturedRequest[] = [];

  await withFakeServer(
    async (request, response) => {
      const body = await readBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push({ method: request.method, url, headers: request.headers, body });

      assert.equal(url.pathname, "/Users/AuthenticateByName");
      assert.equal(request.method, "POST");
      assert.match(String(request.headers.authorization), /MediaBrowser/);
      assert.match(String(request.headers.authorization), /DeviceId="cluo-test"/);
      assert.deepEqual(JSON.parse(body), {
        Username: "owner",
        Pw: "secret"
      });

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          AccessToken: "jf-access-token",
          User: {
            Id: "jf-user",
            Name: "Owner"
          }
        })
      );
    },
    async (baseUrl) => {
      const result = await JellyfinClient.authenticateByName({
        baseUrl,
        username: "owner",
        password: "secret",
        deviceId: "cluo-test"
      });

      assert.equal(result.accessToken, "jf-access-token");
      assert.deepEqual(result.user, {
        id: "jf-user",
        name: "Owner"
      });
    }
  );

  assert.equal(requests.length, 1);
});

test("JellyfinClient resolves playback and reports session progress", async () => {
  const requests: CapturedRequest[] = [];

  await withFakeServer(
    async (request, response) => {
      const body = await readBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push({ method: request.method, url, headers: request.headers, body });

      assert.equal(request.headers["x-emby-token"], "jf-token");
      assert.match(String(request.headers.authorization), /MediaBrowser/);

      if (url.pathname === "/Items/jf-item/PlaybackInfo") {
        assert.equal(request.method, "POST");
        assert.equal(url.searchParams.get("StartTimeTicks"), String(secondsToTicks(12)));
        assert.equal(url.searchParams.get("EnableDirectPlay"), "true");
        assert.equal(url.searchParams.get("EnableDirectStream"), "true");
        assert.equal(url.searchParams.get("EnableTranscoding"), "true");
        assert.equal(url.searchParams.get("UserId"), "jf-user");

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            PlaySessionId: "jf-session",
            MediaSources: [
              {
                Id: "media-source-1",
                Container: "mkv",
                RunTimeTicks: secondsToTicks(1440),
                ETag: "etag-1"
              }
            ]
          })
        );
        return;
      }

      if (url.pathname.startsWith("/Sessions/Playing")) {
        assert.equal(request.method, "POST");
        response.writeHead(204);
        response.end();
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      const client = new JellyfinClient({
        baseUrl,
        token: "jf-token",
        userId: "jf-user",
        deviceId: "cluo-test"
      });
      const item: MediaItem = {
        id: "cluo-item",
        source: "jellyfin",
        type: "anime-episode",
        title: "迷宫饭 - S01E01",
        animeId: "anime-1",
        downloadTaskId: "task-1",
        durationSeconds: 1200,
        createdAt: new Date().toISOString(),
        jellyfin: {
          itemId: "jf-item"
        }
      };

      const target = await client.resolvePlayback(item, 12);
      assert.equal(target.provider, "jellyfin");
      assert.equal(target.mode, "stream-url");
      assert.equal(target.itemId, "cluo-item");
      assert.equal(target.externalItemId, "jf-item");
      assert.equal(target.mediaSourceId, "media-source-1");
      assert.equal(target.externalPlaySessionId, "jf-session");
      assert.equal(target.durationSeconds, 1440);

      const streamUrl = new URL(target.url!);
      assert.equal(streamUrl.pathname, "/Videos/jf-item/stream.mkv");
      assert.equal(streamUrl.searchParams.get("Static"), "true");
      assert.equal(streamUrl.searchParams.get("mediaSourceId"), "media-source-1");
      assert.equal(streamUrl.searchParams.get("playSessionId"), "jf-session");
      assert.equal(streamUrl.searchParams.get("deviceId"), "cluo-test");
      assert.equal(streamUrl.searchParams.get("api_key"), "jf-token");
      assert.equal(streamUrl.searchParams.get("Tag"), "etag-1");

      const session: PlaybackSession = {
        id: "session-1",
        userId: "cluo-user",
        itemId: "cluo-item",
        externalItemId: target.externalItemId,
        title: "迷宫饭 - S01E01",
        type: "anime-episode",
        provider: "jellyfin",
        mode: "stream-url",
        url: target.url,
        mediaSourceId: target.mediaSourceId,
        externalPlaySessionId: target.externalPlaySessionId,
        state: "playing",
        positionSeconds: 24,
        durationSeconds: 1440,
        progress: 24 / 1440,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await client.reportStart(session);
      await client.reportProgress({ ...session, state: "paused", positionSeconds: 48 });
      await client.reportStopped({ ...session, state: "completed", positionSeconds: 1440 });
    }
  );

  assert.equal(requests.length, 4);
  assert.equal(requests[1].url.pathname, "/Sessions/Playing");
  assert.equal(requests[2].url.pathname, "/Sessions/Playing/Progress");
  assert.equal(requests[3].url.pathname, "/Sessions/Playing/Stopped");

  const startedPayload = JSON.parse(requests[1].body);
  assert.equal(startedPayload.ItemId, "jf-item");
  assert.equal(startedPayload.MediaSourceId, "media-source-1");
  assert.equal(startedPayload.PlaySessionId, "jf-session");
  assert.equal(startedPayload.PositionTicks, secondsToTicks(24));

  const pausedPayload = JSON.parse(requests[2].body);
  assert.equal(pausedPayload.IsPaused, true);
  assert.equal(pausedPayload.PositionTicks, secondsToTicks(48));

  const stoppedPayload = JSON.parse(requests[3].body);
  assert.equal(stoppedPayload.PositionTicks, secondsToTicks(1440));
});

test("JellyfinClient triggers a full library refresh", async () => {
  const requests: CapturedRequest[] = [];

  await withFakeServer(
    async (request, response) => {
      const body = await readBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push({ method: request.method, url, headers: request.headers, body });

      assert.equal(request.headers["x-emby-token"], "jf-token");

      if (url.pathname === "/Library/Refresh") {
        assert.equal(request.method, "POST");
        response.writeHead(204);
        response.end();
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      const client = new JellyfinClient({
        baseUrl,
        token: "jf-token",
        userId: "jf-user",
        deviceId: "cluo-test"
      });
      await client.refreshLibrary();
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, "/Library/Refresh");
});

test("JellyfinClient gets item details and updates user item state", async () => {
  const requests: CapturedRequest[] = [];

  await withFakeServer(
    async (request, response) => {
      const body = await readBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push({ method: request.method, url, headers: request.headers, body });

      assert.equal(request.headers["x-emby-token"], "jf-token");

      if (url.pathname === "/Users/jf-user/Items/jf-item") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            Id: "jf-item",
            Name: "热腾腾的炖菜",
            SeriesId: "jf-series",
            SeriesName: "迷宫饭",
            ParentIndexNumber: 1,
            IndexNumber: 1,
            Overview: "一行简介",
            Genres: ["Adventure", "Fantasy"],
            ProductionYear: 2024,
            CommunityRating: 8.8,
            RunTimeTicks: secondsToTicks(1440),
            UserData: {
              PlaybackPositionTicks: secondsToTicks(600),
              Played: false,
              IsFavorite: true
            }
          })
        );
        return;
      }

      if (
        url.pathname === "/Users/jf-user/PlayedItems/jf-item" ||
        url.pathname === "/Users/jf-user/FavoriteItems/jf-item"
      ) {
        response.writeHead(204);
        response.end();
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      const client = new JellyfinClient({
        baseUrl,
        token: "jf-token",
        userId: "jf-user",
        deviceId: "cluo-test"
      });

      const item = await client.getItem("jellyfin:jf-item");
      assert.ok(item);
      assert.equal(item.title, "迷宫饭 - S01E01 - 热腾腾的炖菜");
      assert.equal(item.overview, "一行简介");
      assert.deepEqual(item.genres, ["Adventure", "Fantasy"]);
      assert.equal(item.year, 2024);
      assert.equal(item.communityRating, 8.8);
      assert.equal(item.playbackPositionSeconds, 600);
      assert.equal(item.watched, false);
      assert.equal(item.favorite, true);

      await client.setWatched("jellyfin:jf-item", true);
      await client.setFavorite("jellyfin:jf-item", false);
    }
  );

  assert.equal(requests[0].url.pathname, "/Users/jf-user/Items/jf-item");
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].url.pathname, "/Users/jf-user/PlayedItems/jf-item");
  assert.equal(requests[2].method, "DELETE");
  assert.equal(requests[2].url.pathname, "/Users/jf-user/FavoriteItems/jf-item");
});

test("JellyfinClient lists resume items with user data", async () => {
  const requests: CapturedRequest[] = [];

  await withFakeServer(
    async (request, response) => {
      const body = await readBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push({ method: request.method, url, headers: request.headers, body });

      assert.equal(request.headers["x-emby-token"], "jf-token");

      if (url.pathname === "/UserItems/Resume") {
        assert.equal(request.method, "GET");
        assert.equal(url.searchParams.get("UserId"), "jf-user");
        assert.equal(url.searchParams.get("Limit"), "3");
        assert.equal(url.searchParams.get("MediaTypes"), "Video");
        assert.equal(url.searchParams.get("IncludeItemTypes"), "Episode");
        assert.equal(url.searchParams.get("EnableUserData"), "true");

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            Items: [
              {
                Id: "jf-resume",
                Name: "继续前进",
                SeriesId: "jf-series",
                SeriesName: "迷宫饭",
                ParentIndexNumber: 1,
                IndexNumber: 2,
                DateCreated: "2026-01-02T00:00:00.000Z",
                RunTimeTicks: secondsToTicks(1500),
                UserData: {
                  PlaybackPositionTicks: secondsToTicks(450),
                  Played: false,
                  IsFavorite: true
                }
              }
            ]
          })
        );
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      const client = new JellyfinClient({
        baseUrl,
        token: "jf-token",
        userId: "jf-user",
        deviceId: "cluo-test"
      });

      const items = await client.listResumeItems({ limit: 3 });
      assert.equal(items.length, 1);
      assert.equal(items[0].id, "jellyfin:jf-resume");
      assert.equal(items[0].title, "迷宫饭 - S01E02 - 继续前进");
      assert.equal(items[0].playbackPositionSeconds, 450);
      assert.equal(items[0].watched, false);
      assert.equal(items[0].favorite, true);
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, "/UserItems/Resume");
});
