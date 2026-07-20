import { createServerFn } from "@tanstack/react-start";
import { requireAppPasscode } from "@/lib/auth/passcode.middleware";
import { z } from "zod";

export const listKnowledge = createServerFn({ method: "GET" }).middleware([requireAppPasscode]).handler(
  async () => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { data, error } = await supabaseAdmin
      .from("knowledge_base")
      .select("id, content_text, updated_at")
      .order("id", { ascending: true });
    if (error) throw new Error(`Load knowledge failed: ${error.message}`);
    return (data ?? []) as Array<{
      id: number;
      content_text: string | null;
      updated_at: string;
    }>;
  },
);

export const upsertKnowledge = createServerFn({ method: "POST" }).middleware([requireAppPasscode])
  .inputValidator((d) =>
    z
      .object({
        id: z.number().int().optional(),
        content_text: z.string().max(20000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    if (data.id != null) {
      const { error } = await supabaseAdmin
        .from("knowledge_base")
        .update({ content_text: data.content_text })
        .eq("id", data.id);
      if (error) throw new Error(`Save failed: ${error.message}`);
      return { ok: true, id: data.id };
    }
    const { data: row, error } = await supabaseAdmin
      .from("knowledge_base")
      .insert({ content_text: data.content_text })
      .select("id")
      .single();
    if (error) throw new Error(`Insert failed: ${error.message}`);
    return { ok: true, id: row.id as number };
  });

export const deleteKnowledge = createServerFn({ method: "POST" }).middleware([requireAppPasscode])
  .inputValidator((d) => z.object({ id: z.number().int() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import(
      "@/integrations/supabase/client.server"
    );
    const { error } = await supabaseAdmin
      .from("knowledge_base")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(`Delete failed: ${error.message}`);
    return { ok: true };
  });
