// Supabase Edge Function: web-search
// Calls Tavily and returns a compact text summary of the top results.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const apiKey = Deno.env.get("TAVILY_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Missing TAVILY_API_KEY" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { query } = (await req.json().catch(() => ({}))) as { query?: string };
    if (!query || typeof query !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing 'query' string" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 3,
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: `Tavily error ${resp.status}: ${txt.slice(0, 300)}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const data = (await resp.json()) as {
      answer?: string;
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const results = (data.results ?? []).slice(0, 3);
    const parts: string[] = [];
    if (data.answer) parts.push(`Answer: ${data.answer}`);
    results.forEach((r, i) => {
      const title = r.title ?? "Untitled";
      const content = (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
      const url = r.url ?? "";
      parts.push(`${i + 1}. ${title}${url ? ` (${url})` : ""}\n${content}`);
    });
    const summary = parts.length === 0 ? `No results found for "${query}".` : parts.join("\n\n");

    return new Response(JSON.stringify({ summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
