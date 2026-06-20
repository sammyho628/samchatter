
-- 1. Rename old category
UPDATE public.trusted_domains SET category = 'hk_news' WHERE category = 'news';

-- 2. Add priority column
ALTER TABLE public.trusted_domains ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 1;

-- 3. Seed full 12-category tier grid
INSERT INTO public.trusted_domains (category, domain_query_string, priority) VALUES
  ('world_news', 'site:reuters.com OR site:bbc.com OR site:apnews.com', 1),
  ('world_news', 'site:bloomberg.com OR site:cnn.com OR site:theguardian.com', 2),
  ('stocks',     'site:hk.finance.yahoo.com OR site:finance.yahoo.com', 1),
  ('stocks',     'site:hkex.com.hk OR site:bloomberg.com OR site:google.com/finance', 2),
  ('finance',    'site:hkma.gov.hk OR site:mpfa.org.hk OR site:ia.org.hk', 1),
  ('finance',    'site:investopedia.com OR site:bloomberg.com OR site:hsbc.com.hk', 2),
  ('weather',    'site:weather.gov.hk OR site:hko.gov.hk', 1),
  ('sports',     'site:espn.com OR site:bbc.com/sport OR site:goal.com', 1),
  ('sports',     'site:livescore.com OR site:reuters.com/sports', 2),
  ('transport',  'site:mtr.com.hk OR site:td.gov.hk OR site:kmb.hk', 1),
  ('transport',  'site:bravobus.com.hk OR site:nwstbus.com.hk', 2),
  ('travel',     'site:discoverhongkong.com OR site:ctrip.com', 1),
  ('travel',     'site:mfa.gov.cn OR site:immd.gov.hk', 2),
  ('government', 'site:gov.hk OR site:swd.gov.hk OR site:elderly.gov.hk', 1),
  ('technology', 'site:techcrunch.com OR site:theverge.com OR site:cnet.com', 1),
  ('technology', 'site:gsmarena.com OR site:scmp.com/tech', 2);
