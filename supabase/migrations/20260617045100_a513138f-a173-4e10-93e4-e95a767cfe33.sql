-- Remove public read policy on knowledge_base (contains PII; only accessed via service role server-side)
DROP POLICY IF EXISTS "Anyone can read knowledge base" ON public.knowledge_base;

-- Add explicit service-role policy for app_settings (documents intent; accessed only via service role)
CREATE POLICY "Service role manages app settings"
ON public.app_settings
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);