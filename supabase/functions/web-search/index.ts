// Supabase Edge Function: web-search
// Calls Tavily and returns a compact text summary of the top results.
// Optional `category` arg: looks up public.trusted_domains for that category and
// applies the curated domain_query_string to the search.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function extractSiteDomains(raw: string): { cleaned: string; domains: string[] } {
  const domains: string[] = [];
  const cleaned = raw
    .replace(/\bsite:([^\s]+)/gi, (_, d) => {
      const dom = String(d).replace(/[,)]+$/g, "").trim();
      if (dom) domains.push(dom);
      return "";
    })
    .replace(/\s+OR\s+/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { cleaned, domains: Array.from(new Set(domains)) };
}

async function lookupCategoryDomains(category: string): Promise<string[]> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return [];
  try {
    const r = await fetch(
      `${url}/rest/v1/trusted_domains?category=eq.${encodeURIComponent(category)}&select=domain_query_string`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{ domain_query_string?: string }>;
    const all: string[] = [];
    for (const row of rows) {
      const ext = extractSiteDomains(row.domain_query_string ?? "");
      all.push(...ext.domains);
    }
    return Array.from(new Set(all));
  } catch {
    return [];
  }
}

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

    const { query, category } = (await req.json().catch(() => ({}))) as {
      query?: string;
      category?: string;
    };
    if (!query || typeof query !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing 'query' string" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { cleaned, domains } = extractSiteDomains(query);
    let allDomains = [...domains];
    if (category) {
      const catDomains = await lookupCategoryDomains(category);
      allDomains = Array.from(new Set([...allDomains, ...catDomains]));
    }

    const tavilyBody: Record<string, unknown> = {
      query: cleaned || query,
      search_depth: "advanced",
      include_answer: true,
      max_results: 5,
    };
    if (allDomains.length > 0) tavilyBody.include_domains = allDomains;

    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(tavilyBody),
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

    return new Response(JSON.stringify({ summary, category: category ?? null, domains: allDomains }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
