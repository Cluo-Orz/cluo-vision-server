import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { createToken, hashPassword, toAuthUser, verifyPassword, verifyToken, type AuthUser } from "./auth.js";
import type { AppConfig } from "./config.js";
import { JsonStore } from "./store/jsonStore.js";
import { AnimeService } from "./services/animeService.js";
import { DiscoveryService } from "./services/discoveryService.js";
import { DownloadAutomationService } from "./services/downloadAutomationService.js";
import { HistoryService } from "./services/historyService.js";
import { JellyfinClient, JellyfinClientError } from "./services/jellyfinClient.js";
import { LibraryService } from "./services/libraryService.js";
import { PlaybackService } from "./services/playbackService.js";
import { ServiceHealthService } from "./services/serviceHealthService.js";
import type { DownloadTask, HistoryEntry, MediaItem, ServiceSettings } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

const registerSchema = z.object({
  username: z.string().min(2).max(40),
  password: z.string().min(6).max(200),
  displayName: z.string().min(1).max(80).optional()
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const animeSearchSchema = z.object({
  q: z.string().min(1),
  provider: z.string().min(1).optional()
});

const discoverSearchSchema = z.object({
  q: z.string().min(1),
  provider: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional()
});

const recentSearchesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(30).optional()
});

const animeSubscribeSchema = z.object({
  title: z.string().min(1),
  provider: z.string().min(1).optional(),
  rssUrl: z.string().min(1).nullable().optional(),
  posterUrl: z.string().url().optional(),
  autoBangumi: z.record(z.string(), z.unknown()).optional()
});

const historyEventSchema = z.object({
  itemId: z.string().min(1),
  title: z.string().min(1),
  type: z.enum(["anime-episode", "movie", "series-episode"]),
  posterUrl: z.string().url().optional(),
  positionSeconds: z.number().min(0),
  durationSeconds: z.number().min(0)
});

const playbackStartSchema = z.object({
  itemId: z.string().min(1)
});

const playbackHeartbeatSchema = z.object({
  positionSeconds: z.number().min(0),
  state: z.enum(["playing", "paused"]).optional()
});

const playbackStopSchema = z.object({
  positionSeconds: z.number().min(0).optional()
});

const jellyfinLibrarySyncSchema = z.object({
  searchTerm: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  scan: z.boolean().optional()
});

const libraryItemsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional()
});

const librarySearchSchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const libraryWatchedSchema = z.object({
  watched: z.boolean()
});

const libraryFavoriteSchema = z.object({
  favorite: z.boolean()
});

const serviceSettingsSchema = z.object({
  autoBangumi: z
    .object({
      baseUrl: z.string().url().nullable().optional(),
      token: z.string().nullable().optional(),
      preferredProvider: z.string().min(1).optional()
    })
    .optional(),
  qBittorrent: z
    .object({
      baseUrl: z.string().url().nullable().optional(),
      username: z.string().nullable().optional(),
      password: z.string().nullable().optional(),
      apiKey: z.string().nullable().optional()
    })
    .optional(),
  jellyfin: z
    .object({
      baseUrl: z.string().url().nullable().optional(),
      token: z.string().nullable().optional(),
      userId: z.string().nullable().optional(),
      deviceId: z.string().min(1).optional()
    })
    .optional(),
  playback: z
    .object({
      preferredProvider: z.enum(["local-dev", "external-player", "jellyfin", "kodi"]).optional(),
      externalPlayerPackage: z.string().nullable().optional(),
      externalPlayerMimeType: z.string().min(1).optional()
    })
    .optional()
});

const jellyfinLoginSchema = z.object({
  baseUrl: z.string().url(),
  username: z.string().min(1),
  password: z.string(),
  deviceId: z.string().min(1).optional()
});

