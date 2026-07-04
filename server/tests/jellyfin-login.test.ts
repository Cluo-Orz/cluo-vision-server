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

test("BFF logs into Jellyfin and stores token plus user id without leaking token", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cluo-server-"));
  const requests: Array<{ url: URL; body: string; headers: IncomingMessage["headers"] }> = [];

  try {
    await withFakeServer(
      async (request, response) => {
        const body = await readBody(request);
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        requests.push({ url, body, headers: request.headers });

        if (url.pathname === "/Users/AuthenticateByName") {
          assert.equal(request.method, "POST");
          assert.match(String(request.headers.authorization), /MediaBrowser/);
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
          return;
        }

        response.writeHead(404);
        response.end();
      },
      async (baseUrl) => {
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

          const login = await app.inject({
            method: "POST",
            url: "/api/settings/jellyfin/login",
            headers: auth,
            payload: {
              baseUrl,
              username: "owner",
              password: "secret",
              deviceId: "cluo-test"
            }
          });

          assert.equal(login.statusCode, 200);
          assert.deepEqual(login.json().user, {
            id: "jf-user",
            name: "Owner"
          });
          assert.equal(login.json().services.jellyfin.baseUrl, baseUrl);
          assert.equal(login.json().services.jellyfin.tokenConfigured, true);
          assert.equal(login.json().services.jellyfin.token, undefined);
          assert.equal(login.json().services.jellyfin.userId, "jf-user");
          assert.equal(JSON.stringify(login.json()).includes("jf-access-token"), false);

          const settings = await app.inject({
            method: "GET",
            url: "/api/settings/services",
            headers: auth
          });

          assert.equal(settings.statusCode, 200);
          assert.equal(settings.json().services.jellyfin.tokenConfigured, true);
          assert.equal(settings.json().services.jellyfin.userId, "jf-user");
          assert.equal(JSON.stringify(settings.json()).includes("jf-access-token"), false);
        } finally {
          await app.close();
        }
      }
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.pathname, "/Users/AuthenticateByName");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
