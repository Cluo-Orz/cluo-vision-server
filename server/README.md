# cluo-server

Cluo Vision 的本地 BFF/API 聚合层。当前阶段先服务番剧主链路：

- 注册 / 登录
- 番剧搜索
- 番剧订阅并生成下载任务
- 下载完成后进入本地媒体库
- 解析播放目标
- 记录观看历史和首页继续观看

没有 Docker、Jellyfin、AutoBangumi 或 qBittorrent 时，服务会使用 `local-dev` provider 跑通主流程。配置 AutoBangumi 后，搜索和 RSS 订阅会优先尝试真实 AutoBangumi API，失败时回退到本地 provider。配置 qBittorrent 后，下载列表会合并真实队列，并可暂停/恢复远端任务。配置 Jellyfin 后，带有 Jellyfin 映射的媒体条目可以解析为真实 `stream-url`；选择 `external-player` 时会把同一个 Jellyfin 流包装成 Android `ACTION_VIEW` intent。相关播放 session 会同步开始、进度和停止事件。

当前适配已按 AutoBangumi 源码核对：

- 搜索：`GET /api/v1/search/bangumi?site=<provider>&keywords=<keyword>`，返回 SSE。
- 订阅：`POST /api/v1/rss/subscribe`，请求体为 `{ "data": <Bangumi>, "rss": <RSS> }`。
- 规则：`GET /api/v1/bangumi/get/all`。
- RSS：`GET /api/v1/rss`。
- 种子：`GET /api/v1/downloader/torrents`。
- 状态：`GET /api/v1/status`。
- 认证：如 AutoBangumi 开启鉴权，使用 `Authorization: Bearer <AUTO_BANGUMI_TOKEN>`。

当前 Jellyfin 适配覆盖播放最小闭环：

- 登录配置：`POST /Users/AuthenticateByName`，用 Jellyfin 用户名/密码换取 access token 和 userId；密码不落库。
- 媒体库同步：`GET /Users/{userId}/Items`，按 Episode 拉取 Jellyfin 条目并 upsert 到 Cluo 媒体库。
- 搜索和详情：按关键字查询 Jellyfin Episode，详情读取 `/Users/{userId}/Items/{itemId}`。
- 继续观看：`GET /UserItems/Resume`，首页优先使用 Jellyfin 的播放进度。
- 用户状态：通过 `/Users/{userId}/PlayedItems/{itemId}` 和 `/Users/{userId}/FavoriteItems/{itemId}` 同步已看和收藏。
- 播放信息：`POST /Items/{itemId}/PlaybackInfo`，获取 `PlaySessionId`、`MediaSourceId`、容器和时长。
- 视频流：生成 `/Videos/{itemId}/stream.{container}` URL，携带 `mediaSourceId`、`playSessionId`、`deviceId` 和 token。
- 播放上报：`POST /Sessions/Playing`、`/Sessions/Playing/Progress`、`/Sessions/Playing/Stopped`。
- ID 边界：Cluo 本地历史继续使用本地 `itemId`，Jellyfin 上报使用 `externalItemId`。

当前 qBittorrent 适配覆盖下载管理闭环：

- 队列：`GET /api/v2/torrents/info`，映射为统一 `DownloadTask`。
- 控制：优先调用 qBittorrent v5 `stop` / `start`，失败后回退旧版 `pause` / `resume`。
- 认证：支持 WebUI 用户名/密码登录，也支持 qBittorrent v5.2+ API key。

## 本地开发

```bash
cd cluo-vision-server/server
npm install --registry=https://registry.npmmirror.com
cp .env.example .env
npm run dev
```

`npm run dev`、`npm start` 和 `npm run smoke:services` 会自动读取 `server/.env` 和上一层目录的 `.env`。系统环境变量优先级最高，不会被 `.env` 覆盖；如果两个 `.env` 都存在，`server/.env` 的值优先。

默认监听：

```text
http://127.0.0.1:3000
```

