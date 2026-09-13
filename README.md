# Tibo Reset Watch

Independent, local-first reset alerts for public posts from `@thsottiaux`.

> **Current release:** v0.3 macOS app plus a web/PWA client, a Windows Electron target, and an optional X realtime stream worker. The macOS app, browser client, and Windows packaging are verified; Windows desktop runtime and credentialed X streaming still need their platform checks.

Tibo Reset Watch polls a public reset feed every two minutes, classifies new posts, and shows a native notification for either a likely upcoming reset or a confirmed reset. The same Tibo-only contract powers the macOS app, browser PWA, and Windows shell. It does not require an X, OpenAI, or Telegram login, and it never reads a user's Codex usage.

## What it does

- Shows a small menu-bar bell instead of keeping a browser tab open.
- Accepts only canonical posts authored by `@thsottiaux`; other accounts and non-Tibo events are excluded.
- Shows Tibo's latest accepted timeline post in the menu even when it is unrelated to resets.
- Shows the complete text of accepted posts from the last three days in the web client and labels replies with their target account.
- Separates **possible reset signals** from **confirmed resets**.
- Silently establishes a baseline on first launch, so old posts are never replayed as alerts.
- Lets a signal alert upgrade to a second confirmation alert for the same post.
- Deduplicates locally with `UserDefaults`; no account data is uploaded.
- Retries a failed or stale feed with bounded backoff: 1, 2, 4, 8, then at most 15 minutes.
- Lets you choose between **possible + confirmed** alerts (the default) and **confirmed only** alerts.
- Opens the exact original X post when you click a reset notification or choose **打开原帖**.
- Runs as a static browser PWA with local browser notifications while the page is open.
- Uses the same browser client inside a Windows Electron shell, with NSIS and portable targets.

## Detection policy

| Result | Rule |
| --- | --- |
| Confirmed reset | The feed marks the post `confirmed`, or the text explicitly says usage limits were reset. |
| Possible reset | The post includes reset + Codex/usage context + a future cue such as “in a few hours” or “tomorrow.” |
| Ignore | A clear “no reset,” a joke, or an isolated reference to `reset`. |

The tool is intentionally conservative: it would rather miss ambiguous chatter than send a noisy alert.

## Install and run

Requirements: macOS 13+, Apple Swift 6, and Make.

```sh
git clone https://github.com/Chloride233/tibo-reset-watch.git
cd tibo-reset-watch
make run
```

Allow notifications on the first launch. The bell menu shows the latest Tibo post and its source time, lets you choose an alert condition, and includes **立即检查** and **发送测试通知**. Click **打开最新动态** to open the exact X post. Changing the alert condition only affects future posts; old suppressed signals are not replayed later.

To build and install a daily-use app bundle into `~/Applications`:

```sh
make install
```

This closes and replaces only `~/Applications/Tibo Reset Watch.app`, locally re-signs it, and launches it. It does not add a Login Item automatically. The app is ad-hoc signed rather than notarized with a Developer ID, so only install the bundle you built from source after reviewing it.

For a build artifact without installing it:

```sh
make app
open "dist/Tibo Reset Watch.app"
```

### Web / PWA

The browser client has no build step and reads the public feed directly. You can try the hosted client at <https://chloride233.github.io/tibo-reset-watch/>. Browser notifications are optional and only fire while the page is open.

For local development:

```sh
make web
open http://localhost:8080
```

The page keeps its alert deduplication and alert-mode preference in local storage. The hosted page uses HTTPS, so browser notification permission can be requested there.

To use an official X realtime source, run the optional server-side worker described in [`server/README.md`](server/README.md). It owns the Bearer Token, listens for `from:thsottiaux -is:retweet`, bootstraps the latest timeline, and exposes the same normalized `/api/feed` contract. Point `web/config.js` at that endpoint for the browser/Windows client; point macOS at it with `defaults write local.tibo-reset-notifier feedEndpoint https://your-worker.example.com/api/feed`. The clients never receive the Bearer Token.

### Windows

The Windows target is an Electron wrapper around the same `web/` client. On a machine with Node.js and npm:

```sh
npm install
npm start
npm run windows:build
```

`npm run windows:build` produces NSIS and portable artifacts in `dist-windows/`. GitHub Actions verifies that packaging on `windows-latest`; this macOS workspace has not yet run the installer or a Windows desktop runtime smoke test.

## Data source and limitations

The current source is the independent public endpoint at <https://codex-reset.com/api/feed>, not an OpenAI or X API. The app requires the payload to identify itself as the `thsottiaux` timeline, then accepts only canonical URLs shaped like `x.com/thsottiaux/status/<same-id>`. Tibo's replies and quote-posts qualify when he authored their canonical status URL; posts authored by OpenAI, OpenAI Status, or community accounts do not.

The upstream service says it syncs about every 15 minutes, so this is not a real-time X stream. If the feed is stale, unavailable, or fails the author checks, the app does not invent an alert. Treat the original X post and your Codex client as the source of truth.

This project is independent and is not affiliated with OpenAI, X, or Thibault “Tibo” Sottiaux.

## Development

```sh
make test
make app
npm run web:check
npm run stream:check
```

`make test` is a zero-dependency macOS/core self-check that validates the Tibo timeline identity, canonical post authorship, public feed JSON shape, reset classification, false-positive exclusions, and retry-backoff limits. `npm run web:check` checks the browser and Electron JavaScript syntax. `npm run stream:check` checks the optional Node worker syntax without contacting X.

GitHub Actions runs the macOS self-check, browser/worker checks, and a Windows installer build on every push and pull request.

## Roadmap

