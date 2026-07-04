// Deterministic (non-LLM) classifier + canned phrase templates for the
// two-phase "instant filler, then real answer" response flow (Fix 48).
//
// IMPORTANT: this module must never call an LLM. It exists purely to buy
// time with a zero-risk, zero-fact stall phrase while the real pipeline
// (unchanged, in orchestrator.ts) runs in the background.

export type FillerCategory =
  | "weather"
  | "stocks"
  | "sports"
  | "shopping"
  | "news"
  | "food"
  | "places";

// Deliberately narrow, high-precision triggers. A MISS just means no filler
// plays and the turn behaves exactly as it does today (safe, no regression).
// A false-positive match means an unnecessary filler plays before what
// would've been a fast answer (mildly suboptimal but harmless). Bias toward
// precision over recall — do not broaden these without good reason.
const FILLER_TRIGGERS: Array<{ category: FillerCategory; re: RegExp }> = [
  {
    category: "weather",
    re: /(天氣點|幾多度|落唔落雨|落雨嗎|使唔使帶遮|打風|黑雨|紅雨|weather|forecast|rain|typhoon)/i,
  },
  {
    category: "stocks",
    re: /(恆指|港股|美股|道指|標普|納指|股價|股市|stock market|hang seng|\bhsi\b|\bstocks?\b|\bshares?\b|nasdaq|dow jones|s&p|nvda|tsla|aapl|\d{4}\.hk)/i,
  },
  {
    category: "sports",
    re: /(世界盃|波賽|賽果|比分|邊隊贏|邊個贏|睇波|有波睇|足球|world cup|live score|match score|football|soccer|who('?s| is) winning)/i,
  },
  {
    category: "food",
    re: /(邊度食|食乜好|餐廳推介|好唔好食|飲茶|打邊爐|火鍋|任食|放題|buffet|restaurant|where to eat|good food)/i,
  },
  {
    category: "places",
    re: /(邊度好玩|附近.{0,4}(有咩|按摩|spa)|營業時間|幾點開門|opening hours|nearby|what time.{0,6}open)/i,
  },
  {
    category: "shopping",
    re: /(邊隻好|邊個牌子|牌子|型號|開箱|評測|推介|介紹|推薦|好唔好用|抵買|抵玩|買咩好|優惠|折扣|promotion|邊款|性價比高|買一送一|新款|which (one|model|brand)|any good|recommend|review|good model)/i,
  },
  {
    category: "news",
    re: /(最新消息|新聞|頭條|發生咩事|latest news|what'?s happening|breaking news)/i,
  },
];

const FILLER_PHRASES: Record<FillerCategory, string[]> = {
  weather: ["等我幫你check吓天氣，等等啊。", "等我睇吓最新天氣先，唔該等等。"],
  stocks: ["等我幫你睇吓市況，等等啊。", "等我查吓最新股價先，等等我。"],
  sports: ["等我幫你check吓賽果，等等啊。", "等我睇吓最新賽情先，唔該等等。"],
  shopping: ["等我幫你搵吓資料，等等啊。", "等我睇吓有咩選擇先，唔該等等。"],
  news: ["等我幫你check吓最新消息，等等啊。", "等我睇吓有咩新聞先，唔該等等。"],
  food: ["等我幫你搵吓好嘢食，等等啊。", "等我睇吓附近有咩食先，唔該等等。"],
  places: ["等我幫你check吓資料，等等啊。", "等我查吓詳情先，唔該等等。"],
};

/**
 * Deterministic, regex-only classifier. Returns null if no high-confidence
 * category match is found. Callers MUST treat null as "no filler, proceed
 * exactly as today" — do not substitute a generic phrase on null.
 */
export function classifyFillerIntent(userText: string): FillerCategory | null {
  const text = userText.trim();
  if (!text) return null;
  for (const { category, re } of FILLER_TRIGGERS) {
    if (re.test(text)) return category;
  }
  return null;
}

/** Picks a random phrase for the category so repeated fillers don't sound robotic. */
export function pickFillerPhrase(category: FillerCategory): string {
  const options = FILLER_PHRASES[category];
  return options[Math.floor(Math.random() * options.length)];
}
