import { createClient } from "@supabase/supabase-js";

export async function fetchVoiceBotContext(
  supabaseUrl: string,
  supabaseAnonKey: string,
): Promise<string> {
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await client
    .from("Voice-Bot-1")
    .select("content_text");
  if (error) {
    throw new Error(`Supabase: ${error.message}`);
  }
  const rows = (data ?? []) as Array<{ content_text: string | null }>;
  return rows
    .map((r) => (r.content_text ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}
