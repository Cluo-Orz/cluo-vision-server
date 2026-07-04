const state = {
  token: localStorage.getItem("cluo_token") || "",
  selectedMedia: null,
  playbackSession: null,
  services: null
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {})
  };
  if (state.token) headers.authorization = `Bearer ${state.token}`;

  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error || response.statusText);
  }
  return data;
}

function setStatus(message) {
  $("serverStatus").textContent = message;
}

function runAction(action) {
  try {
    Promise.resolve(action()).catch((error) => {
      setStatus(error?.message || String(error));
    });
  } catch (error) {
    setStatus(error?.message || String(error));
  }
}

function empty() {
  return document.importNode($("emptyTemplate").content, true);
}

function mountList(container, items, render) {
  container.replaceChildren();
  if (!items.length) {
    container.append(empty());
    return;
  }
  for (const item of items) {
    container.append(render(item));
  }
}

function itemShell(title, subtitle) {
  const node = document.createElement("article");
  node.className = "item";
  const text = document.createElement("div");
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const p = document.createElement("p");
  p.textContent = subtitle || "";
  text.append(h3, p);
  const actions = document.createElement("div");
  actions.className = "item-actions";
  node.append(text, actions);
  return { node, actions };
}

async function register() {
  const username = $("username").value.trim();
  const password = $("password").value;
  const result = await api("/api/auth/register", {
    method: "POST",
    body: { username, password, displayName: username }
  });
  setToken(result.token, result.user.displayName);
}

async function login(event) {
  event.preventDefault();
  const username = $("username").value.trim();
  const password = $("password").value;
  const result = await api("/api/auth/login", {
    method: "POST",
    body: { username, password }
  });
  setToken(result.token, result.user.displayName);
}

function setToken(token, displayName) {
  state.token = token;
  localStorage.setItem("cluo_token", token);
  $("authState").textContent = displayName ? `已登录：${displayName}` : "已登录";
  refreshAll();
}

async function search(event) {
  event.preventDefault();
  const q = $("searchInput").value.trim();
  if (!q) return;
  const result = await api(`/api/anime/search?q=${encodeURIComponent(q)}`);
  $("searchMeta").textContent = `${result.results.length} 个结果`;
  mountList($("searchResults"), result.results, renderSearchResult);
}

function renderSearchResult(result) {
  const node = document.createElement("article");
  node.className = "poster-card";
  const art = document.createElement("div");
  art.className = "poster-art";
  art.textContent = result.title.slice(0, 2);
  const title = document.createElement("h3");
  title.textContent = result.title;
  const meta = document.createElement("p");
  meta.textContent = `${result.provider} · ${Math.round(result.confidence * 100)}%`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "订阅";
  button.addEventListener("click", () => subscribe(result));
  node.append(art, title, meta, button);
  return node;
}

async function subscribe(result) {
  await api("/api/anime/subscribe", {
    method: "POST",
    body: {
      title: result.title,
      provider: result.provider,
      rssUrl: result.rssUrl,
      posterUrl: result.posterUrl,
      autoBangumi: result.raw
    }
  });
  await refreshAll();
}

async function refreshAll() {
  if (!state.token) return;
  await refreshSettings();
  await Promise.all([
    refreshSystemStatus(),
    refreshProviders(),
    refreshAnimeStatus(),
    refreshAnimeRules(),
    refreshDownloads(),
    refreshLibrary(),
    refreshHistory(),
    refreshHome()
  ]);
}

async function refreshSettings() {
  const result = await api("/api/settings/services");
  state.services = result.services;

  $("autoBangumiUrl").value = result.services.autoBangumi.baseUrl || "";
  $("autoBangumiToken").value = "";
  $("autoBangumiProvider").value = result.services.autoBangumi.preferredProvider || "mikan";
  $("qBittorrentUrl").value = result.services.qBittorrent?.baseUrl || "";
  $("qBittorrentUsername").value = result.services.qBittorrent?.username || "";
  $("qBittorrentPassword").value = "";
  $("qBittorrentApiKey").value = "";
  $("jellyfinUrl").value = result.services.jellyfin.baseUrl || "";
  $("jellyfinToken").value = "";
  $("jellyfinUserId").value = result.services.jellyfin.userId || "";
  $("jellyfinPassword").value = "";
  $("jellyfinDeviceId").value = result.services.jellyfin.deviceId || "cluo-server-dev";
  $("playbackProvider").value = result.services.playback.preferredProvider || "local-dev";
  $("externalPlayerPackage").value = result.services.playback.externalPlayerPackage || "";
  $("externalPlayerMimeType").value = result.services.playback.externalPlayerMimeType || "video/*";

  const autoState = result.services.autoBangumi.baseUrl ? "AutoBangumi 已配置" : "AutoBangumi 未配置";
  const qbitState = result.services.qBittorrent?.baseUrl ? "qBittorrent 已配置" : "qBittorrent 未配置";
  const jellyfinState = result.services.jellyfin.tokenConfigured ? "Jellyfin 已配置" : "Jellyfin 未配置";
  $("serviceMeta").textContent = `${autoState} · ${qbitState} · ${jellyfinState}`;
}

