import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const PROMPT_KEY = "voice.systemPromptTemplate.v1";

export const getSystemPrompt = createServerFn({ method: "GET" }).handler(
  async () => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data, error } = await supabaseAdmin
      .from("app_settings")
      .select("value, updated_at")
      .eq("key", PROMPT_KEY)
      .maybeSingle();
    if (error) throw new Error(`Load prompt failed: ${error.message}`);
    return {
      template: (data?.value as string | undefined) ?? null,
      updatedAt: (data?.updated_at as string | undefined) ?? null,
    };
  },
);

export const saveSystemPrompt = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z.object({ template: z.string().min(1).max(20000) }).parse(data),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { error } = await supabaseAdmin
      .from("app_settings")
      .upsert(
        { key: PROMPT_KEY, value: data.template, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
    if (error) throw new Error(`Save prompt failed: ${error.message}`);
    return { ok: true };
  });

export const resetSystemPrompt = createServerFn({ method: "POST" }).handler(
  async () => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { error } = await supabaseAdmin
      .from("app_settings")
      .delete()
      .eq("key", PROMPT_KEY);
    if (error) throw new Error(`Reset prompt failed: ${error.message}`);
    return { ok: true };
  },
);