打开浏览器访问同一地址可使用 Web Dev UI 跑通主链路。当前 Dev UI 支持：

- 注册 / 登录
- 配置 AutoBangumi、qBittorrent、Jellyfin 和首选播放 Provider；Jellyfin 可用用户名/密码登录一次自动写入 token/userId
- 查看 AutoBangumi、qBittorrent、Jellyfin、后台入库自动化和 Playback Provider 的连接诊断
- 搜索番剧、订阅、查看下载进度、暂停/恢复下载
- 对已完成下载执行入库：触发 Jellyfin 扫描，并按下载标题同步匹配到的 Episode
- 查看 AutoBangumi 状态和订阅规则
- 同步 Jellyfin Episode 到 Cluo 媒体库
- 触发 Jellyfin 扫描并同步媒体库
- 按全部/续播/未看/已看/收藏筛选媒体库，搜索媒体库、查看详情、标记已看和收藏
- 创建播放 session，Jellyfin `stream-url` session 会显示可打开的播放流，`external-player` session 会显示 Android intent URI
- 记录播放进度和查看历史

## Docker 部署

仓库根目录的 `docker-compose.yml` 已包含 `cluo-server` 服务：

```bash
cd cluo-vision-server
docker compose up -d cluo-server
```

容器镜像使用 `npm run build` 生成的 `dist/src/index.js` 启动，并把运行数据写入 `/data`。根目录 `.env.example` 里的 `CLUO_AUTO_BANGUMI_URL`、`CLUO_QBITTORRENT_URL`、`CLUO_JELLYFIN_URL` 是 Docker 网络内地址，compose 会分别映射成 BFF 运行时实际读取的 `AUTO_BANGUMI_URL`、`QBITTORRENT_URL`、`JELLYFIN_URL`。如果直接在宿主机运行 `npm run dev` 或 `npm start`，则继续使用本文件环境变量表里的原始变量名。

容器启动后检查：

```bash
curl http://<server-ip>:3000/api/health
docker compose logs -f cluo-server
```

验证：

```bash
npm run typecheck
npm test
npm run smoke:main
npm run smoke:services
curl --noproxy "*" http://127.0.0.1:3000/api/health
```

`npm run smoke:main` 会启动一个随机端口的临时 BFF，使用临时 JSON 数据文件，通过真实 HTTP 请求跑完注册、登录、统一发现、番剧订阅、下载暂停/恢复、完成下载、入库、播放 session、续播、历史记录和首页。

