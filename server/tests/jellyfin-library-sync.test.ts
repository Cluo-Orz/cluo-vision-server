import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { secondsToTicks } from "../src/services/jellyfinClient.js";

interface CapturedRequest {
  method?: string;
  url: URL;
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

test("BFF syncs Jellyfin episodes into library and starts Jellyfin playback", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));
  const requests: CapturedRequest[] = [];

  try {
    await withFakeServer(
      async (request, response) => {
        const body = await readBody(request);
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        requests.push({ method: request.method, url, body });

        assert.equal(request.headers["x-emby-token"], "jf-token");

        if (url.pathname === "/Library/Refresh") {
          assert.equal(request.method, "POST");
          response.writeHead(204);
          response.end();
          return;
        }

        if (url.pathname === "/Users/jf-user/Items") {
          assert.equal(request.method, "GET");
          assert.equal(url.searchParams.get("Recursive"), "true");
          assert.equal(url.searchParams.get("IncludeItemTypes"), "Episode");
          assert.equal(url.searchParams.get("MediaTypes"), "Video");
          if (url.searchParams.has("SearchTerm")) {
            assert.equal(url.searchParams.get("SearchTerm"), "迷宫");
          }
          assert.match(url.searchParams.get("Limit") ?? "", /^(5|10|50)$/);
          assert.equal(url.searchParams.get("EnableUserData"), "true");

          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              Items: [
                {
                  Id: "jf-ep-1",
                  Name: "热腾腾的炖菜",
                  Type: "Episode",
                  SeriesId: "jf-series-1",
                  SeriesName: "迷宫饭",
                  ParentIndexNumber: 1,
                  IndexNumber: 1,
                  DateCreated: "2026-01-01T00:00:00.000Z",
                  Overview: "地下迷宫里的第一餐。",
                  Genres: ["Adventure", "Fantasy"],
                  ProductionYear: 2024,
                  CommunityRating: 8.8,
                  RunTimeTicks: secondsToTicks(1440),
                  UserData: {
                    PlaybackPositionTicks: secondsToTicks(300),
                    Played: false,
                    IsFavorite: false
                  },
                  ImageTags: {
                    Primary: "poster-tag"
                  },
                  MediaSources: [
                    {
                      Id: "media-source-1",
                      Container: "mkv",
                      RunTimeTicks: secondsToTicks(1440),
                      ETag: "etag-1",
                      Path: "/media/anime/dungeon-meshi/S01E01.mkv"
                    }
                  ]
                }
              ]
            })
          );
          return;
        }

        if (url.pathname === "/UserItems/Resume") {
          assert.equal(request.method, "GET");
          assert.equal(url.searchParams.get("UserId"), "jf-user");
          assert.equal(url.searchParams.get("Limit"), "10");
          assert.equal(url.searchParams.get("MediaTypes"), "Video");
          assert.equal(url.searchParams.get("IncludeItemTypes"), "Episode");
          assert.equal(url.searchParams.get("EnableUserData"), "true");

          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              Items: [
                {
                  Id: "jf-ep-1",
                  Name: "热腾腾的炖菜",
                  Type: "Episode",
                  SeriesId: "jf-series-1",
                  SeriesName: "迷宫饭",
                  ParentIndexNumber: 1,
                  IndexNumber: 1,
                  DateCreated: "2026-01-01T00:00:00.000Z",
                  Overview: "地下迷宫里的第一餐。",
                  Genres: ["Adventure", "Fantasy"],
                  ProductionYear: 2024,
                  CommunityRating: 8.8,
                  RunTimeTicks: secondsToTicks(1440),
                  UserData: {
                    PlaybackPositionTicks: secondsToTicks(600),
                    Played: false,
                    IsFavorite: true
                  },
                  ImageTags: {
                    Primary: "poster-tag"
                  }
                }
              ]
            })
          );
          return;
        }

        if (url.pathname === "/Users/jf-user/Items/jf-ep-1") {
          assert.equal(request.method, "GET");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              Id: "jf-ep-1",
              Name: "热腾腾的炖菜",
              Type: "Episode",
              SeriesId: "jf-series-1",
              SeriesName: "迷宫饭",
              ParentIndexNumber: 1,
              IndexNumber: 1,
              DateCreated: "2026-01-01T00:00:00.000Z",
              Overview: "地下迷宫里的第一餐。",
              Genres: ["Adventure", "Fantasy"],
              ProductionYear: 2024,
              CommunityRating: 8.8,
              RunTimeTicks: secondsToTicks(1440),
              UserData: {
                PlaybackPositionTicks: secondsToTicks(1440),
                Played: true,
                IsFavorite: true
              },
              ImageTags: {
                Primary: "poster-tag"
              }
            })
          );
          return;
        }

        if (
          url.pathname === "/Users/jf-user/PlayedItems/jf-ep-1" ||
          url.pathname === "/Users/jf-user/FavoriteItems/jf-ep-1"
        ) {
          response.writeHead(204);
          response.end();
          return;
        }

        if (url.pathname === "/Items/jf-ep-1/PlaybackInfo") {
          assert.equal(request.method, "POST");
          assert.equal(url.searchParams.get("StartTimeTicks"), "0");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              PlaySessionId: "play-session-1",
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

        if (url.pathname === "/Sessions/Playing") {
          assert.equal(request.method, "POST");
          const payload = JSON.parse(body);
          assert.equal(payload.ItemId, "jf-ep-1");
          assert.equal(payload.MediaSourceId, "media-source-1");
          assert.equal(payload.PlaySessionId, "play-session-1");

          response.writeHead(204);
          response.end();
          return;
        }

        response.writeHead(404);
        response.end();
      },
      async (baseUrl) => {
        const app = await createServer(
          createConfig({
            dataFile: path.join(dataDir, "db.json"),
            tokenSecret: "test-secret",
            downloadSimulationMs: 50
          })
        );

        try {
          const register = await app.inject({
            method: "POST",
            url: "/api/auth/register",
            payload: {
              username: "owner",
              password: "correct-horse-battery-staple",
              displayName: "Owner"
            }
          });
          const auth = { authorization: `Bearer ${register.json().token as string}` };

          const settings = await app.inject({
            method: "PATCH",
            url: "/api/settings/services",
            headers: auth,
            payload: {
              playback: { preferredProvider: "jellyfin" },
              jellyfin: {
                baseUrl,
                token: "jf-token",
                userId: "jf-user",
                deviceId: "cluo-test"
              }
            }
          });
          assert.equal(settings.statusCode, 200);

          const sync = await app.inject({
            method: "POST",
            url: "/api/library/sync/jellyfin",
            headers: auth,
            payload: {
              searchTerm: "迷宫",
              limit: 5,
              scan: true
            }
          });
          assert.equal(sync.statusCode, 200);
          assert.equal(sync.json().scanTriggered, true);
          assert.equal(sync.json().synced, 1);
          const media = sync.json().items[0];
          assert.equal(media.id, "jellyfin:jf-ep-1");
          assert.equal(media.source, "jellyfin");
          assert.equal(media.title, "迷宫饭 - S01E01 - 热腾腾的炖菜");
          assert.equal(media.jellyfin.itemId, "jf-ep-1");
          assert.equal(media.overview, "地下迷宫里的第一餐。");
          assert.equal(media.playbackPositionSeconds, 300);
          assert.match(media.posterUrl, /\/Items\/jf-ep-1\/Images\/Primary/);

          const search = await app.inject({
            method: "GET",
            url: "/api/library/search?q=%E8%BF%B7%E5%AE%AB",
            headers: auth
          });
          assert.equal(search.statusCode, 200);
          assert.equal(search.json().items[0].id, "jellyfin:jf-ep-1");

          const detail = await app.inject({
            method: "GET",
            url: `/api/library/items/${encodeURIComponent(media.id)}`,
            headers: auth
          });
          assert.equal(detail.statusCode, 200);
          assert.equal(detail.json().item.overview, "地下迷宫里的第一餐。");
          assert.equal(detail.json().item.favorite, true);

          const watched = await app.inject({
            method: "POST",
            url: `/api/library/items/${encodeURIComponent(media.id)}/watched`,
            headers: auth,
            payload: { watched: true }
          });
          assert.equal(watched.statusCode, 200);
          assert.equal(watched.json().item.watched, true);

          const favorite = await app.inject({
            method: "POST",
            url: `/api/library/items/${encodeURIComponent(media.id)}/favorite`,
            headers: auth,
            payload: { favorite: true }
          });
          assert.equal(favorite.statusCode, 200);
          assert.equal(favorite.json().item.favorite, true);

          const playback = await app.inject({
            method: "POST",
            url: "/api/playback/sessions",
            headers: auth,
            payload: { itemId: media.id }
          });
          assert.equal(playback.statusCode, 201);
          assert.equal(playback.json().session.provider, "jellyfin");
          assert.equal(playback.json().session.mode, "stream-url");
          assert.equal(playback.json().session.positionSeconds, 0);
          assert.equal(playback.json().session.externalItemId, "jf-ep-1");
          assert.match(playback.json().session.url, /\/Videos\/jf-ep-1\/stream\.mkv/);

          const externalSettings = await app.inject({
            method: "PATCH",
            url: "/api/settings/services",
            headers: auth,
            payload: {
              playback: {
                preferredProvider: "external-player",
                externalPlayerPackage: "is.xyz.mpv",
                externalPlayerMimeType: "video/*"
              }
            }
          });
          assert.equal(externalSettings.statusCode, 200);

          const externalPlayback = await app.inject({
            method: "POST",
            url: "/api/playback/sessions",
            headers: auth,
            payload: { itemId: media.id }
          });
          assert.equal(externalPlayback.statusCode, 201);
          const externalSession = externalPlayback.json().session;
          assert.equal(externalSession.provider, "external-player");
          assert.equal(externalSession.mode, "intent");
          assert.equal(externalSession.positionSeconds, 0);
          assert.equal(externalSession.externalItemId, "jf-ep-1");
          assert.equal(externalSession.reportProvider, "jellyfin");
          assert.equal(externalSession.intent.action, "android.intent.action.VIEW");
          assert.equal(externalSession.intent.type, "video/*");
          assert.equal(externalSession.intent.packageName, "is.xyz.mpv");
          assert.equal(externalSession.intent.data, externalSession.url);
          assert.match(externalSession.intent.uri, /^intent:\/\/127\.0\.0\.1:\d+\/Videos\/jf-ep-1\/stream\.mkv/);
          assert.match(externalSession.intent.uri, /action=android\.intent\.action\.VIEW/);
          assert.match(externalSession.intent.uri, /type=video%2F\*/);
          assert.match(externalSession.intent.uri, /package=is\.xyz\.mpv/);

          const home = await app.inject({
            method: "GET",
            url: "/api/home",
            headers: auth
          });
          assert.equal(home.statusCode, 200);
          assert.equal(home.json().continueWatching[0].itemId, "jellyfin:jf-ep-1");
          assert.equal(home.json().continueWatching[0].source, "jellyfin");
          assert.ok(Math.abs(home.json().continueWatching[0].progress - 600 / 1440) < 0.001);
          assert.equal(home.json().recentlyAdded[0].id, "jellyfin:jf-ep-1");
        } finally {
          await app.close();
        }
      }
    );

    const paths = requests.map((item) => item.url.pathname);
    assert.equal(paths.slice(0, 12).join(","), [
      "/Library/Refresh",
      "/Users/jf-user/Items",
      "/Users/jf-user/Items",
      "/Users/jf-user/Items/jf-ep-1",
      "/Users/jf-user/PlayedItems/jf-ep-1",
      "/Users/jf-user/Items/jf-ep-1",
      "/Users/jf-user/FavoriteItems/jf-ep-1",
      "/Users/jf-user/Items/jf-ep-1",
      "/Items/jf-ep-1/PlaybackInfo",
      "/Sessions/Playing",
      "/Items/jf-ep-1/PlaybackInfo",
      "/Sessions/Playing"
    ].join(","));
    assert.deepEqual(paths.slice(12).sort(), ["/UserItems/Resume", "/Users/jf-user/Items"].sort());
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
