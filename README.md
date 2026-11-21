# Tibo Reset Watch

Independent, local-first reset alerts for public posts from `@thsottiaux`.

> **Current release:** v0.3 macOS app plus a web/PWA client, a Windows Electron target, and an optional X realtime stream worker. The macOS app, browser client, and Windows packaging are verified; Windows desktop runtime and credentialed X streaming still need their platform checks.

Tibo Reset Watch polls a public reset feed every two minutes, classifies new posts, and shows a native notification for either a likely upcoming reset or a confirmed reset. The same Tibo-only contract powers the macOS app, browser PWA, and Windows shell. It does not require an X, OpenAI, or Telegram login, and it never reads a user's Codex usage.

## What it does

- Shows a small menu-bar bell instead of keeping a browser tab open.
- Accepts only canonical posts authored by `@thsottiaux`; other accounts and non-Tibo events are excluded.
- Shows Tibo's latest accepted timeline post in the menu even when it is unrelated to resets.
- Shows complete accepted posts in the web client and, when available, includes the public text of the post that Tibo replied to.
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

The browser client has no build step and reads the public feed directly. When served by the Node web server, it uses the same-origin `/api/reply-context` endpoint to enrich replies from a public X JSON mirror, with X oEmbed as a fallback. Browser notifications are optional and only fire while the page is open.

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

The Node and Cloudflare Pages services expose the same-origin `/api/feed`: they read <https://codex-reset.com/api/feed> and the public FxTwitter timeline concurrently, merge valid Tibo posts by ID, and retain the most recent 100 original posts when either source fails. Valid Tibo posts in `radar_context` supplement the displayed timeline without upgrading visibility-only context to reset confirmations. Neither source is an official OpenAI or X API. The app requires the payload to identify itself as the `thsottiaux` timeline, then accepts only canonical URLs shaped like `x.com/thsottiaux/status/<same-id>`. Tibo's replies and quote-posts qualify when he authored their canonical status URL; posts authored by OpenAI, OpenAI Status, or community accounts do not.

The primary upstream publishes refreshed copies about once a minute; the FxTwitter fallback reads the current public timeline. This is still not an official real-time X stream. Reply context is filled asynchronously after posts are displayed, with at most three browser requests in flight; slow context cannot hold the main feed empty. The page requests the server snapshot every two minutes, the server keeps a successful feed snapshot in memory for one minute, and the service keeps a bounded recent snapshot instead of an unbounded archive. The Node service keeps successfully resolved reply context in memory for six hours (and failed lookups for fifteen minutes) to avoid repeatedly calling X; reply-context caches disappear when the service restarts; Node can retain the bounded feed snapshot on disk. If every feed source is unavailable or fails the author checks, the app does not invent an alert. Treat the original X post and your Codex client as the source of truth.

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

顶部按钮支持全部动态、自己发帖、回复他人和类型待确认，同时筛选最新动态、历史动态和 Reset 提醒，不改变通知条件。历史支持全部可用历史与最近 3 天切换，并保留完整原文。新旧记录根据来源的回复标记、回复对象或引用关系分类；回复自己的续帖归入自己发帖，缺少依据的记录标为类型待确认，不根据正文猜测。回复他人时，Node 服务通过公开 X JSON 镜像补充被回复原文，并以 X oEmbed 作为备用来源；获取失败时页面明确提示，不伪造内容。历史仅限上游当前返回的记录，页面不额外归档。

## 双语内容卡片与 X 原文截图

首次安装、Cloudflare Browser Run 配置、Cloudflare Pages 上传、日常发布与回滚，请按 [`docs/部署与发布教案.md`](docs/部署与发布教案.md) 操作。教案中的凭据均为占位符，真实 Token 只能保存在服务器私有配置或 Cloudflare Secret 中。

最新动态、历史动态和 Reset 提醒均提供“生成分享图”入口。展开后可选择英文原文、纯中文译文或中文与英文对照，并下载 PNG；长帖自动分页，图片保留时间、发帖类型和正文，回复类动态还会同时带上被回复的原文。纯中文模式会把 Tibo 正文和被回复原文一起翻译，图片不混入英文正文；中英对照模式保持中文译文加完整英文原文。图片不再显示原帖 URL、页码说明和翻译来源等底部元信息。卡片为文字排版，不是 X 页面截图，不包含原帖媒体。中文带机器翻译标识，并提供可复制的译文。