`npm run smoke:services` 会读取当前环境变量，非破坏性检查已配置的真实 AutoBangumi、qBittorrent 和 Jellyfin：状态/搜索/规则/队列、版本/队列、健康/搜索/继续观看；同时校验下载入库自动化的启用状态、轮询间隔和重试间隔。未配置的真实服务默认跳过；设置 `CLUO_REAL_SMOKE_REQUIRE=1` 时，如果一个真实外部服务都没有配置会失败，适合部署验收。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `3000` | 监听端口 |
| `CLUO_DATA_DIR` | `./data` | JSON 数据文件目录 |
| `CLUO_TOKEN_SECRET` | dev fallback | Token 签名密钥，正式部署必须修改 |
| `CLUO_TOKEN_TTL_SECONDS` | `1209600` | 登录 token 有效期 |
| `CLUO_DOWNLOAD_SIMULATION_MS` | `1000` | local-dev 下载模拟耗时 |
| `CLUO_DOWNLOAD_IMPORT_AUTOMATION_ENABLED` | `true` | 是否由 cluo-server 后台自动导入 completed 下载 |
| `CLUO_DOWNLOAD_IMPORT_AUTOMATION_INTERVAL_MS` | `60000` | completed 下载自动入库轮询间隔 |
| `CLUO_DOWNLOAD_IMPORT_AUTOMATION_RETRY_MS` | `120000` | `pending-scan` / 未配置等未成功导入状态的重试间隔 |
| `AUTO_BANGUMI_URL` | 空 | AutoBangumi 地址，例如 `http://127.0.0.1:7892` |
| `AUTO_BANGUMI_TOKEN` | 空 | AutoBangumi token，如实例开启鉴权 |
| `AUTO_BANGUMI_PROVIDER` | `mikan` | 默认番剧搜索 provider |
| `CLUO_SMOKE_ANIME_QUERY` | `迷宫饭` | `smoke:services` 检查 AutoBangumi 搜索时使用的关键词 |
| `QBITTORRENT_URL` | 空 | qBittorrent WebUI 地址，例如 `http://127.0.0.1:8080` |
| `QBITTORRENT_USERNAME` | 空 | qBittorrent WebUI 用户名 |
| `QBITTORRENT_PASSWORD` | 空 | qBittorrent WebUI 密码 |
| `QBITTORRENT_API_KEY` | 空 | qBittorrent v5.2+ API key，可替代用户名/密码 |
| `JELLYFIN_URL` | 空 | Jellyfin 地址，例如 `http://127.0.0.1:8096` |
| `JELLYFIN_TOKEN` | 空 | Jellyfin API token |
| `JELLYFIN_USER_ID` | 空 | Jellyfin 用户 id，用于 PlaybackInfo 查询 |
| `JELLYFIN_USERNAME` | 空 | 仅用于 `smoke:services` 临时登录换 token，不落库 |
| `JELLYFIN_PASSWORD` | 空 | 仅用于 `smoke:services` 临时登录换 token，不落库 |
| `JELLYFIN_DEVICE_ID` | `cluo-server-dev` | Cluo 作为 Jellyfin client 的设备 id |
| `CLUO_SMOKE_JELLYFIN_SEARCH` | `迷宫` | `smoke:services` 检查 Jellyfin Episode 搜索时使用的关键词 |
| `CLUO_REAL_SMOKE_REQUIRE` | 空 | 设置为 `1` 时，`smoke:services` 要求至少一个真实服务已配置 |
| `PLAYBACK_PROVIDER` | `local-dev` | 默认播放 provider，可选 `local-dev`、`jellyfin`、`external-player`、`kodi` |
| `PLAYBACK_EXTERNAL_PLAYER_PACKAGE` | 空 | Android 外部播放器包名；留空则由系统选择可处理 `video/*` 的 App |
| `PLAYBACK_EXTERNAL_PLAYER_MIME_TYPE` | `video/*` | external-player intent 的 MIME type |

## 主链路 API

### 注册

```http
POST /api/auth/register
Content-Type: application/json

{
  "username": "owner",
  "password": "change-me",
  "displayName": "Owner"
}
```

返回 `token`。后续请求使用：

```http
Authorization: Bearer <token>
```

### 搜索番剧

统一发现搜索会同时查本地/Jellyfin 媒体库和 AutoBangumi 番剧结果，并记录当前用户的最近搜索，适合电视端一个入口完成“已有就播放、没有就订阅”：

```http
GET /api/discover/search?q=迷宫&limit=12
Authorization: Bearer <token>
```

最近搜索：

```http
GET /api/discover/recent
Authorization: Bearer <token>
```

推荐入口：

```http
GET /api/discover/trending
Authorization: Bearer <token>
```

当前返回基于本地事实源生成的电视端快捷入口：最近入库、活跃下载、订阅番剧、最近搜索；如果这些都为空，会返回 local-dev 番剧起步推荐。它不是外部站点热门榜，不会额外访问未验证资源站。

已接入来源和能力：

```http
GET /api/discover/sources
Authorization: Bearer <token>
```

返回当前配置下可用于找片、下载和播放的入口，例如 Jellyfin 媒体库、AutoBangumi 番剧、qBittorrent 下载器、当前播放 Provider 和 local-dev 回退。该接口只说明“已接入/已配置”的能力，不替代 `/api/system/status` 的真实连通性诊断。

