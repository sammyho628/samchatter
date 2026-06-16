// Supabase Edge Function: search-places
// Calls Google Places (Text Search) and returns a compact text summary.
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
    const apiKey = Deno.env.get("GOOGLE_PLACES_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Missing GOOGLE_PLACES_API_KEY" }),
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

    const resp = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.rating",
      },
      body: JSON.stringify({ textQuery: query }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: `Places API error ${resp.status}: ${txt.slice(0, 300)}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const data = (await resp.json()) as {
      places?: Array<{
        displayName?: { text?: string };
        formattedAddress?: string;
        rating?: number;
      }>;
    };
    const top = (data.places ?? []).slice(0, 3);
    const summary = top.length === 0
      ? `No results found for "${query}".`
      : top
          .map((p, i) => {
            const name = p.displayName?.text ?? "Unknown";
            const addr = p.formattedAddress ?? "Unknown address";
            const rating = typeof p.rating === "number" ? ` (rating ${p.rating})` : "";
            return `${i + 1}. ${name}${rating} — ${addr}`;
          })
          .join("\n");

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