async function saveSettings(event) {
  event.preventDefault();

  const autoBangumi = {
    baseUrl: nullableValue($("autoBangumiUrl").value),
    preferredProvider: $("autoBangumiProvider").value.trim() || "mikan"
  };
  const autoToken = $("autoBangumiToken").value.trim();
  if (autoToken) autoBangumi.token = autoToken;

  const qBittorrent = {
    baseUrl: nullableValue($("qBittorrentUrl").value),
    username: nullableValue($("qBittorrentUsername").value)
  };
  const qBittorrentPassword = $("qBittorrentPassword").value.trim();
  if (qBittorrentPassword) qBittorrent.password = qBittorrentPassword;
  const qBittorrentApiKey = $("qBittorrentApiKey").value.trim();
  if (qBittorrentApiKey) qBittorrent.apiKey = qBittorrentApiKey;

  const jellyfin = {
    baseUrl: nullableValue($("jellyfinUrl").value),
    userId: nullableValue($("jellyfinUserId").value),
    deviceId: $("jellyfinDeviceId").value.trim() || "cluo-server-dev"
  };
  const jellyfinToken = $("jellyfinToken").value.trim();
  if (jellyfinToken) jellyfin.token = jellyfinToken;

  const result = await api("/api/settings/services", {
    method: "PATCH",
    body: {
      autoBangumi,
      qBittorrent,
      jellyfin,
      playback: {
        preferredProvider: $("playbackProvider").value,
        externalPlayerPackage: nullableValue($("externalPlayerPackage").value),
        externalPlayerMimeType: $("externalPlayerMimeType").value.trim() || "video/*"
      }
    }
  });
  state.services = result.services;
  await refreshAll();
}

async function loginJellyfin() {
  const result = await api("/api/settings/jellyfin/login", {
    method: "POST",
    body: {
      baseUrl: $("jellyfinUrl").value.trim(),
      username: $("jellyfinUsername").value.trim(),
      password: $("jellyfinPassword").value,
      deviceId: $("jellyfinDeviceId").value.trim() || "cluo-server-dev"
    }
  });
  state.services = result.services;
  $("jellyfinPassword").value = "";
  $("serviceMeta").textContent = `Jellyfin 已登录：${result.user.name}`;
  await refreshAll();
}

function nullableValue(value) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function refreshProviders() {
  const result = await api("/api/playback/providers");
  $("providers").replaceChildren(...result.items.map(renderProvider));
}

function renderProvider(provider) {
  const node = document.createElement("span");
  node.className = `provider-pill ${provider.available ? "is-ready" : "is-off"}`;
  node.textContent = `${provider.id} · ${provider.mode}`;
  if (state.services?.playback?.preferredProvider === provider.id) {
    node.textContent = `${node.textContent} · 当前`;
  }
  return node;
}

async function refreshSystemStatus() {
  const result = await api("/api/system/status");
  $("serviceMeta").textContent = `${result.overall} · ${new Date(result.checkedAt).toLocaleTimeString()}`;
  $("serviceDiagnostics").replaceChildren(...result.items.map(renderDiagnostic));
}

function renderDiagnostic(item) {
  const node = document.createElement("article");
  node.className = `diagnostic-card state-${item.state}`;
  const title = document.createElement("h3");
  title.textContent = item.label;
  const state = document.createElement("p");
  state.textContent = `${item.state} · ${item.configured ? "已配置" : "未配置"}`;
  const message = document.createElement("p");
  message.textContent = item.message;
  node.append(title, state, message);
  if (item.baseUrl) {
    const url = document.createElement("p");
    url.textContent = item.baseUrl;
    node.append(url);
  }
  return node;
}