Node 服务配置 Cloudflare Browser Run 后，同一入口还会显示“下载 X 原文截图”。服务端只允许截取当前可信 feed 中 `@thsottiaux` 的帖子，Cloudflare 在境外打开真实 X 页面并只截取首个 `article`；成功 PNG 按帖子 ID 写入 `X_SCREENSHOT_CACHE_DIR`，后续下载直接读取本地缓存。Cloudflare 不可用、命中机器人拦截或截图未配置时，不影响现有英文和中英对照内容卡片。

中文支持公共翻译和 AI 翻译，由使用者在卡片内选择，不自动切换供应商。只有请求中文时才将该公开原文提交给所选服务。公共翻译使用 MyMemory，有每日额度及网络可用性限制；失败会显示原因，不把英文作为中文返回。AI 使用服务器配置的 Chat Completions 兼容接口。密钥不进入网页。

部署完整功能需要 Node.js 22+，运行 `npm run web:serve`，默认地址为 `http://127.0.0.1:8788`。配置见 `server/translation.env.example`；环境变量由运行环境加载，该示例不会自动读取。静态托管仍可生成英文卡片，中文需要把 `web/config.js` 中 `translationEndpoint` 指向同源翻译服务（默认 `/api/translate`）；跨域 API 未开放。

AI 配置项为 `AI_TRANSLATION_URL`（完整接口地址）、`AI_TRANSLATION_MODEL`、`AI_TRANSLATION_API_KEY`（支持无需密钥的内部接口）。配置后重启进程或重建容器。AI 未配置时选择该方式会提示使用公共翻译，不会伪造结果。

X 原文截图配置项为 `CLOUDFLARE_ACCOUNT_ID`、具有 `Browser Rendering - Edit` 权限的 `CLOUDFLARE_BROWSER_API_TOKEN`，以及发布目录之外的 `X_SCREENSHOT_CACHE_DIR`。三项全部配置后入口才会显示。截图接口同一时间最多处理 1 个新帖子、每分钟最多请求 6 次 Cloudflare；同一帖子并发请求会合并，缓存文件必须是有效且不超过 12 MiB 的 PNG。浏览器请求可能被 X 识别为机器人，因此原生截图属于可降级能力，不替代英文原文内容卡片。

翻译服务每次最多处理 24000 字节原文，公共服务按不超过 480 字节分段；总超时 55 秒，并发上限 2，每分钟最多发起 20 次新翻译。相同内容和供应商的并发请求合并，成功译文缓存最多 1000 条；配置 `TRANSLATION_CACHE_DIR` 可跨发布保留。缓存键包括原文和 AI 模型地址，失败不缓存。历史仅覆盖上游当前提供的原文。

93 部署时运行 Node 容器提供静态页面和翻译 API，端口仍为 9093。私有配置文件使用 `/data/tibo-reset-watch/translation.env`，译文缓存使用 `/data/tibo-reset-watch/translations`，截图缓存可使用 `/data/tibo-reset-watch/screenshots`，发布目录以只读方式挂载；升级时保留旧容器用于回滚。配置文件和缓存目录不要放在发布目录或 Git 仓库内。

208 部署使用 systemd 管理 Node 服务，当前公开端口为 9104。在 Windows 项目目录中使用 PowerShell 7 运行 `pwsh.exe -File scripts/deploy-208.ps1` 即可一键更新。脚本复用本机专用 SSH 密钥，先执行本地语法和差异检查，再把明确列出的运行文件上传到 `/data/tibo-reset-watch/releases/` 新版本目录；通过 SHA-256 校验后原子切换 `/data/tibo-reset-watch/current` 并重启服务。服务器本机健康检查失败时自动恢复旧版本。`translation.env`、译文/截图缓存和 Node 运行时位于发布目录之外，不会被更新包覆盖。脚本只适用于已经完成首次安装的 208 服务器；如果免密私钥放在其他位置，可通过 `-IdentityFile` 指定。

日常更新可以直接双击项目根目录的 `deploy-208.cmd`，窗口会保留部署结果和错误信息。命令行调用方式如下：

```bat
deploy-208.cmd
```

```powershell
pwsh.exe -File scripts/deploy-208.ps1
```

