
CREATE TABLE public.chat_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  summary_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Hong_Kong')::date,
  conversation_summary text NOT NULL,
  executed_searches text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.chat_memory TO service_role;
ALTER TABLE public.chat_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages chat memory" ON public.chat_memory FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX chat_memory_summary_date_idx ON public.chat_memory (summary_date DESC, created_at DESC);

CREATE TABLE public.daily_cache (
  id bigserial PRIMARY KEY,
  topic text NOT NULL UNIQUE,
  content text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.daily_cache TO service_role;
ALTER TABLE public.daily_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages daily cache" ON public.daily_cache FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.trusted_domains (
  id bigserial PRIMARY KEY,
  category text NOT NULL,
  domain_query_string text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.trusted_domains TO service_role;
ALTER TABLE public.trusted_domains ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages trusted domains" ON public.trusted_domains FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX trusted_domains_category_idx ON public.trusted_domains (category);

INSERT INTO public.trusted_domains (category, domain_query_string, description) VALUES
  ('health', 'site:ha.org.hk OR site:elderly.gov.hk OR site:chp.gov.hk', 'Hong Kong public health authorities'),
  ('finance', 'site:hkex.com.hk OR site:finance.yahoo.com OR site:hkma.gov.hk', 'HK & global finance sources'),
  ('news', 'site:rthk.hk OR site:hk01.com OR site:scmp.com', 'HK news outlets'),
  ('shopping', 'site:parknshop.com OR site:hktvmall.com OR site:price.com.hk', 'HK shopping & price comparison');
