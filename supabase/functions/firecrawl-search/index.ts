// Supabase Edge Function: firecrawl-search
// Calls Firecrawl /v1/search and returns a compact text summary of the top results.
// Requires FIRECRAWL_API_KEY in env.
// Optional `category` arg: looks up public.trusted_domains for that category and
// applies the curated domain allow-list as site: filters in the query.
// This is the parallel companion to web-search (Brave). Firecrawl penetrates
// JS-rendered pages and Chinese-language sites (e.g. Dianping) that Brave cannot index.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Categories that should search in a Chinese/global context rather than HK-local.
const FOOD_GLOBAL_CATEGORIES = new Set(["food", "travel_global", "world_news", "technology"]);

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
      const raw = (row.domain_query_string ?? "").trim();
      // Defensive normalisation: if the stored value is a bare domain
      // (e.g. "m.dianping.com") without a site: prefix, wrap it so
      // extractSiteDomains can parse it correctly.
      const normalised = /^site:/i.test(raw) ? raw : raw ? `site:${raw}` : "";
      const ext = extractSiteDomains(normalised);
      all.push(...ext.domains);
    }
    return Array.from(new Set(all));
  } catch {
    return [];
  }
}

function langForCategory(category?: string): { lang: string; country?: string } {
  if (!category) return { lang: "zh-Hant", country: "hk" };
  if (category === "food") return { lang: "zh" };
  if (FOOD_GLOBAL_CATEGORIES.has(category)) return { lang: "en", country: "us" };
  return { lang: "zh-Hant", country: "hk" };
}

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

    const { cleaned, domains: inlineDomains } = extractSiteDomains(query);
    let allDomains = [...inlineDomains];

    if (category) {
      const catDomains = await lookupCategoryDomains(category, priority);
      allDomains = Array.from(new Set([...allDomains, ...catDomains]));
    }

    const baseQ = cleaned || query;
    const limitedDomains = allDomains.slice(0, 4);
    const siteFilter =
      limitedDomains.length > 0
        ? " " + limitedDomains.map((d) => `site:${d}`).join(" OR ")
        : "";
    const q = baseQ + siteFilter;

    const { lang, country } = langForCategory(category);
    const searchBody: Record<string, unknown> = {
      query: q,
      limit: 5,
      lang,
    };
    if (country) searchBody.country = country;

    const resp = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(searchBody),
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
      data?: Array<{
        url?: string;
        title?: string;
        description?: string;
      }>;
    };

    if (!data.success || !data.data?.length) {
      return new Response(
        JSON.stringify({ summary: `No Firecrawl results for "${query}".`, category: category ?? null, domains: allDomains }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const results = data.data.slice(0, 3);
    const parts: string[] = [];
    results.forEach((r, i) => {
      const title = r.title ?? "Untitled";
      const url = r.url ?? "";
      const description = (r.description ?? "").replace(/\s+/g, " ").trim();
      parts.push(`${i + 1}. ${title}${url ? ` (${url})` : ""}\n${description}`);
    });
    const summary = parts.join("\n\n");

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
