import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

interface CapturedRequest {
  method?: string;
  url: URL;
  headers: IncomingMessage["headers"];
}

async function withFakeServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  run: (baseUrl: string, requests: CapturedRequest[]) => Promise<void>
) {
  const requests: CapturedRequest[] = [];
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ method: request.method, url, headers: request.headers });
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

test("system status diagnoses configured services without leaking tokens", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));

  try {
    await withFakeServer(
      async (request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");

        if (url.pathname === "/api/v1/status") {
          assert.equal(request.method, "GET");
          assert.equal(request.headers.authorization, "Bearer ab-token");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ version: "ab-test", status: "ok" }));
          return;
        }

        if (url.pathname === "/api/v2/auth/login") {
          response.writeHead(200, { "set-cookie": "SID=qbt-health" });
          response.end("Ok.");
          return;
        }

        if (url.pathname === "/api/v2/app/version") {
          assert.equal(request.method, "GET");
          assert.equal(request.headers.cookie, "SID=qbt-health");
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("v5.1.2");
          return;
        }

        if (url.pathname === "/health") {
          assert.equal(request.method, "GET");
          assert.equal(request.headers["x-emby-token"], "jf-token");
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("Healthy");
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
              autoBangumi: {
                baseUrl,
                token: "ab-token",
                preferredProvider: "mikan"
              },
              qBittorrent: {
                baseUrl,
                username: "admin",
                password: "secret"
              },
              jellyfin: {
                baseUrl,
                token: "jf-token",
                userId: "jf-user",
                deviceId: "cluo-test"
              },
              playback: {
                preferredProvider: "jellyfin"
              }
            }
          });

          const status = await app.inject({
            method: "GET",
            url: "/api/system/status",
            headers: auth
          });

          assert.equal(status.statusCode, 200);
          const body = status.json();
          assert.equal(body.overall, "ready");
          assert.equal(body.items.find((item: { id: string }) => item.id === "autobangumi").state, "ready");
          assert.equal(body.items.find((item: { id: string }) => item.id === "qbittorrent").state, "ready");
          assert.equal(body.items.find((item: { id: string }) => item.id === "jellyfin").state, "ready");
          assert.equal(body.items.find((item: { id: string }) => item.id === "playback").state, "ready");
          assert.equal(JSON.stringify(body).includes("jf-token"), false);
          assert.equal(JSON.stringify(body).includes("ab-token"), false);
          assert.equal(JSON.stringify(body).includes("secret"), false);
        } finally {
          await app.close();
        }

        assert.deepEqual(
          requests.map((item) => item.url.pathname).sort(),
          ["/api/v1/status", "/api/v2/auth/login", "/api/v2/app/version", "/health"].sort()
        );
      }
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("system status marks reserved playback providers as degraded", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));

  try {
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
          playback: {
            preferredProvider: "kodi"
          }
        }
      });

      const status = await app.inject({
        method: "GET",
        url: "/api/system/status",
        headers: auth
      });

      assert.equal(status.statusCode, 200);
      const body = status.json();
      assert.equal(body.overall, "degraded");
      assert.equal(body.items.find((item: { id: string }) => item.id === "autobangumi").state, "not-configured");
      assert.equal(body.items.find((item: { id: string }) => item.id === "qbittorrent").state, "not-configured");
      assert.equal(body.items.find((item: { id: string }) => item.id === "jellyfin").state, "not-configured");
      const playback = body.items.find((item: { id: string }) => item.id === "playback");
      assert.equal(playback.state, "degraded");
      assert.match(playback.message, /reserved/);
    } finally {
      await app.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
