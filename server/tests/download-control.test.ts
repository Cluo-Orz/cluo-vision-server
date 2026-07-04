import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
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
  run: (baseUrl: string, paths: string[]) => Promise<void>
) {
  const paths: string[] = [];
  const server = createHttpServer((request, response) => {
    paths.push(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    void handler(request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const info = address as AddressInfo;

  try {
    await run(`http://127.0.0.1:${info.port}`, paths);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("BFF pauses and resumes local-dev downloads", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));

  try {
    const app = await createServer(
      createConfig({
        dataFile: path.join(dataDir, "db.json"),
        tokenSecret: "test-secret",
        downloadSimulationMs: 10_000
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

      const subscribe = await app.inject({
        method: "POST",
        url: "/api/anime/subscribe",
        headers: auth,
        payload: {
          title: "迷宫饭",
          provider: "local-dev",
          rssUrl: "mock://rss/dungeon"
        }
      });
      const taskId = subscribe.json().download.id as string;

      const pause = await app.inject({
        method: "POST",
        url: `/api/downloads/${taskId}/pause`,
        headers: auth
      });
      assert.equal(pause.statusCode, 200);
      assert.equal(pause.json().item.state, "paused");

      const resume = await app.inject({
        method: "POST",
        url: `/api/downloads/${taskId}/resume`,
        headers: auth
      });
      assert.equal(resume.statusCode, 200);
      assert.equal(resume.json().item.state, "downloading");
    } finally {
      await app.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("BFF controls qBittorrent downloads through the unified download API", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));

  try {
    await withFakeServer(
      async (request, response) => {
        const body = await readBody(request);
        const url = new URL(request.url ?? "/", "http://127.0.0.1");

        if (url.pathname === "/api/v2/auth/login") {
          response.writeHead(200, { "set-cookie": "SID=control-test" });
          response.end("Ok.");
          return;
        }

        assert.equal(request.headers.cookie, "SID=control-test");

        if (url.pathname === "/api/v2/torrents/info") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify([
              {
                hash: "remote-hash-1",
                name: "迷宫饭 S01E01",
                progress: 0.2,
                state: "downloading",
                dlspeed: 2048,
                eta: 100
              }
            ])
          );
          return;
        }

        if (url.pathname === "/api/v2/torrents/stop" || url.pathname === "/api/v2/torrents/start") {
          assert.equal(body, "hashes=remote-hash-1");
          response.writeHead(200);
          response.end();
          return;
        }

        response.writeHead(404);
        response.end();
      },
      async (baseUrl, paths) => {
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
                baseUrl,
                username: "admin",
                password: "secret"
              }
            }
          });

          const downloads = await app.inject({
            method: "GET",
            url: "/api/downloads",
            headers: auth
          });
          assert.equal(downloads.statusCode, 200);
          assert.equal(downloads.json().items[0].id, "remote-hash-1");
          assert.equal(downloads.json().items[0].source, "qbittorrent");

          const pause = await app.inject({
            method: "POST",
            url: "/api/downloads/remote-hash-1/pause",
            headers: auth
          });
          assert.equal(pause.statusCode, 200);

          const resume = await app.inject({
            method: "POST",
            url: "/api/downloads/remote-hash-1/resume",
            headers: auth
          });
          assert.equal(resume.statusCode, 200);
        } finally {
          await app.close();
        }

        assert.deepEqual(
          paths.filter((item) => item !== "/api/v2/auth/login"),
          [
            "/api/v2/torrents/info",
            "/api/v2/torrents/stop",
            "/api/v2/torrents/info",
            "/api/v2/torrents/start",
            "/api/v2/torrents/info"
          ]
        );
      }
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