export async function createServer(config: AppConfig) {
  const app = Fastify({ logger: true });
  const store = new JsonStore(config.dataFile, config);
  await store.init();

  const animeService = new AnimeService(store, config);
  const historyService = new HistoryService(store);
  const libraryService = new LibraryService(store);
  const discoveryService = new DiscoveryService(store, libraryService, animeService);
  const playbackService = new PlaybackService(store, historyService);
  const serviceHealthService = new ServiceHealthService(store);
  const downloadAutomationService = new DownloadAutomationService(
    animeService,
    libraryService,
    config.downloadImportAutomation
  );
  const webRoot = path.resolve(process.cwd(), "src", "web");

  downloadAutomationService.start();
  app.addHook("onClose", async () => {
    downloadAutomationService.stop();
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("access-control-allow-origin", request.headers.origin ?? "*");
    reply.header("access-control-allow-credentials", "true");
    reply.header("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
    reply.header("access-control-allow-headers", "content-type,authorization");
    if (request.method === "OPTIONS") {
      await reply.code(204).send();
    }
  });

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    if (!token) {
      await reply.code(401).send({ error: "Missing bearer token" });
      return;
    }

    const user = verifyToken(token, config);
    if (!user) {
      await reply.code(401).send({ error: "Invalid or expired token" });
      return;
    }

    request.user = user;
  }

  app.get("/api/health", async () => {
    const state = await store.read();
    return {
      status: "ok",
      version: "0.1.0",
      users: state.users.length,
      services: {
        autoBangumi: Boolean(state.settings.autoBangumi.baseUrl),
        jellyfin: Boolean(state.settings.jellyfin.baseUrl && state.settings.jellyfin.token),
        playback: state.settings.playback.preferredProvider
      }
    };
  });

  app.get("/", async (_request, reply) => {
    await sendWebAsset(reply, path.join(webRoot, "index.html"), "text/html; charset=utf-8");
  });

  app.get("/app.js", async (_request, reply) => {
    await sendWebAsset(reply, path.join(webRoot, "app.js"), "text/javascript; charset=utf-8");
  });

  app.get("/style.css", async (_request, reply) => {
    await sendWebAsset(reply, path.join(webRoot, "style.css"), "text/css; charset=utf-8");
  });

  app.post("/api/auth/register", async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const result = await store.update((state) => {
      if (state.users.some((user) => user.username === input.username)) {
        return { type: "conflict" as const };
      }

      const { salt, hash } = hashPassword(input.password);
      const user = {
        id: randomUUID(),
        username: input.username,
        displayName: input.displayName ?? input.username,
        role: "owner" as const,
        passwordSalt: salt,
        passwordHash: hash,
        createdAt: new Date().toISOString()
      };
      state.users.push(user);

      const authUser = toAuthUser(user);
      return {
        type: "created" as const,
        user: authUser,
        token: createToken(authUser, config)
      };
    });

    if (result.type === "conflict") {
      await reply.code(409).send({ error: "Username already exists" });
      return;
    }

    await reply.code(201).send(result);
  });

  app.post("/api/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const state = await store.read();
    const user = state.users.find((item) => item.username === input.username);
    if (!user || !verifyPassword(input.password, user.passwordSalt, user.passwordHash)) {
      await reply.code(401).send({ error: "Invalid username or password" });
      return;
    }

    const authUser = toAuthUser(user);
    return {
      type: "login",
      user: authUser,
      token: createToken(authUser, config)
    };
  });

  app.get("/api/auth/me", { preHandler: authenticate }, async (request) => {
    return { user: request.user };
  });

  app.get("/api/system/status", { preHandler: authenticate }, async () => {
    return await serviceHealthService.status();
  });

  app.get("/api/home", { preHandler: authenticate }, async (request) => {
    const [recentlyAdded, downloads, history, jellyfinResume] = await Promise.all([
      libraryService.list({ limit: 10 }),
      animeService.listDownloads(),
      historyService.list(request.user!),
      libraryService.listResume({ limit: 10 })
    ]);

    return {
      continueWatching:
        jellyfinResume.length > 0
          ? jellyfinResume.map(toContinueWatchingItem)
          : history.slice(0, 10),
      recentlyAdded,
      activeDownloads: downloads.filter((item) => item.state !== "completed")
    };
  });

  app.get("/api/discover/search", { preHandler: authenticate }, async (request) => {
    const query = discoverSearchSchema.parse(request.query);
    return await discoveryService.search(request.user!.id, query);
  });

  app.get("/api/discover/recent", { preHandler: authenticate }, async (request) => {
    const query = recentSearchesSchema.parse(request.query);
    return { items: await discoveryService.recent(request.user!.id, query.limit) };
  });

  app.get("/api/anime/search", { preHandler: authenticate }, async (request) => {
    const query = animeSearchSchema.parse(request.query);
    return { results: await animeService.search(query.q, query.provider) };
  });

  app.get("/api/anime/status", { preHandler: authenticate }, async () => {
    return await animeService.autoBangumiStatus();
  });

  app.get("/api/anime/rules", { preHandler: authenticate }, async () => {
    return await animeService.listRules();
  });

  app.get("/api/anime/rss", { preHandler: authenticate }, async () => {
    return await animeService.listRss();
  });

  app.get("/api/anime/subscriptions", { preHandler: authenticate }, async () => {
    return { items: await animeService.listSubscriptions() };
  });

  app.post("/api/anime/subscribe", { preHandler: authenticate }, async (request, reply) => {
    const input = animeSubscribeSchema.parse(request.body);
    const result = await animeService.subscribe(input);
    await reply.code(201).send(result);
  });

  app.get("/api/anime/downloads", { preHandler: authenticate }, async () => {
    return { items: await animeService.listDownloads() };
  });

  app.get("/api/downloads", { preHandler: authenticate }, async () => {
    return { items: await animeService.listDownloads() };
  });

  app.post<{ Params: { id: string } }>(
    "/api/downloads/:id/pause",
    { preHandler: authenticate },
    async (request, reply) => {
      const result = await animeService.pauseDownload(request.params.id);
      if (result.status === "not-found") {
        await reply.code(404).send({ error: "Download task not found" });
        return;
      }
      if (result.status === "not-controllable") {
        await reply.code(400).send({ error: result.error });
        return;
      }
      return { item: result.task };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/downloads/:id/resume",
    { preHandler: authenticate },
    async (request, reply) => {
      const result = await animeService.resumeDownload(request.params.id);
      if (result.status === "not-found") {
        await reply.code(404).send({ error: "Download task not found" });
        return;
      }
      if (result.status === "not-controllable") {
        await reply.code(400).send({ error: result.error });
        return;
      }
      return { item: result.task };
    }
  );

  app.post("/api/downloads/import-completed", { preHandler: authenticate }, async () => {
    const downloads = await animeService.listDownloads();
    const completed = downloads.filter((download) => download.state === "completed");
    const results = [];

    for (const download of completed) {
      results.push(await libraryService.importCompletedDownload(download));
    }

    return summarizeBatchImport(results);
  });

  app.post("/api/automation/download-import/run", { preHandler: authenticate }, async () => {
    return await downloadAutomationService.runOnce();
  });

  app.post<{ Params: { id: string } }>(
    "/api/downloads/:id/import",
    { preHandler: authenticate },
    async (request, reply) => {
      const downloads = await animeService.listDownloads();
      const download = findDownload(downloads, request.params.id);
      if (!download) {
        await reply.code(404).send({ error: "Download task not found" });
        return;
      }
      if (download.state !== "completed") {
        await reply.code(400).send({ error: "Only completed downloads can be imported" });
        return;
      }

      const result = await libraryService.importCompletedDownload(download);
      if (!result.configured && result.items.length === 0) {
        await reply.code(400).send({
          error: result.message,
          status: result.status,
          searchTerms: result.searchTerms
        });
        return;
      }

      return result;
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/anime/downloads/:id/complete",
    { preHandler: authenticate },
    async (request, reply) => {
      const result = await animeService.completeDownload(request.params.id);
      if (result.status === "not-found") {
        await reply.code(404).send({ error: "Download task not found" });
        return;
      }
      if (result.status === "not-controllable") {
        await reply.code(400).send({ error: result.error });
        return;
      }
      const mediaItems = (await animeService.listMedia()).filter(
        (item) => item.downloadTaskId === result.task.id
      );
      return { item: result.task, mediaItems };
    }
  );

  app.get("/api/library/items", { preHandler: authenticate }, async (request) => {
    const query = libraryItemsSchema.parse(request.query);
    return { items: await libraryService.list(query) };
  });

  app.get("/api/library/search", { preHandler: authenticate }, async (request) => {
    const query = librarySearchSchema.parse(request.query);
    return { items: await libraryService.search(query) };
  });

  app.get<{ Params: { id: string } }>(
    "/api/library/items/:id",
    { preHandler: authenticate },
    async (request, reply) => {
      const item = await libraryService.getItem(request.params.id);
      if (!item) {
        await reply.code(404).send({ error: "Media item not found" });
        return;
      }

      return { item };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/library/items/:id/watched",
    { preHandler: authenticate },
    async (request, reply) => {
      const input = libraryWatchedSchema.parse(request.body);
      const item = await libraryService.setWatched(request.params.id, input.watched);
      if (!item) {
        await reply.code(404).send({ error: "Media item not found" });
        return;
      }

      return { item };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/library/items/:id/favorite",
    { preHandler: authenticate },
    async (request, reply) => {
      const input = libraryFavoriteSchema.parse(request.body);
      const item = await libraryService.setFavorite(request.params.id, input.favorite);
      if (!item) {
        await reply.code(404).send({ error: "Media item not found" });
        return;
      }

      return { item };
    }
  );

  app.post("/api/library/sync/jellyfin", { preHandler: authenticate }, async (request, reply) => {
    const input = jellyfinLibrarySyncSchema.parse(request.body ?? {});
    const result = await libraryService.syncJellyfin(input);
    if (!result.configured) {
      await reply.code(400).send({ error: "Jellyfin is not configured" });
      return;
    }

    return result;
  });

  app.get("/api/playback/providers", { preHandler: authenticate }, async () => {
    const state = await store.read();
    return {
      preferredProvider: state.settings.playback.preferredProvider,
      items: [
        {
          id: "local-dev",
          label: "Local development mock",
          available: true,
          mode: "mock-stream"
        },
        {
          id: "jellyfin",
          label: "Jellyfin stream URL",
          available: Boolean(state.settings.jellyfin.baseUrl && state.settings.jellyfin.token),
          mode: "stream-url"
        },
        {
          id: "external-player",
          label: "External Android player intent",
          available: Boolean(state.settings.jellyfin.baseUrl && state.settings.jellyfin.token),
          mode: "intent"
        },
        {
          id: "kodi",
          label: "Kodi JSON-RPC",
          available: false,
          mode: "jsonrpc"
        }
      ]
    };
  });

  app.post("/api/playback/resolve", { preHandler: authenticate }, async (request, reply) => {
    const body = playbackStartSchema.parse(request.body);
    const target = await playbackService.resolve(body.itemId);
    if (!target) {
      await reply.code(404).send({ error: "Media item is not ready for playback" });
      return;
    }

    return { target };
  });

  app.get("/api/playback/sessions", { preHandler: authenticate }, async (request) => {
    return { items: await playbackService.list(request.user!) };
  });

  app.post("/api/playback/sessions", { preHandler: authenticate }, async (request, reply) => {
    const body = playbackStartSchema.parse(request.body);
    const session = await playbackService.start(request.user!, body.itemId);
    if (!session) {
      await reply.code(404).send({ error: "Media item is not ready for playback" });
      return;
    }

    await reply.code(201).send({ session });
  });

  app.patch<{ Params: { id: string } }>(
    "/api/playback/sessions/:id",
    { preHandler: authenticate },
    async (request, reply) => {
      const body = playbackHeartbeatSchema.parse(request.body);
      const session = await playbackService.heartbeat(request.user!, request.params.id, body);
      if (!session) {
        await reply.code(404).send({ error: "Playback session not found" });
        return;
      }

      return { session };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/playback/sessions/:id/stop",
    { preHandler: authenticate },
    async (request, reply) => {
      const body = playbackStopSchema.parse(request.body ?? {});
      const session = await playbackService.stop(request.user!, request.params.id, body);
      if (!session) {
        await reply.code(404).send({ error: "Playback session not found" });
        return;
      }

      return { session };
    }
  );

  app.get("/api/history", { preHandler: authenticate }, async (request) => {
    return { items: await historyService.list(request.user!) };
  });

  app.post("/api/history/events", { preHandler: authenticate }, async (request, reply) => {
    const input = historyEventSchema.parse(request.body);
    const entry: HistoryEntry = await historyService.record(request.user!, input);
    await reply.code(201).send({ item: entry });
  });

  app.get("/api/settings/services", { preHandler: authenticate }, async () => {
    const state = await store.read();
    return { services: publicServiceSettings(state.settings) };
  });

  app.patch("/api/settings/services", { preHandler: authenticate }, async (request) => {
    const input = serviceSettingsSchema.parse(request.body);
    const services = await store.update((state) => {
      if (input.autoBangumi) {
        state.settings.autoBangumi = {
          ...state.settings.autoBangumi,
          ...input.autoBangumi,
          token: input.autoBangumi.token === undefined ? state.settings.autoBangumi.token : input.autoBangumi.token
        };
      }
      if (input.qBittorrent) {
        state.settings.qBittorrent = {
          ...state.settings.qBittorrent,
          ...input.qBittorrent,
          password:
            input.qBittorrent.password === undefined
              ? state.settings.qBittorrent.password
              : input.qBittorrent.password,
          apiKey:
            input.qBittorrent.apiKey === undefined
              ? state.settings.qBittorrent.apiKey
              : input.qBittorrent.apiKey
        };
      }
      if (input.playback) {
        state.settings.playback = {
          ...state.settings.playback,
          ...input.playback
        };
      }
      if (input.jellyfin) {
        state.settings.jellyfin = {
          ...state.settings.jellyfin,
          ...input.jellyfin,
          token: input.jellyfin.token === undefined ? state.settings.jellyfin.token : input.jellyfin.token
        };
      }
      return publicServiceSettings(state.settings);
    });
    return { services };
  });

  app.post("/api/settings/jellyfin/login", { preHandler: authenticate }, async (request, reply) => {
    const input = jellyfinLoginSchema.parse(request.body);
    const deviceId = input.deviceId ?? "cluo-server-dev";
    let authResult;
    try {
      authResult = await JellyfinClient.authenticateByName({
        baseUrl: input.baseUrl,
        username: input.username,
        password: input.password,
        deviceId
      });
    } catch (error) {
      const statusCode =
        error instanceof JellyfinClientError && error.statusCode === 401 ? 401 : 502;
      await reply.code(statusCode).send({ error: messageFromError(error) });
      return;
    }

    const services = await store.update((state) => {
      state.settings.jellyfin = {
        ...state.settings.jellyfin,
        baseUrl: input.baseUrl,
        token: authResult.accessToken,
        userId: authResult.user.id,
        deviceId
      };
      return publicServiceSettings(state.settings);
    });

    return {
      services,
      user: authResult.user
    };
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof z.ZodError) {
      await reply.code(400).send({
        error: "Validation failed",
        details: error.issues
      });
      return;
    }

    app.log.error(error);
    await reply.code(500).send({ error: "Internal server error" });
  });

  return app;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sendWebAsset(reply: FastifyReply, filePath: string, contentType: string) {
  const content = await readFile(filePath, "utf8");
  reply.header("content-type", contentType);
  await reply.send(content);
}

function publicServiceSettings(settings: ServiceSettings) {
  return {
    autoBangumi: {
      baseUrl: settings.autoBangumi.baseUrl,
      tokenConfigured: Boolean(settings.autoBangumi.token),
      preferredProvider: settings.autoBangumi.preferredProvider
    },
    qBittorrent: {
      baseUrl: settings.qBittorrent.baseUrl,
      username: settings.qBittorrent.username,
      passwordConfigured: Boolean(settings.qBittorrent.password),
      apiKeyConfigured: Boolean(settings.qBittorrent.apiKey)
    },
    jellyfin: {
      baseUrl: settings.jellyfin.baseUrl,
      tokenConfigured: Boolean(settings.jellyfin.token),
      userId: settings.jellyfin.userId,
      userIdConfigured: Boolean(settings.jellyfin.userId),
      deviceId: settings.jellyfin.deviceId
    },
    playback: settings.playback
  };
}

function findDownload(downloads: DownloadTask[], id: string): DownloadTask | null {
  return downloads.find((item) => item.id === id || item.externalHash === id) ?? null;
}

function toContinueWatchingItem(item: MediaItem) {
  const positionSeconds = item.playbackPositionSeconds ?? 0;
  const progress =
    item.durationSeconds > 0
      ? Math.min(1, Math.max(0, positionSeconds / item.durationSeconds))
      : 0;

  return {
    id: `resume:${item.id}`,
    itemId: item.id,
    title: item.title,
    type: item.type,
    posterUrl: item.posterUrl,
    positionSeconds,
    durationSeconds: item.durationSeconds,
    progress,
    completed: Boolean(item.watched),
    source: item.source
  };
}

function summarizeBatchImport(results: Awaited<ReturnType<LibraryService["importCompletedDownload"]>>[]) {
  return {
    total: results.length,
    imported: results.filter((item) => item.status === "imported" || item.status === "local-only")
      .length,
    pending: results.filter((item) => item.status === "pending-scan").length,
    failed: results.filter((item) => item.status === "not-configured").length,
    synced: results.reduce((sum, item) => sum + item.synced, 0),
    items: results.flatMap((item) => item.items),
    results
  };
}