async function syncJellyfin(scan = false) {
  const limit = Number($("jellyfinSyncLimit").value || 50);
  const body = {
    limit: Number.isFinite(limit) ? limit : 50,
    scan
  };
  const searchTerm = $("jellyfinSyncSearch").value.trim();
  if (searchTerm) body.searchTerm = searchTerm;

  const result = await api("/api/library/sync/jellyfin", {
    method: "POST",
    body
  });
  $("serviceMeta").textContent = result.scanTriggered
    ? `Jellyfin 已触发扫描，同步 ${result.synced} 条`
    : `Jellyfin 同步 ${result.synced} 条`;
  await refreshLibrary();
  await refreshHome();
}

async function refreshHome() {
  const home = await api("/api/home");
  setStatus(`继续观看 ${home.continueWatching.length} · 最近添加 ${home.recentlyAdded.length}`);
}

async function refreshDownloads() {
  const result = await api("/api/downloads");
  $("downloadMeta").textContent = String(result.items.length);
  mountList($("downloads"), result.items, renderDownload);
}

function renderDownload(task) {
  const progressValue = Math.max(0, Math.min(100, Math.round(task.progress)));
  const speed = task.speedBytesPerSecond > 0 ? ` · ${formatSpeed(task.speedBytesPerSecond)}` : "";
  const { node, actions } = itemShell(task.episodeTitle, `${task.source} · ${task.state} · ${progressValue}%${speed}`);
  const progress = document.createElement("div");
  progress.className = "progress";
  const bar = document.createElement("span");
  bar.style.width = `${progressValue}%`;
  progress.append(bar);
  node.firstElementChild.append(progress);

  if (task.source === "local-dev" && task.state !== "completed") {
    const complete = document.createElement("button");
    complete.type = "button";
    complete.textContent = "完成";
    complete.addEventListener("click", async () => {
      await api(`/api/anime/downloads/${task.id}/complete`, { method: "POST" });
      await refreshAll();
    });
    actions.append(complete);
  }

  if (task.state === "paused") {
    const resume = document.createElement("button");
    resume.type = "button";
    resume.textContent = "恢复";
    resume.addEventListener("click", () => runAction(() => controlDownload(task.id, "resume")));
    actions.append(resume);
  } else if (task.state === "completed") {
    const importButton = document.createElement("button");
    importButton.type = "button";
    importButton.textContent = "入库";
    importButton.addEventListener("click", () => runAction(() => importDownload(task.id)));
    actions.append(importButton);
  } else if (task.state !== "completed" && task.state !== "failed") {
    const pause = document.createElement("button");
    pause.type = "button";
    pause.textContent = "暂停";
    pause.addEventListener("click", () => runAction(() => controlDownload(task.id, "pause")));
    actions.append(pause);
  }

  return node;
}

async function controlDownload(taskId, action) {
  await api(`/api/downloads/${encodeURIComponent(taskId)}/${action}`, { method: "POST" });
  await refreshDownloads();
  await refreshHome();
}

async function importDownload(taskId) {
  const result = await api(`/api/downloads/${encodeURIComponent(taskId)}/import`, { method: "POST" });
  $("serviceMeta").textContent = result.scanTriggered
    ? `已触发 Jellyfin 扫描，匹配 ${result.synced} 条`
    : `已入库 ${result.synced} 条`;
  await refreshDownloads();
  await refreshLibrary();
  await refreshHome();
}

async function refreshAnimeStatus() {
  const result = await api("/api/anime/status");
  $("animeStatusMeta").textContent = result.configured
    ? result.reachable
      ? "已连接"
      : "连接失败"
    : "未配置";
  $("animeStatus").textContent = result.configured
    ? result.reachable
      ? compactJson(result.status)
      : result.error || "AutoBangumi 不可用"
    : "配置 AutoBangumi 地址后可读取运行状态。";
}

async function refreshAnimeRules() {
  const result = await api("/api/anime/rules");
  $("animeRulesMeta").textContent = `${result.items.length}${result.error ? " · 回退" : ""}`;
  mountList($("animeRules"), result.items, renderAnimeRule);
}

function renderAnimeRule(rule) {
  const parts = [rule.provider, rule.status];
  if (rule.season) parts.push(`S${String(rule.season).padStart(2, "0")}`);
  if (rule.archived) parts.push("archived");
  if (rule.needsReview) parts.push("needs review");
  const { node } = itemShell(rule.title, parts.join(" · "));
  if (rule.filter || rule.rssUrls?.length) {
    const detail = document.createElement("p");
    detail.textContent = [rule.filter, rule.rssUrls?.[0]].filter(Boolean).join(" · ");
    node.firstElementChild.append(detail);
  }
  return node;
}