- [x] Native macOS menu-bar notifier
- [x] Tibo-only author validation, conservative reset classification, and local deduplication
- [x] Bounded retry backoff, notification deep links, alert preferences, and a local installer
- [x] Browser/PWA client with the same Tibo-only feed contract
- [x] Windows Electron shell and NSIS/portable packaging configuration
- [x] Optional server-side X Filtered Stream worker with a normalized feed endpoint
- [x] Windows installer and portable packaging on Windows CI
- [ ] Windows installer/runtime smoke test on a Windows machine
- [ ] Credentialed X stream integration and deployment validation
- [ ] Optional official X API adapter for lower-latency, independent ingestion

## License

This project is available under the [MIT License](LICENSE).

### 动态分类与历史浏览

顶部按钮支持全部动态、自己发帖、回复他人和类型待确认，同时筛选最新动态、历史动态和 Reset 提醒，不改变通知条件。历史支持全部可用历史与最近 3 天切换，并保留完整原文。新旧记录根据来源的回复标记、回复对象或引用关系分类；回复自己的续帖归入自己发帖，缺少依据的记录标为类型待确认，不根据正文猜测。历史仅限上游当前返回的记录，页面不额外归档。

## 双语内容卡片

最新动态、历史动态和 Reset 提醒均提供“双语内容卡片”入口。展开后选择英文原文或中文与英文对照，可下载 PNG；长帖自动分页，每张标明页码、时间、发帖类型和原帖链接。卡片为文字排版，不是 X 页面截图，不包含原帖媒体。中文带机器翻译标识，并提供可复制的译文。

中文支持公共翻译和 AI 翻译，由使用者在卡片内选择，不自动切换供应商。只有请求中文时才将该公开原文提交给所选服务。公共翻译使用 MyMemory，有每日额度及网络可用性限制；失败会显示原因，不把英文作为中文返回。AI 使用服务器配置的 Chat Completions 兼容接口。密钥不进入网页。

部署完整功能需要 Node.js 22+，运行 `npm run web:serve`，默认地址为 `http://127.0.0.1:8788`。配置见 `server/translation.env.example`；环境变量由运行环境加载，该示例不会自动读取。静态托管仍可生成英文卡片，中文需要把 `web/config.js` 中 `translationEndpoint` 指向同源翻译服务（默认 `/api/translate`）；跨域 API 未开放。

AI 配置项为 `AI_TRANSLATION_URL`（完整接口地址）、`AI_TRANSLATION_MODEL`、`AI_TRANSLATION_API_KEY`（支持无需密钥的内部接口）。配置后重启进程或重建容器。AI 未配置时选择该方式会提示使用公共翻译，不会伪造结果。

翻译服务每次最多处理 24000 字节原文，公共服务按不超过 480 字节分段；总超时 55 秒，并发上限 2，每分钟最多发起 20 次新翻译。相同内容和供应商的并发请求合并，成功译文缓存最多 1000 条；配置 `TRANSLATION_CACHE_DIR` 可跨发布保留。缓存键包括原文和 AI 模型地址，失败不缓存。历史仅覆盖上游当前提供的原文。

93 部署时运行 Node 容器提供静态页面和翻译 API，端口仍为 9093。私有配置文件使用 `/data/tibo-reset-watch/translation.env`，译文缓存使用 `/data/tibo-reset-watch/translations`，发布目录以只读方式挂载；升级时保留旧容器用于回滚。配置文件不要放在发布目录或 Git 仓库内。

接口：`GET /api/translation-status` 返回公共服务支持情况与 AI 是否已配置；`POST /api/translate` 接收 `{ "text": "原文", "provider": "public 或 ai" }`，返回 `{ "text": "译文", "provider": "翻译来源" }`。额度/并发超限为 429，AI 未配置为 503，上游失败为 502，超时为 504。日志仅记录错误状态，不记录密钥或请求正文。

参考：[MyMemory API](https://mymemory.translated.net/doc/spec.php)、[Chat Completions 接口](https://developers.openai.com/api/reference/resources/chat)。

## Cloudflare Pages 免费托管

Pages 版本独立提供网页和同源翻译 API，不调用 93 或云服务器上的服务。原 Node 部署仍可继续使用。

当前访问地址：https://tibo-reset-watch.pages.dev/ 。公共翻译仍受 MyMemory 的供应商额度约束；本地或原服务器翻译成功不代表 Cloudflare 出口有剩余额度，耗尽时返回 429 并显示原因。

在项目目录使用 PowerShell 7 执行 `pwsh.exe -File scripts/build-pages.ps1`，将输出的 ZIP 上传到 Cloudflare Pages 的“直接上传”。每次生成新的临时目录，不清理或覆盖已有发布包。包内只包含网页资产、`_worker.js`、`_routes.json` 和 `_headers`，不上传服务器配置或密钥。更新时在同一个 Pages 项目创建新部署，失败可通过控制台回滚。

`cloudflare/worker.mjs` 适配现有 `/api/translate` 和 `/api/translation-status` 协议。静态资源不消耗函数调用额度；翻译 API 受 Workers 免费配额限制。公共翻译每次最多 45 个分段（每段最多 480 UTF-8 字节），超限明确报错、不截断原文，以适配免费运行时子请求上限。AI 配置项与 Node 版同名，在 Pages 设置中配置，密钥使用 Secret 类型；接口必须可从 Cloudflare 经 HTTPS 访问，配置后重新部署。

成功译文使用单实例最多 1000 条的内存缓存，以及有效期一天、可能提前淘汰的 Cloudflare 边缘缓存。缓存不是持久归档，不同步现有服务器的翻译文件；边缘缓存读写失败会记录不含正文的错误标识，并保留正常翻译能力。并发上限 2、每分钟 20 次的限制及相同请求合并仅作用于单个 Worker 实例，不是全站严格限额。需要全站配额时应另行配置 Durable Objects 或平台限流。
