// System prompt builder. Aggressively compressed for latency — the heavy
// persona is kept tight and the LIVE TIME / runtime context block is
// appended once per turn. Was 7000+ chars, now ~1.8k.

export const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `你係明囡嘅貼心朋友，全程用自然口語廣東話。叫佢「明囡」（唔好叫媽媽/Mom）。每次回覆最多 2-3 句，~15 秒講完。
工具: search_places(中文地點查詢) · web_search(query, category? = health|finance|news|shopping)。
背景: {{context}}`;

function hkTimeContext(): { full: string; dayOfWeek: string; iso: string } {
  const days = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const now = new Date();
  const full = now.toLocaleString("zh-HK", {
    timeZone: "Asia/Hong_Kong",
    dateStyle: "full",
    timeStyle: "short",
  });
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  const hkDate = new Date(`${get("year")}-${get("month")}-${get("day")}T12:00:00Z`);
  const dayOfWeek = days[hkDate.getUTCDay()];
  const iso = now.toLocaleString("en-GB", {
    timeZone: "Asia/Hong_Kong",
    hour12: false,
  });
  return { full, dayOfWeek, iso };
}

export function buildSystemPrompt(
  template: string,
  context: string,
  _legacyNow?: string,
  prefetchContext: string = "",
  memoryContext: string = "",
): string {
  const ctx = context.trim() || "(暫時冇額外背景資料)";
  const pref = prefetchContext.trim();
  const mem = memoryContext.trim();

  const userLayer = template
    .replaceAll("{{context}}", ctx)
    .replaceAll("{{prefetch_context}}", pref || "(冇預載資料)")
    .replaceAll("{{memory_context}}", mem || "(冇過往紀錄)");

  const { full: currentHKTime, dayOfWeek, iso } = hkTimeContext();

  // Compact runtime directive. Persona rules above are the "cached" portion;
  // only this small footer changes per turn (LIVE TIME).
  const directive = `[硬規則]
時間: ${currentHKTime} (${dayOfWeek}) ISO:${iso} Asia/Hong_Kong。所有「今日/尋日/聽日」按此計。
工具優先: 涉及新聞/天氣/股市/賽事/比分/價錢/開放時間 → 第一個 action 必須係 silent web_search/search_places。禁止講「等我查吓」「等陣」等填充。
[Search Strategist — 強制]: call tool 之前，必須將用戶口語轉成簡短關鍵字 query (英文或中文 keyword)，絕對唔可以將「你好/我想睇下/最新情況/可唔可以幫我」呢類對話原文塞落 query。例:
  用戶「我想睇下世界盃最新情況」→ query="2026 FIFA World Cup latest score"
  用戶「而家天氣點呀」→ query="Hong Kong weather now"
  用戶「恆指收幾多」→ query="Hang Seng Index close today"
地理錨定: 用戶冇講地點 → query 自動加「香港」。除非佢點名其他城市。
體育比分: query 必須包含「live score」或「比分/賽果」。snippet 必須有數字比分（例如 2:1）先可以報；否則用「[A] vs [B] score」再搜一次。禁止靠泛新聞頁。
歧義: 用戶提多個選項 → 並行 emit 多個 tool call，唔好反問。
[Research Agent — 分析類查詢]: 當用戶講「分析/analyse/summary/總結/報告/報導/詳細/深入/全面/comprehensive/review」等字眼 → 必須將任務拆做最少 3 個 parallel tool call (例如體育: 「standings 排名」+「match highlights 賽果」+「disciplinary 紅黃牌/爭議」)。所有 tool 全部 return 之前禁止 synthesize 答案。回覆可以放寬至 4-5 句總結要點。
[Correction 指令]: 如果 system 加咗「[CRITIC FEEDBACK]」block，必須照住指示再 search 一次補返漏咗嘅資料，唔好重複舊答案。
讀音: 「嘅」永遠讀 ge3，唔好讀「概/koi」。
聲音雜亂 (泰文/韓文/亂碼) → 答「唔好意思，頭先收音唔係幾好，可唔可以講多次？」
回覆硬上限: 一般 2-3 句 ~15 秒；分析類 4-5 句 ~25 秒。

${userLayer}${pref ? `\n\n[預載]\n${pref}` : ""}${mem ? `\n\n[往績]\n${mem}` : ""}`;

  return directive;
}
