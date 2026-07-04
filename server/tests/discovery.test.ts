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

    const starterTrending = await app.inject({
      method: "GET",
      url: "/api/discover/trending",
      headers: auth
    });
    assert.equal(starterTrending.statusCode, 200);
    assert.equal(starterTrending.json().recentlyAdded.length, 0);
    assert.equal(
      starterTrending.json().suggestions.some((item: { kind: string; title: string }) => {
        return item.kind === "starter" && item.title === "迷宫饭";
      }),
      true
    );

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

    const defaultSources = await app.inject({
      method: "GET",
      url: "/api/discover/sources",
      headers: auth
    });
    assert.equal(defaultSources.statusCode, 200);
    assert.equal(
      defaultSources.json().items.find((item: { id: string }) => item.id === "jellyfin-library")
        .status,
      "needs-config"
    );
    assert.equal(
      defaultSources.json().items.find((item: { id: string }) => item.id === "local-dev-fallback")
        .available,
      true
    );

    await app.inject({
      method: "PATCH",
      url: "/api/settings/services",
      headers: auth,
      payload: {
        autoBangumi: {
          baseUrl: "http://127.0.0.1:7892",
          preferredProvider: "mikan"
        },
        qBittorrent: {
          baseUrl: "http://127.0.0.1:8080",
          username: "admin",
          password: "secret"
        },
        jellyfin: {
          baseUrl: "http://127.0.0.1:8096",
          token: "jf-token",
          userId: "jf-user"
        },
        playback: {
          preferredProvider: "external-player",
          externalPlayerPackage: "com.hush.yamby"
        }
      }
    });

    const configuredSources = await app.inject({
      method: "GET",
      url: "/api/discover/sources",
      headers: auth
    });
    assert.equal(configuredSources.statusCode, 200);
    const sources = configuredSources.json().items;
    assert.equal(
      sources.find((item: { id: string }) => item.id === "jellyfin-library").status,
      "ready"
    );
    assert.equal(
      sources.find((item: { id: string }) => item.id === "autobangumi-anime").provider,
      "mikan"
    );
    assert.equal(
      sources.find((item: { id: string }) => item.id === "qbittorrent-downloads").available,
      true
    );
    assert.equal(
      sources.find((item: { id: string }) => item.id === "playback-external-player").status,
      "ready"
    );

    const trending = await app.inject({
      method: "GET",
      url: "/api/discover/trending",
      headers: auth
    });
    assert.equal(trending.statusCode, 200);
    assert.equal(trending.json().recentlyAdded.length, 1);
    assert.equal(trending.json().subscriptions.length, 1);
    assert.equal(trending.json().recentSearches[0].query, "迷宫");
    assert.equal(
      trending.json().suggestions.some((item: { kind: string; action: string }) => {
        return item.kind === "library" && item.action === "open-library";
      }),
      true
    );
    assert.equal(
      trending.json().suggestions.some((item: { kind: string; query: string }) => {
        return item.kind === "subscription" && /迷宫/.test(item.query);
      }),
      true
    );

    await app.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
