import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { AutoBangumiClient } from "../src/services/autoBangumiClient.js";

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

test("AutoBangumiClient searches with the current SSE API", async () => {
  await withFakeServer(
    (request, response) => {
      assert.equal(request.url, "/api/v1/search/bangumi?site=mikan&keywords=%E8%BF%B7%E5%AE%AB");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: 7,
          official_title: "迷宫饭",
          title_raw: "Dungeon Meshi",
          rss_link: "https://mikanani.me/RSS/Bangumi?bangumiId=3022",
          poster_link: "https://example.test/poster.jpg",
          filter: "720,\\d+-\\d+"
        })}\n\n`
      );
    },
    async (baseUrl) => {
      const client = new AutoBangumiClient({ baseUrl, token: "token" });
      const results = await client.searchBangumi("迷宫", "mikan");
      assert.equal(results.length, 1);
      assert.equal(results[0].title, "迷宫饭");
      assert.equal(results[0].originalTitle, "Dungeon Meshi");
      assert.equal(results[0].rssUrl, "https://mikanani.me/RSS/Bangumi?bangumiId=3022");
      assert.equal((results[0].raw as { id: number }).id, 7);
    }
  );
});

test("AutoBangumiClient subscribes with data and rss body", async () => {
  await withFakeServer(
    async (request, response) => {
      assert.equal(request.url, "/api/v1/rss/subscribe");
      assert.equal(request.headers.authorization, "Bearer token");

      const body = await new Promise<string>((resolve) => {
        let value = "";
        request.on("data", (chunk) => {
          value += chunk;
        });
        request.on("end", () => resolve(value));
      });
      const payload = JSON.parse(body);
      assert.equal(payload.data.official_title, "迷宫饭");
      assert.equal(payload.data.filter, "1080p,CHS");
      assert.equal(payload.data.rss_link, "https://example.test/rss");
      assert.equal(payload.rss.url, "https://example.test/rss");
      assert.equal(payload.rss.parser, "mikan");

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: true }));
    },
    async (baseUrl) => {
      const client = new AutoBangumiClient({ baseUrl, token: "token" });
      await client.subscribeBangumi({
        bangumi: {
          id: 1,
          official_title: "迷宫饭",
          title_raw: "Dungeon Meshi",
          filter: ["1080p", "CHS"],
          rss_link: ["https://example.test/rss"]
        },
        rssUrl: "https://example.test/rss",
        rssName: "迷宫饭",
        parser: "mikan"
      });
    }
  );
});

test("AutoBangumiClient lists rules, RSS feeds, and downloader torrents", async () => {
  await withFakeServer(
    (request, response) => {
      assert.equal(request.headers.authorization, "Bearer token");

      if (request.url === "/api/v1/bangumi/get/all") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify([
            {
              id: 12,
              official_title: "迷宫饭",
              title_raw: "Dungeon Meshi",
              rss_link: "https://example.test/rss,https://example.test/rss2",
              filter: "1080p,CHS",
              season: 1,
              episode_offset: 0,
              season_offset: 0,
              archived: false,
              needs_review: true
            }
          ])
        );
        return;
      }

      if (request.url === "/api/v1/rss") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{ id: 1, name: "Mikan", url: "https://example.test/rss" }]));
        return;
      }

      if (request.url === "/api/v1/downloader/torrents") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify([
            {
              hash: "hash-1",
              name: "迷宫饭 S01E01",
              progress: 0.42,
              state: "downloading",
              dlspeed: 2048,
              eta: 300,
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
      const client = new AutoBangumiClient({ baseUrl, token: "token" });

      const rules = await client.listBangumiRules();
      assert.equal(rules.length, 1);
      assert.equal(rules[0].id, "12");
      assert.equal(rules[0].title, "迷宫饭");
      assert.deepEqual(rules[0].rssUrls, ["https://example.test/rss", "https://example.test/rss2"]);
      assert.equal(rules[0].needsReview, true);

      const rss = await client.listRss();
      assert.equal(rss.length, 1);

      const torrents = await client.listTorrents();
      assert.equal(torrents.length, 1);
      assert.equal(torrents[0].id, "hash-1");
      assert.equal(torrents[0].progress, 42);
      assert.equal(torrents[0].speedBytesPerSecond, 2048);
      assert.equal(torrents[0].etaSeconds, 300);
    }
  );
});
