/* 根据动态原文生成可下载内容卡片；译文不参与重置识别和通知。 */
(() => {
  const COPY = {
    title: "生成分享图", en: "英文原文", zh: "中文 + 英文对照",
    loading: "正在生成卡片…", translating: "正在翻译并生成卡片…",
    empty: "此动态没有文本，无法生成内容卡片。",
    unavailable: "中文翻译服务尚未配置，英文卡片仍可使用。",
    failed: "卡片生成失败，请重试。", download: "下载 PNG",
    note: "支持英文原文和中英对照；中文为机器翻译，请以英文原文为准。",
  };
  const WIDTH = 1000;
  const PADDING = 56;
  const LINE_HEIGHT = 44;
  const PAGE_LINES = 28;
  const CACHE_LIMIT = 100;
  const translations = new Map();

  // 缓存包含原文，避免同一 ID 的内容更新后误用旧译文；失败结果不缓存。
  async function translate(post, provider) {
    const key = JSON.stringify([post.id, post.text, provider]);
    if (translations.has(key)) return translations.get(key);
    const endpoint = window.TIBO_RESET_WATCH_CONFIG?.translationEndpoint;
    if (!endpoint) throw new Error(COPY.unavailable);
    const pending = (async () => {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: post.id, text: post.text, provider }),
        signal: AbortSignal.timeout(60_000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `翻译暂不可用（HTTP ${response.status}），请稍后重试。`);
      if (typeof result.text !== "string" || !result.text.trim()) throw new Error("翻译服务没有返回译文。");
      return { text: result.text.trim(), provider: result.provider || "机器翻译" };
    })();
    if (translations.size >= CACHE_LIMIT) translations.delete(translations.keys().next().value);
    translations.set(key, pending);
    try { return await pending; } catch (error) { translations.delete(key); throw error; }
  }

  // 按实际字宽排版，保留段落；超长单词或链接逐字换行，长帖分页而不裁切。
  function wrapText(context, text, maxWidth) {
    const lines = [];
    for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
      let line = "";
      const tokens = paragraph.match(/\S+\s*|\s+/gu) || [];
      for (const token of tokens) {
        if (context.measureText(line + token).width <= maxWidth) { line += token; continue; }
        if (line) { lines.push(line); line = ""; }
        for (const char of token) {
          if (line && context.measureText(line + char).width > maxWidth) { lines.push(line); line = ""; }
          line += char;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  function cardImages(post, kind, language, translated) {
    if (!String(post.text || "").trim()) throw new Error(COPY.empty);
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持生成图片。");
    const font = '28px "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';
    context.font = font;
    const replyHandle = String(post.reply_context?.author_handle || post.replying_to || "").replace(/^@/, "");
    const replyText = String(post.reply_context?.text || "").trim();
    const replyContent = kind.type === "reply" && replyText
      ? `\n\n被回复的原文${replyHandle ? `  @${replyHandle}` : ""}\n${replyText}`
      : "";
    const content = language === "zh"
      ? `${translated.text}\n\n英文原文\n${post.text}${replyContent}`
      : `${post.text}${replyContent}`;
    const lines = wrapText(context, content, WIDTH - PADDING * 2);
    const pages = Math.ceil(lines.length / PAGE_LINES);
    const images = [];
    const date = new Date(post.at);
    const timestamp = Number.isNaN(date.getTime()) ? "发布时间未知" : date.toISOString().replace("T", " ").replace(".000Z", " UTC");
    for (let page = 0; page < pages; page += 1) {
      const pageLines = lines.slice(page * PAGE_LINES, (page + 1) * PAGE_LINES);
      canvas.height = 290 + pageLines.length * LINE_HEIGHT;
      context.fillStyle = "#f5f8fa"; context.fillRect(0, 0, WIDTH, canvas.height);
      context.fillStyle = "#ffffff"; context.fillRect(24, 24, WIDTH - 48, canvas.height - 48);
      context.fillStyle = "#0b8a8f"; context.fillRect(24, 24, 7, canvas.height - 48);
      context.fillStyle = "#0b1f3a"; context.font = 'bold 38px "Segoe UI", sans-serif';
      context.fillText("Tibo", PADDING, 85);
      context.font = '22px "Microsoft YaHei", sans-serif'; context.fillStyle = "#607086";
      context.fillText(`@thsottiaux  ·  ${timestamp}`, PADDING, 123);
      context.fillText(`${kind.label}  ·  ${language === "zh" ? "中文译文 / English" : "English · 原文"}`, PADDING, 163);
      context.font = font; context.fillStyle = "#0b1f3a";
      pageLines.forEach((line, index) => context.fillText(line, PADDING, 227 + index * LINE_HEIGHT));
      const src = canvas.toDataURL("image/png");
      if (src === "data:,") throw new Error("图片尺寸超过浏览器限制。");
      images.push(src);
    }
    canvas.width = 0; canvas.height = 0;
    return images;
  }

  function create(post, kind) {
    const root = document.createElement("details"); root.className = "post-cards";
    const summary = document.createElement("summary"); summary.textContent = COPY.title;
    const controls = document.createElement("div"); controls.className = "card-controls";
    controls.setAttribute("role", "group"); controls.setAttribute("aria-label", "分享图语言");
    const status = document.createElement("p"); status.className = "card-status"; status.setAttribute("role", "status");
    const preview = document.createElement("div"); preview.className = "card-preview";
    const note = document.createElement("p"); note.className = "card-note"; note.textContent = COPY.note;
    const providerLabel = document.createElement("label"); providerLabel.className = "card-provider";
    providerLabel.append("翻译方式 ");
    const provider = document.createElement("select"); provider.setAttribute("aria-label", "选择翻译方式");
    for (const [value, label] of [["public", "公共翻译"], ["ai", "AI 翻译"]]) {
      const option = document.createElement("option"); option.value = value; option.textContent = label; provider.append(option);
    }
    providerLabel.append(provider);
    let language = "en";
    let revision = 0;
    const buttons = [];
    async function render() {
      const request = ++revision;
      preview.replaceChildren();
      status.textContent = language === "zh" ? COPY.translating : COPY.loading;
      buttons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.language === language)));
      try {
        const translated = language === "zh" ? await translate(post, provider.value) : null;
        await document.fonts.ready;
        if (request !== revision || !root.open) return;
        const images = cardImages(post, kind, language, translated);
        images.forEach((src, index) => {
          const figure = document.createElement("figure");
          const img = document.createElement("img"); img.src = src;
          img.alt = `${language === "zh" ? COPY.zh : COPY.en}分享图，第 ${index + 1} / ${images.length} 张；完整文字见本动态原文。`;
          const link = document.createElement("a"); link.href = src;
          const safeId = String(post.id).replace(/[^a-zA-Z0-9_-]/g, "");
          link.download = `Tibo-${safeId}-${language}-${index + 1}.png`;
          link.textContent = `${COPY.download}${images.length > 1 ? ` · ${index + 1}/${images.length}` : ""}`;
          figure.append(img, link); preview.append(figure);
        });
        if (translated) {
          const transcript = document.createElement("details");
          const heading = document.createElement("summary"); heading.textContent = "查看 / 复制中文译文";
          const text = document.createElement("p"); text.className = "card-transcript"; text.textContent = translated.text;
          transcript.append(heading, text); preview.append(transcript);
        }
        status.textContent = `${images.length} 张卡片${translated ? ` · 翻译来源：${translated.provider}` : ""}`;
      } catch (error) {
        if (request === revision && root.open) status.textContent = error.message || COPY.failed;
      }
    }
    for (const [code, label] of [["en", COPY.en], ["zh", COPY.zh]]) {
      const button = document.createElement("button"); button.type = "button";
      button.textContent = label; button.dataset.language = code; button.className = "filter-button";
      button.addEventListener("click", () => { language = code; render(); });
      buttons.push(button); controls.append(button);
    }
    root.addEventListener("toggle", () => {
      if (root.open) render();
      else { revision += 1; preview.replaceChildren(); status.textContent = ""; }
    });
    provider.addEventListener("change", () => { if (language === "zh" && root.open) render(); });
    root.append(summary, controls, providerLabel, status, preview, note);
    return root;
  }
  window.TiboPostCards = Object.freeze({ create });
})();