保留直接番剧搜索入口：

```http
GET /api/anime/search?q=迷宫
Authorization: Bearer <token>
```

### 订阅并生成下载任务

```http
POST /api/anime/subscribe
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "迷宫饭",
  "provider": "local-dev",
  "rssUrl": "mock://rss/delicious-in-dungeon"
}
```

如果订阅来自真实 AutoBangumi 搜索结果，App 应把搜索结果里的 `raw` 原样回传为 `autoBangumi`，BFF 会把它转换成 AutoBangumi 的 `Bangumi` 请求体：

```json
{
  "title": "迷宫饭",
  "provider": "mikan",
  "rssUrl": "https://mikanani.me/RSS/Bangumi?bangumiId=3022",
  "autoBangumi": {
    "id": 0,
    "official_title": "迷宫饭",
    "title_raw": "Dungeon Meshi",
    "rss_link": "https://mikanani.me/RSS/Bangumi?bangumiId=3022",
    "filter": "1080p,CHS"
  }
}
```

真实 AutoBangumi 订阅成功后，BFF 会先创建一个 `source: "autobangumi"`、`state: "queued"` 的占位下载任务；它只表示已交给 AutoBangumi/RSS 规则，等待远端下载器队列出现。这个占位任务不会被本地模拟进度推进，也不会生成本地媒体。AutoBangumi 订阅失败时，BFF 会创建 `local-dev` 回退任务，保证本地开发仍可验证下载到播放闭环。

### 查看下载

```http
GET /api/anime/downloads
Authorization: Bearer <token>
```

通用下载入口：

```http
GET /api/downloads
Authorization: Bearer <token>
```

如果配置了 AutoBangumi，BFF 会合并 `GET /api/v1/downloader/torrents` 返回的真实下载状态；如果配置了 qBittorrent，也会合并 `GET /api/v2/torrents/info` 返回的队列。相同 hash 会去重，AutoBangumi 语义优先。

暂停下载：

```http
POST /api/downloads/<download id>/pause
Authorization: Bearer <token>
```

恢复下载：

```http
POST /api/downloads/<download id>/resume
Authorization: Bearer <token>
```

`local-dev` 任务会在本地模拟暂停/恢复。远端任务需要配置 qBittorrent，`download id` 通常是 torrent hash。

本地开发可以直接完成下载：

```http
POST /api/anime/downloads/:id/complete
Authorization: Bearer <token>
```

本地完成下载只适用于 `local-dev` 模拟任务；AutoBangumi/qBittorrent 远端任务不能通过这个接口强制完成，调用会返回 `400`。
响应会返回生成的 `mediaItems`，客户端可以直接跳到详情页播放，不必再让用户去媒体库里找。

导入已完成下载到媒体库：

```http
POST /api/downloads/<download id>/import
Authorization: Bearer <token>
```

批量导入所有已完成下载：

```http
POST /api/downloads/import-completed
Authorization: Bearer <token>
```

批量入口会跳过未完成任务，并为每个已完成任务执行与单任务入库相同的 Jellyfin 扫描和候选词匹配，返回 `total`、`imported`、`pending`、`failed`、`synced`、`items` 和逐项 `results`。

cluo-server 默认还会在后台按 `CLUO_DOWNLOAD_IMPORT_AUTOMATION_INTERVAL_MS` 轮询 completed 下载并自动执行同样的入库逻辑；成功导入后不会重复处理，`pending-scan` 或 `not-configured` 会按 `CLUO_DOWNLOAD_IMPORT_AUTOMATION_RETRY_MS` 节流重试。`/api/system/status` 会暴露 `download-automation` 诊断项，部署时可直接确认自动入库是否启用、轮询间隔和重试间隔是否有效。部署验收时也可以手动触发一次后台自动化：

```http
POST /api/automation/download-import/run
Authorization: Bearer <token>
```

