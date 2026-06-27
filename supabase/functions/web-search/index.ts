// TAVILY_API_KEY kept in env for fallback — replaced by Brave Search (BRAVE_API_KEY)
// Supabase Edge Function: web-search
// Calls Brave Search and returns a compact text summary of the top results.
// Optional `category` arg: looks up public.trusted_domains for that category and
// applies the curated domain allow-list as site: filters in the query.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// HK-local categories use zh-Hant + HK; global categories use en + US.
const HK_CATEGORIES = new Set([
  "hk_news",
  "weather",
  "transport",
  "government",
  "health",
  "sports",
  "stocks",
  "finance",
  "shopping",
  "travel",
]);
const GLOBAL_CATEGORIES = new Set([
  "world_news",
  "technology",
  "weather_global",
  "stocks_us",
  "market_us",
  "travel_global",
]);

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

async function lookupCategoryDomains(
  category: string,
  priority?: number,
): Promise<string[]> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return [];
  try {
    const priFilter =
      typeof priority === "number" ? `&priority=eq.${priority}` : "";
    const r = await fetch(
      `${url}/rest/v1/trusted_domains?category=eq.${encodeURIComponent(category)}${priFilter}&select=domain_query_string`,
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

function localeForCategory(category?: string): { lang: string; country: string } {
  if (category && GLOBAL_CATEGORIES.has(category)) {
    return { lang: "en", country: "us" };
  }
  if (category && HK_CATEGORIES.has(category)) {
    return { lang: "zh-hant", country: "hk" };
  }
  // Default: HK-local
  return { lang: "zh-hant", country: "hk" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const apiKey = Deno.env.get("BRAVE_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Missing BRAVE_API_KEY" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { query, category, priority } = (await req.json().catch(() => ({}))) as {
      query?: string;
      category?: string;
      priority?: number;
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
      const catDomains = await lookupCategoryDomains(category, priority);
      allDomains = Array.from(new Set([...allDomains, ...catDomains]));
    }

    // Build q with site: filters appended (cap at 8 domains for query length).
    const baseQ = cleaned || query;
    const limitedDomains = allDomains.slice(0, 8);
    const siteFilter =
      limitedDomains.length > 0
        ? " " + limitedDomains.map((d) => `site:${d}`).join(" OR ")
        : "";
    const q = baseQ + siteFilter;

    const { lang, country } = localeForCategory(category);

    const params = new URLSearchParams({
      q,
      count: "5",
      search_lang: lang,
      country,
    });

    const resp = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
      },
    );

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: `Brave error ${resp.status}: ${txt.slice(0, 300)}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const data = (await resp.json()) as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          extra_snippets?: string[];
        }>;
      };
    };

    const results = (data.web?.results ?? []).slice(0, 3);
    const parts: string[] = [];
    results.forEach((r, i) => {
      const title = r.title ?? "Untitled";
      const url = r.url ?? "";
      const description = (r.description ?? "").replace(/\s+/g, " ").trim();
      parts.push(`${i + 1}. ${title}${url ? ` (${url})` : ""}\n${description}`);
    });
    const summary =
      parts.length === 0 ? `No results found for "${query}".` : parts.join("\n\n");

    return new Response(
      JSON.stringify({ summary, category: category ?? null, domains: allDomains }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
