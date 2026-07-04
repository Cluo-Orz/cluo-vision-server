import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

import { createConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

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

test("BFF proxies AutoBangumi status, rules, RSS, and live downloads", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));

  try {
    await withFakeServer(
      async (request, response) => {
        assert.equal(request.headers.authorization, "Bearer ab-token");
        const body = await readBody(request);

        if (request.url === "/api/v1/status") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: true, version: "9.9.9", first_run: false }));
          return;
        }

        if (request.url === "/api/v1/bangumi/get/all") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify([
              {
                id: 99,
                official_title: "迷宫饭",
                title_raw: "Dungeon Meshi",
                rss_link: "https://example.test/rss",
                filter: "1080p,CHS",
                season: 1
              }
            ])
          );
          return;
        }

        if (request.url === "/api/v1/rss") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify([{ id: 7, name: "Mikan", url: "https://example.test/rss" }]));
          return;
        }

        if (request.url === "/api/v1/rss/subscribe") {
          const payload = JSON.parse(body);
          assert.equal(payload.data.official_title, "迷宫饭");
          assert.equal(payload.rss.parser, "mikan");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: true }));
          return;
        }

        if (request.url === "/api/v1/downloader/torrents") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify([
              {
                hash: "remote-hash-1",
                name: "迷宫饭 S01E01",
                progress: 0.5,
                state: "downloading",
                dlspeed: 4096,
                eta: 120,
                category: "Bangumi"
              }
            ])
          );
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
              autoBangumi: {
                baseUrl,
                token: "ab-token",
                preferredProvider: "mikan"
              }
            }
          });
          assert.equal(settings.statusCode, 200);

          const status = await app.inject({
            method: "GET",
            url: "/api/anime/status",
            headers: auth
          });
          assert.equal(status.statusCode, 200);
          assert.equal(status.json().configured, true);
          assert.equal(status.json().reachable, true);
          assert.equal(status.json().status.version, "9.9.9");

          const rules = await app.inject({
            method: "GET",
            url: "/api/anime/rules",
            headers: auth
          });
          assert.equal(rules.statusCode, 200);
          assert.equal(rules.json().configured, true);
          assert.equal(rules.json().items[0].id, "99");
          assert.equal(rules.json().items[0].title, "迷宫饭");

          const rss = await app.inject({
            method: "GET",
            url: "/api/anime/rss",
            headers: auth
          });
          assert.equal(rss.statusCode, 200);
          assert.equal(rss.json().items[0].name, "Mikan");

          const subscribe = await app.inject({
            method: "POST",
            url: "/api/anime/subscribe",
            headers: auth,
            payload: {
              title: "迷宫饭",
              provider: "mikan",
              rssUrl: "https://example.test/rss",
              autoBangumi: {
                id: 99,
                official_title: "迷宫饭",
                title_raw: "Dungeon Meshi",
                rss_link: "https://example.test/rss",
                filter: "1080p,CHS"
              }
            }
          });
          assert.equal(subscribe.statusCode, 201);
          assert.equal(subscribe.json().subscription.provider, "autobangumi");

          const downloads = await app.inject({
            method: "GET",
            url: "/api/downloads",
            headers: auth
          });
          assert.equal(downloads.statusCode, 200);
          assert.equal(downloads.json().items.length, 1);
          assert.equal(downloads.json().items[0].id, "remote-hash-1");
          assert.equal(downloads.json().items[0].source, "autobangumi");
          assert.equal(downloads.json().items[0].progress, 50);
        } finally {
          await app.close();
        }
      }
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("AutoBangumi subscription stays queued until a remote torrent appears", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));

  try {
    await withFakeServer(
      async (request, response) => {
        await readBody(request);

        if (request.url === "/api/v1/rss/subscribe") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: true }));
          return;
        }

        if (request.url === "/api/v1/downloader/torrents") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify([]));
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
            downloadSimulationMs: 10
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
              autoBangumi: {
                baseUrl,
                token: "ab-token",
                preferredProvider: "mikan"
              }
            }
          });
          assert.equal(settings.statusCode, 200);

          const subscribe = await app.inject({
            method: "POST",
            url: "/api/anime/subscribe",
            headers: auth,
            payload: {
              title: "迷宫饭",
              provider: "mikan",
              rssUrl: "https://example.test/rss",
              autoBangumi: {
                id: 99,
                official_title: "迷宫饭",
                title_raw: "Dungeon Meshi",
                rss_link: "https://example.test/rss"
              }
            }
          });
          assert.equal(subscribe.statusCode, 201);
          assert.equal(subscribe.json().download.source, "autobangumi");
          assert.equal(subscribe.json().download.state, "queued");
          const downloadId = subscribe.json().download.id as string;

          const localComplete = await app.inject({
            method: "POST",
            url: `/api/anime/downloads/${downloadId}/complete`,
            headers: auth
          });
          assert.equal(localComplete.statusCode, 400);

          await setTimeout(30);

          const downloads = await app.inject({
            method: "GET",
            url: "/api/downloads",
            headers: auth
          });
          assert.equal(downloads.statusCode, 200);
          assert.equal(downloads.json().items.length, 1);
          assert.equal(downloads.json().items[0].source, "autobangumi");
          assert.equal(downloads.json().items[0].state, "queued");
          assert.equal(downloads.json().items[0].progress, 0);

          const library = await app.inject({
            method: "GET",
            url: "/api/library/items",
            headers: auth
          });
          assert.equal(library.statusCode, 200);
          assert.equal(library.json().items.length, 0);
        } finally {
          await app.close();
        }
      }
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("qBittorrent task replaces a matching AutoBangumi queued placeholder", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));

  try {
    await withFakeServer(
      async (request, response) => {
        await readBody(request);

        if (request.url === "/api/v1/rss/subscribe") {
          assert.equal(request.headers.authorization, "Bearer ab-token");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: true }));
          return;
        }

        if (request.url === "/api/v1/downloader/torrents") {
          assert.equal(request.headers.authorization, "Bearer ab-token");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify([]));
          return;
        }

        if (request.url === "/api/v2/torrents/info") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify([
              {
                hash: "qb-hash-dungeon",
                name: "[ANi] 迷宫饭 / Dungeon Meshi - 01 [1080P][WEB-DL].mkv",
                progress: 0.42,
                state: "downloading",
                dlspeed: 2048,
                eta: 300,
                category: "anime"
              }
            ])
          );
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
            downloadSimulationMs: 10
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

          await app.inject({
            method: "PATCH",
            url: "/api/settings/services",
            headers: auth,
            payload: {
              autoBangumi: {
                baseUrl,
                token: "ab-token",
                preferredProvider: "mikan"
              },
              qBittorrent: {
                baseUrl
              }
            }
          });

          const subscribe = await app.inject({
            method: "POST",
            url: "/api/anime/subscribe",
            headers: auth,
            payload: {
              title: "迷宫饭",
              provider: "mikan",
              rssUrl: "https://example.test/rss",
              autoBangumi: {
                id: 99,
                official_title: "迷宫饭",
                title_raw: "Dungeon Meshi",
                rss_link: "https://example.test/rss"
              }
            }
          });
          assert.equal(subscribe.statusCode, 201);
          assert.equal(subscribe.json().download.state, "queued");

          const downloads = await app.inject({
            method: "GET",
            url: "/api/downloads",
            headers: auth
          });
          assert.equal(downloads.statusCode, 200);
          assert.equal(downloads.json().items.length, 1);
          assert.equal(downloads.json().items[0].id, "qb-hash-dungeon");
          assert.equal(downloads.json().items[0].source, "qbittorrent");
          assert.equal(downloads.json().items[0].state, "downloading");
          assert.equal(downloads.json().items[0].progress, 42);
        } finally {
          await app.close();
        }
      }
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("failed AutoBangumi subscription creates a local-dev fallback download", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));

  try {
    await withFakeServer(
      async (request, response) => {
        await readBody(request);
        response.writeHead(request.url === "/api/v1/rss/subscribe" ? 500 : 404);
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

          await app.inject({
            method: "PATCH",
            url: "/api/settings/services",
            headers: auth,
            payload: {
              autoBangumi: {
                baseUrl,
                token: "ab-token",
                preferredProvider: "mikan"
              }
            }
          });

          const subscribe = await app.inject({
            method: "POST",
            url: "/api/anime/subscribe",
            headers: auth,
            payload: {
              title: "迷宫饭",
              provider: "mikan",
              rssUrl: "https://example.test/rss"
            }
          });
          assert.equal(subscribe.statusCode, 201);
          assert.equal(subscribe.json().subscription.status, "failed");
          assert.equal(subscribe.json().download.source, "local-dev");
          assert.equal(subscribe.json().download.state, "downloading");

          const complete = await app.inject({
            method: "POST",
            url: `/api/anime/downloads/${subscribe.json().download.id as string}/complete`,
            headers: auth
          });
          assert.equal(complete.statusCode, 200);
          assert.equal(complete.json().mediaItems.length, 1);
        } finally {
          await app.close();
        }
      }
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