导入入口只接受 `completed` 状态的任务。配置 Jellyfin 后，BFF 会先触发 `POST /Library/Refresh`，再用下载标题查询 Jellyfin Episode 并同步匹配结果；如果是本地开发任务且已经生成本地媒体条目，即使未配置 Jellyfin 也会返回已存在的本地条目。Jellyfin 扫描是异步过程，刚下载完成的大文件可能需要稍后再点一次入库或执行全库同步。

入库响应会包含 `status`、`searchTerms` 和 `message`：

- `imported`：已匹配到 Jellyfin 条目并写入 Cluo 媒体库。
- `pending-scan`：已触发 Jellyfin 扫描，但暂未匹配到条目；稍后重试同一入口。
- `local-only`：未配置 Jellyfin，但本地开发任务已有本地媒体条目。
- `not-configured`：远端完成任务无法在未配置 Jellyfin 时入库。

BFF 会从真实种子名里生成多个 Jellyfin 搜索候选，例如去掉字幕组、分辨率、编码标签和集数，并拆分 `迷宫饭 / Dungeon Meshi` 这类中英文标题，降低 AutoBangumi/qBittorrent 完成任务入库失败的概率。

### AutoBangumi 状态和规则

```http
GET /api/anime/status
Authorization: Bearer <token>
```

返回 AutoBangumi 是否已配置、是否可连接，以及原始状态对象。

```http
GET /api/anime/rules
Authorization: Bearer <token>
```

返回 Cluo 归一化后的追番规则；连接 AutoBangumi 时来自 `/api/v1/bangumi/get/all`，未配置或远端失败时回退到本地订阅记录。

```http
GET /api/anime/rss
Authorization: Bearer <token>
```

返回 AutoBangumi RSS 列表；未配置时返回空列表。

### 查看媒体库

```http
GET /api/library/items?limit=100&status=all
Authorization: Bearer <token>
```

配置 Jellyfin 时会实时查询 Jellyfin Episode 并 upsert 到本地缓存；Jellyfin 暂时不可达时回退到本地缓存。未配置 Jellyfin 时只返回本地 `local-dev` 或已同步条目。

`status` 可选值为 `all`、`continue`、`unwatched`、`watched`、`favorite`，默认 `all`。非 `all` 筛选会在 Jellyfin/本地返回条目之后按 Cluo 归一化字段过滤，用于电视端媒体库快速切换“续播、未看、已看、收藏”。

同步 Jellyfin Episode 到 Cluo 媒体库：

```http
POST /api/library/sync/jellyfin
Authorization: Bearer <token>
Content-Type: application/json

{
  "searchTerm": "迷宫",
  "limit": 100,
  "scan": true
}
```

`scan: true` 会先调用 Jellyfin `POST /Library/Refresh` 触发全库扫描，再执行当前查询同步。Jellyfin 扫描是异步过程，返回里的 `scanTriggered` 只表示已触发扫描，不表示扫描已经完成。

返回的条目使用本地 id，例如 `jellyfin:<item id>`；播放、历史记录和首页都使用这个本地 id。Jellyfin 的真实 id 存在 `jellyfin.itemId` 和 playback session 的 `externalItemId`。

搜索媒体库：

```http
GET /api/library/search?q=迷宫&limit=50&status=all
Authorization: Bearer <token>
```

配置 Jellyfin 时会透传到 Jellyfin Episode 搜索，并把返回条目 upsert 到 Cluo 媒体库；未配置 Jellyfin 时搜索本地已同步条目。`status` 含义与媒体库列表一致。

查看单个媒体详情：

```http
GET /api/library/items/<media item id>
Authorization: Bearer <token>
```

Jellyfin 条目会读取最新详情和 `UserData`，返回 `overview`、`genres`、`year`、`communityRating`、`playbackPositionSeconds`、`watched`、`favorite` 等字段。

相关推荐：

```http
GET /api/library/items/<media item id>/related?limit=8
Authorization: Bearer <token>
```

