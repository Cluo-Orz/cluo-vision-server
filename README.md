# Cluo Vision Server

家庭影院服务端，基于 Docker Compose 一键部署。

> 当前 `docker-compose.yml` 已包含 `cluo-server` BFF 和番剧主链路依赖服务。注册登录、番剧发现/订阅、下载队列、Jellyfin 媒体库、播放解析、观看历史这些核心 API 已可本地验证；真实 Docker 环境、真实媒体库和电视端播放器拉起仍需要在目标机器上做部署验收。

## 服务栈

| 服务 | 端口 | 说明 |
|------|------|------|
| **Caddy** | 80/443 | 反向代理 + HTTPS |
| **cluo-server** | 3000 | Cluo BFF / API 聚合层 / Dev UI |
| **Jellyfin** | 8096 | 媒体服务器（刮削、转码、播放） |
| **Jellyseerr** | 5055 | 媒体请求与发现 |
| **Sonarr** | 8989 | 电视剧自动下载管理 |
| **Radarr** | 7878 | 电影自动下载管理 |
| **Prowlarr** | 9696 | BT/PT 索引器管理 |
| **qBittorrent** | 8080 | BT/PT 下载客户端 |
| **Bazarr** | 6767 | 字幕自动下载 |
| **AutoBangumi** | 7892 | 动漫自动追番 |
| **FlareSolverr** | 8191 | 绕过 Cloudflare 防护 |

## 本地 BFF 开发

如不使用 Docker，可直接运行 `server/` 在本机调试核心 API：

```bash
cd server
npm install --registry=https://registry.npmmirror.com
npm test
npm run dev
```

本地 BFF 启动时会自动读取 `server/.env` 和仓库根目录 `.env`，系统环境变量优先。

详见 [`server/README.md`](server/README.md)。

## 快速开始

### 前置条件

- Docker Engine 24+
- NAS 存储已挂载（默认路径 `/nas/media`）
- Intel 核显（可选，用于硬件转码）

### 1. 准备目录

```bash
# 创建 NAS 媒体目录
mkdir -p /nas/media/{movies,tv,anime,downloads/complete,downloads/incomplete}

# 克隆仓库
git clone <repo-url> cluo-vision-server
cd cluo-vision-server
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，修改 MEDIA_ROOT 为你的 NAS 路径
```

### 3. 启动

```bash
docker compose up -d
```

启动后先检查 BFF：

```bash
curl http://<server-ip>:3000/api/health
```

Flutter/Android 客户端的服务端地址填写：

```text
http://<server-ip>:3000
```

如果使用 Caddy 的 HTTPS 入口，API 也会被代理到：

```text
https://<server-ip>/api
```

### 4. 初始化各服务

启动后按顺序配置：

1. **cluo-server** — `http://<ip>:3000` — 打开 Dev UI，注册 Cluo 管理员账号
2. **Jellyfin** — `http://<ip>:8096` — 创建管理员账号，添加媒体库
3. **qBittorrent** — `http://<ip>:8080` — 初始密码以容器日志/首次启动提示为准，登录后立即修改密码
4. **AutoBangumi** — `http://<ip>:7892` — 配置蜜柑计划 RSS，连接 qBittorrent
5. **cluo-server 设置页** — 登录 Jellyfin，配置 qBittorrent 密码，确认系统诊断为 ready
6. **Prowlarr** — `http://<ip>:9696` — 添加 BT/PT 索引器，配置 FlareSolverr (`http://flaresolverr:8191`)
7. **Sonarr** — `http://<ip>:8989` — 添加下载客户端 (qBittorrent)，添加 root 文件夹
8. **Radarr** — `http://<ip>:7878` — 同上
9. **Jellyseerr** — `http://<ip>:5055` — 连接 Jellyfin + Sonarr + Radarr
10. **Bazarr** — `http://<ip>:6767` — 连接 Sonarr + Radarr，配置字幕源

### 5. 连接 Prowlarr → Sonarr/Radarr

在 Prowlarr → Settings → Apps 中添加：
- Sonarr (API Key 从 Sonarr → Settings → General 获取)
- Radarr (API Key 从 Radarr → Settings → General 获取)

这样 Prowlarr 的索引器会自动同步到 Sonarr/Radarr。

## 硬件转码

如果 Linux 有 Intel 核显，Jellyfin 可开启硬件转码：

```bash
# 确认 /dev/dri 存在
ls /dev/dri
# 应该看到 renderD128, card0 等
```

Jellyfin → 控制台 → 播放 → 硬件加速 → 选择 "Intel QuickSync (QSV)" 或 "VA-API"。

## 目录结构

```
cluo-vision-server/
├── docker-compose.yml      # 完整服务编排
├── .env.example            # 环境变量模板
├── .gitignore
├── caddy/
│   └── Caddyfile           # 反向代理配置
├── server/                 # cluo-server (BFF / API 聚合层，番剧主链路已可本地验证)
└── README.md
```

Docker 挂载的运行时数据（自动生成，已 gitignore）：
```
├── jellyfin/config/        # Jellyfin 配置
├── sonarr/config/          # Sonarr 配置
├── radarr/config/          # Radarr 配置
├── prowlarr/config/        # Prowlarr 配置
├── qbittorrent/config/     # qBittorrent 配置
├── bazarr/config/          # Bazarr 配置
├── jellyseerr/config/      # Jellyseerr 配置
├── autobangumi/config/     # AutoBangumi 配置
└── caddy/data/             # Caddy 证书/数据
```

## NAS 媒体库规划

```
/nas/media/
├── movies/                 # 电影 (Radarr 管理)
│   ├── 流浪地球2 (2023)/
│   │   └── 流浪地球2 (2023) - 4K.mkv
│   └── ...
├── tv/                     # 电视剧 (Sonarr 管理)
│   ├── 庆余年/
│   │   └── Season 2/
│   │       └── 庆余年 - S02E01.mkv
│   └── ...
├── anime/                  # 动漫 (AutoBangumi 管理)
│   ├── 迷宫饭/
│   │   └── Season 1/
│   │       └── 迷宫饭 - 01.mkv
│   └── ...
└── downloads/              # BT/PT 下载目录
    ├── complete/           # 已完成 (可做种)
    └── incomplete/         # 下载中
```

## 常用命令

```bash
# 启动全部服务
docker compose up -d

# 查看日志
docker compose logs -f
docker compose logs -f cluo-server

# 重启单个服务
docker compose restart jellyfin

# 更新镜像
docker compose pull
docker compose up -d

# 停止全部
docker compose down

# 清理 (危险！会删除容器和网络，但保留数据卷)
docker compose down --volumes  # 谨慎使用
```