仅检查本地代码、打包过程和部署脚本语法，不连接服务器时使用：

```powershell
pwsh.exe -File scripts/deploy-208.ps1 -ValidateOnly
```

接口：`GET /api/translation-status` 返回公共服务支持情况与 AI 是否已配置；`POST /api/translate` 接收 `{ "text": "原文", "provider": "public 或 ai" }`，返回 `{ "text": "译文", "provider": "翻译来源" }`。`GET /api/x-screenshot-status` 返回原生截图是否已配置；`GET /api/x-screenshot?id=<帖子ID>` 只接受当前 Tibo feed 中的帖子并返回 PNG。额度/并发超限为 429，功能未配置为 503，上游失败为 502，超时为 504。日志仅记录错误状态和帖子 ID，不记录密钥、翻译正文或 Cloudflare 响应内容。

参考：[MyMemory API](https://mymemory.translated.net/doc/spec.php)、[Chat Completions 接口](https://developers.openai.com/api/reference/resources/chat)。

## Cloudflare Pages 免费托管

Pages 版本独立提供网页、同源 feed 和翻译 API，不调用 93 或云服务器上的服务。原 Node 部署仍可继续使用。

当前访问地址：https://tibo-reset-watch.pages.dev/ 。公共翻译仍受 MyMemory 的供应商额度约束；本地或原服务器翻译成功不代表 Cloudflare 出口有剩余额度，耗尽时返回 429 并显示原因。

首次或依赖变动后先在项目目录执行 `npm.cmd ci`，再使用 PowerShell 7 执行 `pwsh.exe -File scripts/build-pages.ps1`，将输出的 ZIP 上传到 Cloudflare Pages 的“直接上传”。每次生成新的临时目录，不清理或覆盖已有发布包。包内只包含网页资产、`_worker.js`、`_routes.json` 和 `_headers`，不上传服务器配置或密钥。更新时在同一个 Pages 项目创建新部署，失败可通过控制台回滚。

`cloudflare/worker.mjs` 适配现有 `/api/translate` 和 `/api/translation-status` 协议。Pages 包不携带中国服务器的 Browser Run 私有凭据，因此 `/api/x-screenshot-status` 返回未启用并隐藏原生截图按钮；英文和中英对照内容卡片不受影响。静态资源不消耗函数调用额度；翻译 API 受 Workers 免费配额限制。公共翻译每次最多 45 个分段（每段最多 480 UTF-8 字节），超限明确报错、不截断原文，以适配免费运行时子请求上限。AI 配置项与 Node 版同名，在 Pages 设置中配置，密钥使用 Secret 类型；接口必须可从 Cloudflare 经 HTTPS 访问，配置后重新部署。

成功译文使用单实例最多 1000 条的内存缓存，以及有效期一天、可能提前淘汰的 Cloudflare 边缘缓存。缓存不是持久归档，不同步现有服务器的翻译文件；边缘缓存读写失败会记录不含正文的错误标识，并保留正常翻译能力。并发上限 2、每分钟 20 次的限制及相同请求合并仅作用于单个 Worker 实例，不是全站严格限额。需要全站配额时应另行配置 Durable Objects 或平台限流。

## 重置信号补充来源

Node 与 Cloudflare Pages 共用 `server/feed-service.mjs`，在现有 Tibo feed 之外读取 AI情报局公开频道 <https://t.me/s/ai_pulse_zh>，仅接受标题明确为 Codex 重置已排期或已完成、且附有唯一 `@thsottiaux` X 原帖链接的消息。全站 RSS 不保证收录重置信号，因此不作为通知依据；RSS.bz 页面条款限制自动抓取，程序不轮询该页面；邮件订阅需要私人邮箱及确认，也不用于后台采集。

每个 feed 实例缓存 1 分钟、合并并发请求；频道直连的成功或失败状态缓存 2 分钟。单次直连上游请求超时 12 秒、响应上限 2 MiB。Node 已配置现有 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_BROWSER_API_TOKEN` 时，Telegram 直连失败后使用 Cloudflare Browser Run `/content` 获取固定公开频道，后备请求超时 20 秒、成功或失败状态缓存 5 分钟，并消耗现有 Browser Run 配额；未配置时明确降级。`signal_source.transport` 标明实际读取方式。Pages 默认直连，不接收 Node 的私有凭据。不归档频道历史，仅处理公开预览当前提供的消息。Pages 使用 esbuild 将共享模块打包进单个 `_worker.js`，esbuild 仅为开发依赖，Node 运行和服务器部署不需要安装它。

同一 X 原帖 ID 只显示一条提醒；订阅摘要单独标记为第三方判定，Tibo 原文和原时间保持不变。未取得原文时，订阅消息同样进入最新动态、历史动态和独立的“订阅信号”筛选；作者明确显示为 AI情报局并标注非 Tibo 原文，不生成原文分享卡片。第三方称已完成仍按待核实信号处理，不触发“仅已确认”通知；原 feed 后续提供确认时，可按原有规则升级为确认提醒。首次读取该频道或首次启用综合来源时静默建立基线，已有用户也不补发合并取得的旧消息。

所有来源同时读取并按原帖 ID 合并；优先使用本次原 feed 的明确字段，其次是本次镜像与保留记录。同一条消息的原文和订阅依据合并展示。服务最多保留 100 条 Tibo 原文、20 条订阅信号，来源失败时继续展示已有记录，标注缓存状态、上次成功时间和来源故障；仅在没有任何可用内容时返回 502。Node 默认在 `TRANSLATION_CACHE_DIR/feed/snapshot.json` 原子保存最近快照，可用 `FEED_CACHE_DIR` 指定独立目录；不配置缓存目录时仅保留进程内快照，Pages 也仅保留实例内快照。缓存读写失败会记录日志，写入失败还会在页面提示。跨部署保留目录不放入发布包。`GET /api/feed` 提供 `tweets` 原文、`reset_signals` 订阅依据和 `feed_entries` 综合展示列表，并通过 `timeline_sources`、`timeline_status`、`timeline_last_success_at`、`signal_source` 与 `source_warnings` 区分实时取得和保留数据。浏览器通知仍只在页面打开时工作；订阅来源不是个人额度查询接口。

## 最近 30 天已重置日历

时间线新增固定 Nitter 实例的公开 RSS（`https://x.noodl3.net/thsottiaux/with_replies/rss`），按频道、作者和帖子链接校验，仅提取 Tibo 自己的正文，不把引用正文混入原文。遵循该 RSS 的 40 分钟缓存周期。主 feed、该 RSS 和新增 TokenReset 历史接口直连或格式校验失败时，Node 可复用现有 Cloudflare Browser Run 配置获取固定地址；后备成功或失败缓存 5 分钟（RSS 成功仍缓存 40 分钟），保留各源实际检查时间和 `transport`，消耗现有 Browser Run 配额。未配置 Browser Run 的环境只直连，失败后保留原有快照。

`https://token.jacobai.app/api/feed` 每 5 分钟补充一次历史日历，仅接受关联唯一 Tibo 原帖、类型为常规额度重置的 reported/observed 记录；重置卡、未来记录和降级响应不纳入。此站注明其上游为 Codex Resets，因此它是额外的读取与归档通道，不是独立确认。所有记录只标记为黄色第三方报告，不写入 Tibo 时间线，不触发确认通知。`archive_source` 提供其获取状态、传输方式与上游生成时间；来源失败后保留已保存的报告。Browser Run 请求仅在 fetch 网络错误时重试一次，两次共用 20 秒总超时，日志记录 `feed_browser_transport_retry`；HTTP 错误、无效内容和校验失败不重试。

页面展示包含今天的最近 30 个北京时间自然日。绿色仅表示 Tibo 原文明确确认完成（或原 feed 的 confirmed 标记）；简短 Done 必须有可验证的重置上下文。黄色为第三方归档或订阅报告已完成，单独统计，不冒充原文确认。预告、预计落地时间、观察账号收到重置卡和 banked reset 均不计入已完成重置；无记录不等于未重置。按确认帖或完成报告发布时间归日，不推断每个账户的实际恢复时刻。

点击日期可查看依据及原帖链接；统计单位为重置日，同日多条确认不会重复增加天数。历史资料可能不完整。后端在现有快照内保存最近 30 天、最多 300 条确认或第三方完成报告，不受时间线 100 条上限影响。GET /api/feed 的 reset_calendar 返回日期、每日状态和依据，reset_history 保存可追溯记录；重启或来源失败后保留历史，超出窗口自动移除。该统计不改变浏览器通知条件。