function compactJson(value) {
  if (value === null || value === undefined) return "无状态数据";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  }
  if (bytesPerSecond >= 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  return `${bytesPerSecond} B/s`;
}

async function refreshLibrary() {
  const result = await api("/api/library/items");
  $("libraryMeta").textContent = String(result.items.length);
  mountList($("library"), result.items, renderMedia);
}

async function searchLibrary(event) {
  event.preventDefault();
  const q = $("librarySearchInput").value.trim();
  if (!q) {
    await refreshLibrary();
    return;
  }

  const result = await api(`/api/library/search?q=${encodeURIComponent(q)}`);
  $("libraryMeta").textContent = `${result.items.length} 个匹配`;
  mountList($("library"), result.items, renderMedia);
}

function renderMedia(media) {
  const flags = [
    media.source,
    `${Math.round(media.durationSeconds / 60)} 分钟`,
    media.watched ? "已看" : null,
    media.favorite ? "收藏" : null
  ].filter(Boolean);
  const { node, actions } = itemShell(media.title, flags.join(" · "));
  const detail = document.createElement("button");
  detail.type = "button";
  detail.textContent = "详情";
  detail.addEventListener("click", () => runAction(() => loadMediaDetail(media.id)));
  const play = document.createElement("button");
  play.type = "button";
  play.textContent = "播放";
  play.addEventListener("click", () => runAction(() => playMedia(media)));
  actions.append(detail, play);
  return node;
}

async function loadMediaDetail(itemId) {
  const result = await api(`/api/library/items/${encodeURIComponent(itemId)}`);
  const media = result.item;
  state.selectedMedia = media;
  $("detailMeta").textContent = media.source;
  $("mediaDetail").replaceChildren(renderMediaDetail(media));
}

function renderMediaDetail(media) {
  const panel = document.createElement("div");
  panel.className = "detail-grid";

  const text = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = media.title;
  const meta = document.createElement("p");
  meta.textContent = [
    media.year,
    media.communityRating ? `${media.communityRating.toFixed(1)} 分` : null,
    media.genres?.join(" / "),
    media.watched ? "已看" : "未看",
    media.favorite ? "已收藏" : null
  ].filter(Boolean).join(" · ");
  const overview = document.createElement("p");
  overview.textContent = media.overview || "暂无简介";
  text.append(title, meta, overview);

  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const watched = document.createElement("button");
  watched.type = "button";
  watched.textContent = media.watched ? "标记未看" : "标记已看";
  watched.addEventListener("click", () => runAction(() => setMediaWatched(media.id, !media.watched)));
  const favorite = document.createElement("button");
  favorite.type = "button";
  favorite.textContent = media.favorite ? "取消收藏" : "收藏";
  favorite.addEventListener("click", () => runAction(() => setMediaFavorite(media.id, !media.favorite)));
  const play = document.createElement("button");
  play.type = "button";
  play.textContent = "播放";
  play.addEventListener("click", () => runAction(() => playMedia(media)));
  actions.append(watched, favorite, play);

  panel.append(text, actions);
  return panel;
}

async function setMediaWatched(itemId, watched) {
  const result = await api(`/api/library/items/${encodeURIComponent(itemId)}/watched`, {
    method: "POST",
    body: { watched }
  });
  $("mediaDetail").replaceChildren(renderMediaDetail(result.item));
  await refreshLibrary();
  await refreshHome();
}

async function setMediaFavorite(itemId, favorite) {
  const result = await api(`/api/library/items/${encodeURIComponent(itemId)}/favorite`, {
    method: "POST",
    body: { favorite }
  });
  $("mediaDetail").replaceChildren(renderMediaDetail(result.item));
  await refreshLibrary();
}