相关推荐基于已同步/本地缓存的媒体库生成，同一番剧优先，其次按类型、标签和最近入库排序；不会访问额外外部推荐服务。

标记已看：

```http
POST /api/library/items/<media item id>/watched
Authorization: Bearer <token>
Content-Type: application/json

{
  "watched": true
}
```

标记收藏：

```http
POST /api/library/items/<media item id>/favorite
Authorization: Bearer <token>
Content-Type: application/json

{
  "favorite": true
}
```

### 播放 Provider

```http
GET /api/playback/providers
Authorization: Bearer <token>
```

返回当前首选 provider 和可用 provider 列表。当前可用性规则：

- `local-dev` 总是可用，用于开发模拟播放。
- `jellyfin` 需要配置 `JELLYFIN_URL` 和 `JELLYFIN_TOKEN`，返回 `stream-url`。
- `external-player` 需要配置 Jellyfin，返回 Android `ACTION_VIEW` intent，数据源是 Jellyfin `stream-url`。
- `kodi` 已预留接口，但仍需 Kodi 实机 POC 后启用。

### 解析播放目标

```http
POST /api/playback/resolve
Authorization: Bearer <token>
Content-Type: application/json

{
  "itemId": "<media item id>"
}
```

`local-dev` 返回 `mock-stream`，用于本地开发。配置 Jellyfin 且媒体条目含 `jellyfin.itemId` 或 `source: "jellyfin"` 时，返回：

```json
{
  "target": {
    "provider": "jellyfin",
    "mode": "stream-url",
    "itemId": "<cluo media item id>",
    "externalItemId": "<jellyfin item id>",
    "url": "http://127.0.0.1:8096/Videos/<jellyfin item id>/stream.mkv?...",
    "mediaSourceId": "<jellyfin media source id>",
    "externalPlaySessionId": "<jellyfin play session id>"
  }
}
```

当首选 provider 为 `external-player` 时，返回的 `target` 会保留同一个 `url`，并额外包含：

```json
{
  "target": {
    "provider": "external-player",
    "mode": "intent",
    "intent": {
      "action": "android.intent.action.VIEW",
      "data": "http://127.0.0.1:8096/Videos/<jellyfin item id>/stream.mkv?...",
      "type": "video/*",
      "packageName": "is.xyz.mpv",
      "uri": "intent://127.0.0.1:8096/Videos/<jellyfin item id>/stream.mkv?...#Intent;scheme=http;action=android.intent.action.VIEW;type=video%2F*;package=is.xyz.mpv;end"
    }
  }
}
```

`packageName` 可为空；为空时 Android 会按 MIME type 选择可用播放器。

### 播放会话

正式播放流程从创建 session 开始；session 心跳会自动更新观看历史。
创建 session 时，BFF 会优先读取当前用户未完成的本地历史，其次读取 Jellyfin 条目的 `playbackPositionSeconds`，并把该位置传给 Jellyfin `PlaybackInfo`；已完成历史不会用于续播。

```http
POST /api/playback/sessions
Authorization: Bearer <token>
Content-Type: application/json

{
  "itemId": "<media item id>"
}
```

更新播放进度：

```http
PATCH /api/playback/sessions/<session id>
Authorization: Bearer <token>
Content-Type: application/json

{
  "positionSeconds": 600,
  "state": "playing"
}
```

停止播放：

```http
POST /api/playback/sessions/<session id>/stop
Authorization: Bearer <token>
Content-Type: application/json

{
  "positionSeconds": 900
}
```

当进度达到 90% 以上，session 和历史记录会标记为 completed。
客户端的“标记看完”应调用 stop 接口并传入 90% 以上的位置，这样 Jellyfin 也能收到 stopped 上报；普通进度更新只用于播放中/暂停状态。

