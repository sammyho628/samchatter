CREATE TABLE public.chat_turns (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Hong_Kong')::date),
  role text NOT NULL CHECK (role IN ('user','model')),
  text_content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_turns_date_created_idx ON public.chat_turns (session_date, created_at);
GRANT ALL ON public.chat_turns TO service_role;
ALTER TABLE public.chat_turns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role manages chat turns" ON public.chat_turns FOR ALL TO service_role USING (true) WITH CHECK (true);