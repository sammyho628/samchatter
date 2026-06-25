import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { callUtilityChat } from "./modelRouter";

const SummarizeInput = z.object({
  sessionId: z.string().min(1),
  transcript: z.string().min(1).max(60000),
  executedSearches: z.array(z.string()).default([]),
});

export const summarizeAndSaveSession = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => SummarizeInput.parse(d))
  .handler(async ({ data }) => {
    const { text: summary, usedModel: summaryModel } = await callUtilityChat({
      system:
        "Summarize this Cantonese voice chat transcript between an AI companion and 明囡 in 2-3 short Traditional Chinese sentences. Capture: what she asked about, what she shared, mood. Skip greetings/filler. Output ONLY the summary text, no preamble.",
      user: data.transcript,
      maxTokens: 300,
    });
    console.log(
      `[${new Date().toISOString()}] 🧠 memory-summarize · model=${summaryModel}`,
    );
    if (!summary) throw new Error("Empty summary");

    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { error } = await supabaseAdmin.from("chat_memory").insert({
      session_id: data.sessionId,
      conversation_summary: summary,
      executed_searches: data.executedSearches,
    });
    if (error) throw new Error(`Save memory failed: ${error.message}`);
    return { ok: true, summary };
  });

// ---------- Contextual Greeting Generator ----------

const GreetingInput = z.object({
  personaName: z.string(),
  hkHour: z.number(),
  hkDayOfWeek: z.number(),
  weatherSnippet: z.string().default(""),
  lastMemorySummary: z.string().optional(),
  daysSinceLastSession: z.number().optional(),
});

export const generateContextualGreeting = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => GreetingInput.parse(d))
  .handler(async ({ data }): Promise<string> => {
    const {
      personaName,
      hkHour,
      hkDayOfWeek,
      weatherSnippet,
      lastMemorySummary,
      daysSinceLastSession,
    } = data;

    const name = personaName || "明女";
    const days = ["日", "一", "二", "三", "四", "五", "六"];
    const dayLabel = `星期${days[hkDayOfWeek] ?? "一"}`;
    const isWeekend = hkDayOfWeek === 0 || hkDayOfWeek === 6;

    let timePeriod = "下午";
    if (hkHour >= 5 && hkHour < 12) timePeriod = "早晨";
    else if (hkHour >= 12 && hkHour < 14) timePeriod = "中午";
    else if (hkHour >= 14 && hkHour < 18) timePeriod = "下午";
    else if (hkHour >= 18 && hkHour < 22) timePeriod = "晚上";
    else timePeriod = "夜晚";

    const systemPrompt = `你係一個溫暖親切嘅廣東話助手，負責生成問候語。
規則：
- 只用自然廣東話口語，唔好用書面語或普通話
- 稱呼用戶做 ${name}，唔好用「朋友」
- 長度：1至2句，唔好太長
- 語氣溫暖自然，好似老朋友咁
- 唔好每次用相同開頭，要有變化
- 如果有上次對話內容，自然地帶出一句跟進
- 如果天氣惡劣（有雨/雷暴），提醒帶遮`;

    const userPrompt = `生成一句問候語，根據以下資料：
- 用戶名字：${name}
- 現在時段：${timePeriod}（${hkHour}時）
- 今日：${dayLabel}${isWeekend ? "（週末）" : ""}
- 天氣概況：${weatherSnippet.slice(0, 120)}
${daysSinceLastSession !== undefined && daysSinceLastSession >= 3 ? `- 上次對話係 ${daysSinceLastSession} 日前，要用重逢語氣` : ""}
${lastMemorySummary ? `- 上次對話摘要：${lastMemorySummary.slice(0, 150)}（如有自然帶出跟進，但唔好太刻意）` : "- 冇上次對話記錄，新開始"}

只回覆問候語本身，唔好加任何解釋。`;

    try {
      const greeting = await callUtilityChat({
        system: systemPrompt,
        user: userPrompt,
        maxTokens: 80,
      });
      return greeting.trim() || `${name}，你好！`;
    } catch {
      const fallbacks: Record<string, string[]> = {
        早晨: [`${name}，早晨！`, `${name}，早啊！食咗早餐未？`],
        中午: [`${name}，中午好！`, `${name}，食完飯未呀？`],
        下午: [`${name}，下午好！`, `${name}，你好！`],
        晚上: [`${name}，晚上好！`, `${name}，食完晚飯未呀？`],
        夜晚: [`${name}，夜喇，注意休息呀。`, `${name}，咁夜仲未瞓？`],
      };
      const pool = fallbacks[timePeriod] ?? [`${name}，你好！`];
      return pool[hkDayOfWeek % pool.length];
    }
  });

