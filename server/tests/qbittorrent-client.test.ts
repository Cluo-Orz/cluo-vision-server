import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { QBittorrentClient } from "../src/services/qBittorrentClient.js";

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

test("QBittorrentClient lists torrents and controls v5 endpoints", async () => {
  const requests: CapturedRequest[] = [];

  await withFakeServer(
    async (request, response) => {
      const body = await readBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push({ method: request.method, url, headers: request.headers, body });

      if (url.pathname === "/api/v2/auth/login") {
        assert.equal(body, "username=admin&password=secret");
        response.writeHead(200, { "set-cookie": "SID=qbit-session; HttpOnly" });
        response.end("Ok.");
        return;
      }

      assert.equal(request.headers.cookie, "SID=qbit-session");

      if (url.pathname === "/api/v2/torrents/info") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify([
            {
              hash: "hash-1",
              name: "迷宫饭 S01E01",
              progress: 0.42,
              state: "downloading",
              dlspeed: 8192,
              eta: 300,
              category: "anime",
              added_on: 1780000000
            }
          ])
        );
        return;
      }

      if (url.pathname === "/api/v2/torrents/stop" || url.pathname === "/api/v2/torrents/start") {
        assert.equal(body, "hashes=hash-1");
        response.writeHead(200);
        response.end();
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      const client = new QBittorrentClient({
        baseUrl,
        username: "admin",
        password: "secret",
        apiKey: null
      });

      const torrents = await client.listTorrents();
      assert.equal(torrents.length, 1);
      assert.equal(torrents[0].id, "hash-1");
      assert.equal(torrents[0].source, "qbittorrent");
      assert.equal(torrents[0].progress, 42);
      assert.equal(torrents[0].speedBytesPerSecond, 8192);

      await client.pause("hash-1");
      await client.resume("hash-1");
    }
  );

  assert.deepEqual(
    requests.map((item) => item.url.pathname),
    [
      "/api/v2/auth/login",
      "/api/v2/torrents/info",
      "/api/v2/auth/login",
      "/api/v2/torrents/stop",
      "/api/v2/auth/login",
      "/api/v2/torrents/start"
    ]
  );
});

test("QBittorrentClient falls back to v4 pause and resume endpoints", async () => {
  const requests: CapturedRequest[] = [];

  await withFakeServer(
    async (request, response) => {
      const body = await readBody(request);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push({ method: request.method, url, headers: request.headers, body });

      assert.equal(request.headers.authorization, "Bearer qbt_1234567890123456789012345678");

      if (url.pathname === "/api/v2/torrents/stop" || url.pathname === "/api/v2/torrents/start") {
        response.writeHead(404);
        response.end("not found");
        return;
      }

      if (url.pathname === "/api/v2/torrents/pause" || url.pathname === "/api/v2/torrents/resume") {
        assert.equal(body, "hashes=hash-2");
        response.writeHead(200);
        response.end();
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      const client = new QBittorrentClient({
        baseUrl,
        username: null,
        password: null,
        apiKey: "qbt_1234567890123456789012345678"
      });

      await client.pause("hash-2");
      await client.resume("hash-2");
    }
  );

  assert.deepEqual(
    requests.map((item) => item.url.pathname),
    [
      "/api/v2/torrents/stop",
      "/api/v2/torrents/pause",
      "/api/v2/torrents/start",
      "/api/v2/torrents/resume"
    ]
  );
});

test("QBittorrentClient accepts qBittorrent 5.2 login 204 responses", async () => {
  await withFakeServer(
    async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (url.pathname === "/api/v2/auth/login") {
        response.writeHead(204, { "set-cookie": "SID=qbit-session; HttpOnly" });
        response.end();
        return;
      }

      assert.equal(request.headers.cookie, "SID=qbit-session");

      if (url.pathname === "/api/v2/app/version") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("5.2.2");
        return;
      }

      response.writeHead(404);
      response.end();
    },
    async (baseUrl) => {
      const client = new QBittorrentClient({
        baseUrl,
        username: "admin",
        password: "secret",
        apiKey: null
      });

      assert.equal(await client.version(), "5.2.2");
    }
  );
});
