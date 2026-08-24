# Crypto Dashboard (Cloudflare + GitHub Actions)

原仓库 `../crypto-dashboard` 的云端版。本地 Node 项目保持不变。

**方案 2：** GitHub Actions 当免费定时后台（约每 15 分钟扫一次），Cloudflare Worker 只存结果、出页面。打开就能看，不必等 Worker 自己扫，也少挨 CoinGecko 对机房 IP 的 429。

线上地址：https://crypto-dashboard.lansehuiyi6.workers.dev

## 怎么跑起来

### 1. 部署 Worker（已做过可跳过）

```bash
cd crypto-dashboard-cf
npm install
npx wrangler login
npx wrangler secret put CRON_SECRET
# 粘贴一段随机密钥，例如: openssl rand -hex 32
npm run deploy
```

### 2. 推到 GitHub 并打开 Actions

本目录需要是一个 GitHub 仓库（可私有）。

```bash
cd crypto-dashboard-cf
git init
git add .
git commit -m "Cloudflare dashboard with GitHub Actions scan"
# 在 GitHub 网页新建空仓库后：
git remote add origin https://github.com/<你的用户名>/crypto-dashboard-cf.git
git branch -M main
git push -u origin main
```

在仓库 **Settings → Secrets and variables → Actions** 添加：

| Name | Value |
|------|--------|
| `WORKER_URL` | `https://crypto-dashboard.lansehuiyi6.workers.dev` |
| `CRON_SECRET` | 与 `wrangler secret put CRON_SECRET` 相同的那串密钥 |

打开 **Actions** 页，选 **Scan and push** → **Run workflow**。第一次建议手动跑一次，之后每 15 分钟自动跑。

GitHub 免费公开仓库的定时任务最稳；私有仓库每月有约 2000 分钟，这个任务每次大约 1～3 分钟，够用。

### 3. 本机立刻推一版（可选）

不用等 Actions，也可以在自己电脑上扫一次：

```bash
export WORKER_URL=https://crypto-dashboard.lansehuiyi6.workers.dev
export CRON_SECRET='你的密钥'
npm run scan
```

## 数据流

```
GitHub Actions (每 15 分钟)
  → 拉 CoinGecko / ValueScan / 黄金
  → 算信号、写生命周期
  → POST /api/ingest  (Bearer CRON_SECRET)
Cloudflare Worker
  → Durable Object 存历史和快照
  → 页面只读缓存（价格、策略、信号）
```

打开页面 **不会** 再触发 Cloudflare 自己去扫。没跑过 Actions 时，信号区会显示「等待定时扫描」。

## 本地预览

```bash
npm run dev
# 另开终端
WORKER_URL=http://127.0.0.1:8787 CRON_SECRET=dev npm run scan
```

本地 `wrangler dev` 要把同一个 `CRON_SECRET` 写进 `.dev.vars`：

```
CRON_SECRET=dev
```

## API

| 路径 | 说明 |
|------|------|
| `POST /api/ingest` | Actions 推送（需密钥） |
| `/api/coingecko/prices` | 优先读 Actions 快照 |
| `/api/gold/spot` | 优先读快照 |
| `/api/valuescan/*` | 优先读快照 |
| `/api/signals` | 读已发布信号 |
| `/api/market-signals` | 短线操作面板（支撑/阻力随现价生成） |

## 注意事项

- `CRON_SECRET` 不要提交进 Git。
- CoinGecko 免费接口仍可能 429；脚本会重试。失败时页面继续显示上一份快照。
- 改完 Worker 代码后：`npm run deploy`。只改扫描脚本：push 到 GitHub 即可。
