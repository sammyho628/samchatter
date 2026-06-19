// Hybrid cache strategy: persistent backup for today's conversation turns.
// - getTodayChatTurns(): read once on mount, hydrate local React state.
// - appendChatTurn(): fire-and-forget write after each turn.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type StoredTurn = { role: "user" | "model"; text: string };

export const getTodayChatTurns = createServerFn({ method: "GET" }).handler(
  async () => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    // Today in Hong Kong time.
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Hong_Kong",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
    const today = `${get("year")}-${get("month")}-${get("day")}`;

    const { data, error } = await supabaseAdmin
      .from("chat_turns")
      .select("role, text_content, created_at")
      .eq("session_date", today)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`Load chat turns failed: ${error.message}`);

    const turns: StoredTurn[] = (data ?? []).map((r) => ({
      role: (r.role as "user" | "model") ?? "user",
      text: (r.text_content as string) ?? "",
    }));
    return { date: today, turns };
  },
);

const AppendInput = z.object({
  role: z.enum(["user", "model"]),
  text: z.string().min(1).max(20000),
});

export const appendChatTurn = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => AppendInput.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { error } = await supabaseAdmin.from("chat_turns").insert({
      role: data.role,
      text_content: data.text,
    });
    if (error) throw new Error(`Append chat turn failed: ${error.message}`);
    return { ok: true };
  });