播放开始、心跳和停止会同步更新本地媒体条目的 `playbackPositionSeconds`；当进度达到 90% 以上时，本地媒体条目也会标记为 `watched: true`。如果 session 使用 Jellyfin 作为上报目标（包括 `jellyfin` 和基于 Jellyfin URL 的 `external-player`），BFF 会把开始、心跳、停止同步给 Jellyfin。Jellyfin 上报失败不会回滚本地 session、媒体库缓存或历史记录。

### 服务设置

查看系统诊断：

```http
GET /api/system/status
Authorization: Bearer <token>
```

返回 `cluo-server`、`AutoBangumi`、`qBittorrent`、`Jellyfin`、`download-automation` 和 `Playback` 的统一状态。状态值：

- `ready`：已配置且可用。
- `not-configured`：未配置，相关真实链路不可用，但本地开发回退可能仍可用。
- `unreachable`：已配置但连接失败。
- `degraded`：部分可用，例如 Jellyfin 缺少 `userId`、下载入库自动化被关闭/配置无效，或选择了尚未完成 POC 的播放 Provider（如 Kodi）。

诊断响应不会返回任何 token。

Jellyfin 登录并保存 token/userId：

```http
POST /api/settings/jellyfin/login
Authorization: Bearer <token>
Content-Type: application/json

{
  "baseUrl": "http://127.0.0.1:8096",
  "username": "owner",
  "password": "<jellyfin password>",
  "deviceId": "cluo-server-dev"
}
```

这个接口会调用 Jellyfin `/Users/AuthenticateByName`，只保存返回的 access token 和 userId，不保存 Jellyfin 密码。响应只返回 `tokenConfigured: true`，不会回显 token。

```http
GET /api/settings/services
Authorization: Bearer <token>
```

返回 token 是否已配置，不返回 token 原文。

```http
PATCH /api/settings/services
Authorization: Bearer <token>
Content-Type: application/json

{
  "playback": {
    "preferredProvider": "jellyfin"
  },
  "qBittorrent": {
    "baseUrl": "http://127.0.0.1:8080",
    "username": "admin",
    "password": "<qbittorrent webui password>",
    "apiKey": "<optional api key>"
  },
  "jellyfin": {
    "baseUrl": "http://127.0.0.1:8096",
    "token": "<jellyfin api token>",
    "userId": "<jellyfin user id>",
    "deviceId": "cluo-server-dev"
  }
}
```

### 记录观看历史

```http
POST /api/history/events
Authorization: Bearer <token>
Content-Type: application/json

{
  "itemId": "<media item id>",
  "title": "迷宫饭 - S01E01",
  "type": "anime-episode",
  "positionSeconds": 600,
  "durationSeconds": 1440
}
```

### 首页

```http
GET /api/home
Authorization: Bearer <token>
```

返回继续观看、最近添加和下载中任务。

配置 Jellyfin 时，`continueWatching` 优先来自 Jellyfin `/UserItems/Resume`，保证继续观看、已看状态和多端进度以 Jellyfin 为准；Jellyfin 不可用时回退到 Cluo 本地历史。

## 当前限制

- `local-dev` 播放目标不是实际视频流，只用于先打通 API 和 App 状态机。
- Jellyfin Episode 实时列表、同步、搜索、详情、继续观看、已看/收藏、全库扫描触发、播放解析、播放进度上报和健康诊断已接入；还没有做 Jellyfin 后台定时扫描。
- AutoBangumi 搜索、订阅、状态、规则、RSS 和下载状态代理已接入；qBittorrent 队列、暂停和恢复已接入；已提供 `npm run smoke:services` 做真实实例兼容性检查，但当前机器还没有连接真实实例跑端到端验收。
- `external-player` 已能生成标准 Android intent 目标；Flutter Android 平台通道和 debug APK 构建已通过，本地仍缺电视实机上的播放器拉起与进度回写验证。
- 历史记录当前存 JSON 文件，适合单机开发；后续可迁移 SQLite。
- 电影/电视剧的 Seerr/Sonarr/Radarr 适配还未实现，本阶段先推进番剧主链路。