async function playMedia(media) {
  const result = await api("/api/playback/sessions", {
    method: "POST",
    body: { itemId: media.id }
  });
  state.playbackSession = result.session;
  state.selectedMedia = { ...media };
  $("screen").textContent = result.session.title;
  $("playbackMeta").textContent = playbackMeta(result.session);
  const launchUrl = result.session.intent?.uri || result.session.url;
  if (launchUrl && (result.session.mode === "stream-url" || result.session.mode === "intent")) {
    $("streamLink").href = launchUrl;
    $("streamLink").textContent = result.session.mode === "intent" ? "打开外部播放器" : "打开播放流";
    $("streamLink").classList.add("is-visible");
  } else {
    $("streamLink").href = "#";
    $("streamLink").textContent = "打开播放流";
    $("streamLink").classList.remove("is-visible");
  }
  $("watch25").disabled = false;
  $("watch90").disabled = false;
  $("stopPlayback").disabled = false;
  await refreshHistory();
  await refreshLibrary();
}

async function recordWatch(ratio) {
  if (!state.playbackSession) return;
  if (ratio >= 0.9) {
    await stopPlayback(ratio);
    return;
  }

  const duration = state.playbackSession.durationSeconds || 1440;
  const positionSeconds = Math.round(duration * ratio);
  const result = await api(`/api/playback/sessions/${state.playbackSession.id}`, {
    method: "PATCH",
    body: {
      positionSeconds,
      state: ratio >= 0.9 ? "paused" : "playing"
    }
  });
  state.playbackSession = result.session;
  $("playbackMeta").textContent = playbackMeta(result.session);
  await refreshHistory();
  await refreshHome();
  await refreshLibrary();
  if (state.selectedMedia?.id) {
    await loadMediaDetail(state.selectedMedia.id);
  }
}

async function stopPlayback(ratio) {
  if (!state.playbackSession) return;
  const duration = state.playbackSession.durationSeconds || 1440;
  const positionSeconds =
    typeof ratio === "number"
      ? Math.round(duration * ratio)
      : state.playbackSession.positionSeconds || 0;
  const result = await api(`/api/playback/sessions/${state.playbackSession.id}/stop`, {
    method: "POST",
    body: { positionSeconds }
  });
  state.playbackSession = result.session;
  $("playbackMeta").textContent = playbackMeta(result.session);
  $("watch25").disabled = true;
  $("watch90").disabled = true;
  $("stopPlayback").disabled = true;
  await refreshHistory();
  await refreshHome();
  await refreshLibrary();
  if (state.selectedMedia?.id) {
    await loadMediaDetail(state.selectedMedia.id);
  }
}

function playbackMeta(session) {
  return `${session.provider} / ${session.state} / ${Math.round(session.progress * 100)}% / ${formatTime(session.positionSeconds || 0)}`;
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

async function refreshHistory() {
  const result = await api("/api/history");
  $("historyMeta").textContent = String(result.items.length);
  mountList($("history"), result.items, renderHistory);
}

function renderHistory(entry) {
  const percent = Math.round(entry.progress * 100);
  return itemShell(entry.title, `${percent}% · ${new Date(entry.lastWatchedAt).toLocaleString()}`).node;
}

async function boot() {
  $("authForm").addEventListener("submit", (event) => runAction(() => login(event)));
  $("registerBtn").addEventListener("click", () => runAction(register));
  $("settingsForm").addEventListener("submit", (event) => runAction(() => saveSettings(event)));
  $("loginJellyfin").addEventListener("click", () => runAction(loginJellyfin));
  $("loadSettings").addEventListener("click", () => runAction(refreshAll));
  $("syncJellyfin").addEventListener("click", () => runAction(() => syncJellyfin(false)));
  $("scanAndSyncJellyfin").addEventListener("click", () => runAction(() => syncJellyfin(true)));
  $("searchForm").addEventListener("submit", (event) => runAction(() => search(event)));
  $("librarySearchForm").addEventListener("submit", (event) => runAction(() => searchLibrary(event)));
  $("refreshAll").addEventListener("click", () => runAction(refreshAll));
  $("watch25").addEventListener("click", () => runAction(() => recordWatch(0.25)));
  $("watch90").addEventListener("click", () => runAction(() => recordWatch(0.95)));
  $("stopPlayback").addEventListener("click", () => runAction(() => stopPlayback()));

  try {
    const health = await api("/api/health", { headers: {} });
    setStatus(`服务正常 · ${health.version}`);
  } catch {
    setStatus("服务不可用");
  }

  if (state.token) {
    try {
      const me = await api("/api/auth/me");
      $("authState").textContent = `已登录：${me.user.displayName}`;
      await refreshAll();
    } catch {
      localStorage.removeItem("cluo_token");
      state.token = "";
      $("authState").textContent = "未登录";
    }
  }
}

boot().catch((error) => {
  setStatus(error.message);
});
