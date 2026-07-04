import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

test("discover search aggregates anime results, library hits, and recent queries", async () => {
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
    const auth = { authorization: `Bearer ${register.json().token as string}` };

    const firstSearch = await app.inject({
      method: "GET",
      url: "/api/discover/search?q=%E8%BF%B7%E5%AE%AB",
      headers: auth
    });
    assert.equal(firstSearch.statusCode, 200);
    assert.equal(firstSearch.json().query, "迷宫");
    assert.equal(firstSearch.json().library.length, 0);
    assert.match(firstSearch.json().anime[0].title, /迷宫/);
    assert.equal(firstSearch.json().recent[0].query, "迷宫");
    assert.equal(firstSearch.json().recent[0].resultCounts.anime, firstSearch.json().anime.length);

    const subscribe = await app.inject({
      method: "POST",
      url: "/api/anime/subscribe",
      headers: auth,
      payload: {
        title: firstSearch.json().anime[0].title,
        provider: firstSearch.json().anime[0].provider,
        rssUrl: firstSearch.json().anime[0].rssUrl
      }
    });
    assert.equal(subscribe.statusCode, 201);

    const complete = await app.inject({
      method: "POST",
      url: `/api/anime/downloads/${subscribe.json().download.id as string}/complete`,
      headers: auth
    });
    assert.equal(complete.statusCode, 200);

    const secondSearch = await app.inject({
      method: "GET",
      url: "/api/discover/search?q=%E8%BF%B7%E5%AE%AB",
      headers: auth
    });
    assert.equal(secondSearch.statusCode, 200);
    assert.equal(secondSearch.json().library.length, 1);
    assert.match(secondSearch.json().library[0].title, /迷宫/);
    assert.equal(secondSearch.json().recent[0].searchCount, 2);
    assert.equal(secondSearch.json().recent[0].resultCounts.library, 1);

    const recent = await app.inject({
      method: "GET",
      url: "/api/discover/recent",
      headers: auth
    });
    assert.equal(recent.statusCode, 200);
    assert.equal(recent.json().items[0].query, "迷宫");
    assert.equal(recent.json().items[0].searchCount, 2);

    await app.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
