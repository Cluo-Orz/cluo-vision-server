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
}

async function withFakeServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (baseUrl: string, requests: CapturedRequest[]) => Promise<void>
) {
  const requests: CapturedRequest[] = [];
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ method: request.method, url });
    void handler(request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const info = address as AddressInfo;

  try {
    await run(`http://127.0.0.1:${info.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("BFF imports a completed download by triggering Jellyfin scan and search sync", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));

  try {
    await withFakeServer(
      async (request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");

        assert.equal(request.headers["x-emby-token"], "jf-token");

        if (url.pathname === "/Library/Refresh") {
          assert.equal(request.method, "POST");
          response.writeHead(204);
          response.end();
          return;
        }

        if (url.pathname === "/Users/jf-user/Items") {
          assert.equal(request.method, "GET");
          assert.equal(url.searchParams.get("SearchTerm"), "迷宫饭");
          assert.equal(url.searchParams.get("IncludeItemTypes"), "Episode");

          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              Items: [
                {
                  Id: "jf-ep-imported",
                  Name: "热腾腾的炖菜",
                  Type: "Episode",
                  SeriesId: "jf-series-1",
                  SeriesName: "迷宫饭",
                  ParentIndexNumber: 1,
                  IndexNumber: 1,
                  DateCreated: "2026-01-01T00:00:00.000Z",
                  RunTimeTicks: secondsToTicks(1440),
                  MediaSources: [
                    {
                      Id: "media-source-1",
                      Container: "mkv",
                      RunTimeTicks: secondsToTicks(1440),
                      ETag: "etag-1"
                    }
                  ]
                }
              ]
            })
          );
          return;
        }

        response.writeHead(404);
        response.end();
      },
      async (baseUrl, requests) => {
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
              password: "correct-horse-battery-staple"
            }
          });
          const auth = { authorization: `Bearer ${register.json().token as string}` };

          await app.inject({
            method: "PATCH",
            url: "/api/settings/services",
            headers: auth,
            payload: {
              jellyfin: {
                baseUrl,
                token: "jf-token",
                userId: "jf-user",
                deviceId: "cluo-test"
              }
            }
          });

          const search = await app.inject({
            method: "GET",
            url: "/api/anime/search?q=%E8%BF%B7%E5%AE%AB",
            headers: auth
          });
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
          const downloadId = subscribe.json().download.id as string;

          const complete = await app.inject({
            method: "POST",
            url: `/api/anime/downloads/${downloadId}/complete`,
            headers: auth
          });
          assert.equal(complete.statusCode, 200);

          const imported = await app.inject({
            method: "POST",
            url: `/api/downloads/${downloadId}/import`,
            headers: auth
          });

          assert.equal(imported.statusCode, 200);
          assert.equal(imported.json().configured, true);
          assert.equal(imported.json().scanTriggered, true);
          assert.equal(imported.json().synced, 1);
          assert.equal(imported.json().items[0].id, "jellyfin:jf-ep-imported");
          assert.equal(imported.json().items[0].source, "jellyfin");
          assert.equal(imported.json().items[0].downloadTaskId, downloadId);
        } finally {
          await app.close();
        }

        assert.deepEqual(
          requests.map((item) => item.url.pathname),
          ["/Library/Refresh", "/Users/jf-user/Items"]
        );
      }
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("BFF imports a noisy completed qBittorrent anime name using cleaned search terms", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));
  const noisyTitle =
    "[ANi] 迷宫饭 / Dungeon Meshi - 01 [1080P][WEB-DL][AAC AVC][CHT].mkv";

  try {
    await withFakeServer(
      async (request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");

        if (url.pathname === "/api/v2/torrents/info") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify([
              {
                hash: "remote-hash-import",
                name: noisyTitle,
                progress: 1,
                state: "uploading",
                dlspeed: 0,
                eta: 0,
                category: "anime",
                added_on: 1783200000,
                completion_on: 1783200100
              }
            ])
          );
          return;
        }

        assert.equal(request.headers["x-emby-token"], "jf-token");

        if (url.pathname === "/Library/Refresh") {
          assert.equal(request.method, "POST");
          response.writeHead(204);
          response.end();
          return;
        }

        if (url.pathname === "/Users/jf-user/Items") {
          assert.equal(request.method, "GET");
          assert.equal(url.searchParams.get("IncludeItemTypes"), "Episode");
          const searchTerm = url.searchParams.get("SearchTerm");
          const items =
            searchTerm === "迷宫饭"
              ? [
                  {
                    Id: "jf-ep-noisy-import",
                    Name: "迷宫饭 - 01",
                    Type: "Episode",
                    SeriesId: "jf-series-1",
                    SeriesName: "迷宫饭",
                    ParentIndexNumber: 1,
                    IndexNumber: 1,
                    DateCreated: "2026-01-01T00:00:00.000Z",
                    RunTimeTicks: secondsToTicks(1440),
                    MediaSources: [
                      {
                        Id: "media-source-1",
                        Container: "mkv",
                        RunTimeTicks: secondsToTicks(1440),
                        ETag: "etag-1"
                      }
                    ]
                  }
                ]
              : [];

          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ Items: items }));
          return;
        }

        response.writeHead(404);
        response.end();
      },
      async (baseUrl, requests) => {
        const app = await createServer(
          createConfig({
            dataFile: path.join(dataDir, "db.json"),
            tokenSecret: "test-secret"
          })
        );

        try {
          const register = await app.inject({
            method: "POST",
            url: "/api/auth/register",
            payload: {
              username: "owner",
              password: "correct-horse-battery-staple"
            }
          });
          const auth = { authorization: `Bearer ${register.json().token as string}` };

          await app.inject({
            method: "PATCH",
            url: "/api/settings/services",
            headers: auth,
            payload: {
              qBittorrent: {
                baseUrl
              },
              jellyfin: {
                baseUrl,
                token: "jf-token",
                userId: "jf-user",
                deviceId: "cluo-test"
              }
            }
          });

          const imported = await app.inject({
            method: "POST",
            url: "/api/downloads/remote-hash-import/import",
            headers: auth
          });

          assert.equal(imported.statusCode, 200);
          assert.equal(imported.json().status, "imported");
          assert.equal(imported.json().synced, 1);
          assert.equal(imported.json().items[0].id, "jellyfin:jf-ep-noisy-import");
          assert.equal(imported.json().items[0].downloadTaskId, "remote-hash-import");
          assert.ok(imported.json().searchTerms.includes("迷宫饭"));
          assert.ok(imported.json().searchTerms.includes("Dungeon Meshi"));
        } finally {
          await app.close();
        }

        const searchedTerms = requests
          .filter((item) => item.url.pathname === "/Users/jf-user/Items")
          .map((item) => item.url.searchParams.get("SearchTerm"));
        assert.ok(searchedTerms.includes("迷宫饭"));
      }
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("BFF imports all completed local downloads in one batch", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));
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
        password: "correct-horse-battery-staple"
      }
    });
    const auth = { authorization: `Bearer ${register.json().token as string}` };

    const first = await app.inject({
      method: "POST",
      url: "/api/anime/subscribe",
      headers: auth,
      payload: {
        title: "迷宫饭",
        provider: "local-dev",
        rssUrl: "mock://rss/dungeon"
      }
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/anime/subscribe",
      headers: auth,
      payload: {
        title: "葬送的芙莉莲",
        provider: "local-dev",
        rssUrl: "mock://rss/frieren"
      }
    });

    for (const id of [first.json().download.id, second.json().download.id]) {
      const complete = await app.inject({
        method: "POST",
        url: `/api/anime/downloads/${id as string}/complete`,
        headers: auth
      });
      assert.equal(complete.statusCode, 200);
    }

    const imported = await app.inject({
      method: "POST",
      url: "/api/downloads/import-completed",
      headers: auth
    });

    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().total, 2);
    assert.equal(imported.json().imported, 2);
    assert.equal(imported.json().pending, 0);
    assert.equal(imported.json().failed, 0);
    assert.equal(imported.json().synced, 2);
    assert.equal(imported.json().items.length, 2);
    assert.deepEqual(
      imported.json().results.map((item: { status: string }) => item.status),
      ["local-only", "local-only"]
    );
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
