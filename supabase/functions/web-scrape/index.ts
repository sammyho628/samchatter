// Supabase Edge Function: web-scrape
// Scrapes a single URL via Firecrawl and returns cleaned markdown.
// Requires FIRECRAWL_API_KEY in env.
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
    const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Missing FIRECRAWL_API_KEY" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { url } = (await req.json().catch(() => ({}))) as { url?: string };
    if (!url || typeof url !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing 'url' string" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const resp = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: 15000,
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: `Firecrawl error ${resp.status}: ${txt.slice(0, 300)}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const data = (await resp.json()) as {
      success?: boolean;
      data?: { markdown?: string; metadata?: { title?: string } };
    };

    if (!data.success || !data.data?.markdown) {
      return new Response(
        JSON.stringify({ error: "Firecrawl returned no markdown content" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const summary = data.data.markdown.slice(0, 6000);
    return new Response(
      JSON.stringify({ summary, url, title: data.data.metadata?.title ?? null }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
