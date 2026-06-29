import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from "@/lib/voice/systemPrompt";
import {
  getSystemPrompt,
  saveSystemPrompt,
  resetSystemPrompt,
} from "@/lib/voice/prompt.functions";
import {
  listKnowledge,
  upsertKnowledge,
  deleteKnowledge,
} from "@/lib/voice/knowledge.functions";
import {
  getProviderSettings,
  saveProviderSettings,
  LLM_PROVIDERS,
  TTS_PROVIDERS,
  OPENROUTER_MODELS,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_SYNTH_MODELS,
  DEFAULT_OPENROUTER_SYNTH_MODEL,
  GREETING_MODELS,
  DEFAULT_GREETING_MODEL,
  type LlmProvider,
  type TtsProvider,
} from "@/lib/voice/providerSettings.functions";

export const Route = createFileRoute("/instruction")({
  head: () => ({
    meta: [
      { title: "Edit Instructions — Voice Companion" },
      {
        name: "description",
        content:
          "Edit the system prompt and knowledge base used by the voice companion.",
      },
    ],
  }),
  component: InstructionPage,
});

type KbRow = { id: number; content_text: string | null; updated_at: string };

function InstructionPage() {
  const fetchPrompt = useServerFn(getSystemPrompt);
  const savePrompt = useServerFn(saveSystemPrompt);
  const resetPrompt = useServerFn(resetSystemPrompt);
  const fetchKb = useServerFn(listKnowledge);
  const upsertKb = useServerFn(upsertKnowledge);
  const deleteKb = useServerFn(deleteKnowledge);
  const fetchProviders = useServerFn(getProviderSettings);
  const saveProviders = useServerFn(saveProviderSettings);

  const [llmProvider, setLlmProvider] = useState<LlmProvider>("gemini");
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("google");
  const [openrouterModel, setOpenrouterModel] = useState<string>(DEFAULT_OPENROUTER_MODEL);
  const [openrouterSynthModel, setOpenrouterSynthModel] = useState<string>(
    DEFAULT_OPENROUTER_SYNTH_MODEL,
  );
  const [greetingModel, setGreetingModel] = useState<string>(DEFAULT_GREETING_MODEL);
  const [savedLlm, setSavedLlm] = useState<LlmProvider>("gemini");
  const [savedTts, setSavedTts] = useState<TtsProvider>("google");
  const [savedOrModel, setSavedOrModel] = useState<string>(DEFAULT_OPENROUTER_MODEL);
  const [savedOrSynthModel, setSavedOrSynthModel] = useState<string>(
    DEFAULT_OPENROUTER_SYNTH_MODEL,
  );
  const [savedGrModel, setSavedGrModel] = useState<string>(DEFAULT_GREETING_MODEL);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerStatus, setProviderStatus] = useState("");

  const [value, setValue] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [isDefault, setIsDefault] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const [rows, setRows] = useState<KbRow[]>([]);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [newEntry, setNewEntry] = useState("");
  const [kbStatus, setKbStatus] = useState("");

  const loadKb = async () => {
    const data = await fetchKb();
    setRows(data);
    setDrafts(Object.fromEntries(data.map((r) => [r.id, r.content_text ?? ""])));
  };

  useEffect(() => {
    void (async () => {
      try {
        const [{ template, updatedAt }, providers] = await Promise.all([
          fetchPrompt(),
          fetchProviders().catch(() => ({
            llm: "gemini" as LlmProvider,
            tts: "google" as TtsProvider,
            openrouterModel: DEFAULT_OPENROUTER_MODEL,
            greetingModel: DEFAULT_GREETING_MODEL,
          })),
          loadKb().catch((e) => setKbStatus(`load failed: ${(e as Error).message}`)),
        ]);
        const effective = template ?? DEFAULT_SYSTEM_PROMPT_TEMPLATE;
        setValue(effective);
        setIsDefault(template === null);
        setUpdatedAt(updatedAt);
        setLlmProvider(providers.llm);
        setTtsProvider(providers.tts);
        setOpenrouterModel(providers.openrouterModel ?? DEFAULT_OPENROUTER_MODEL);
        setGreetingModel(providers.greetingModel ?? DEFAULT_GREETING_MODEL);
        setSavedLlm(providers.llm);
        setSavedTts(providers.tts);
        setSavedOrModel(providers.openrouterModel ?? DEFAULT_OPENROUTER_MODEL);
        setSavedGrModel(providers.greetingModel ?? DEFAULT_GREETING_MODEL);
      } catch (err) {
        setStatus(`Load failed: ${(err as Error).message}`);
        setValue(DEFAULT_SYSTEM_PROMPT_TEMPLATE);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const providerDirty =
    llmProvider !== savedLlm ||
    ttsProvider !== savedTts ||
    (llmProvider === "openrouter" && openrouterModel !== savedOrModel) ||
    greetingModel !== savedGrModel;

  const onSaveProviders = async () => {
    setProviderSaving(true);
    setProviderStatus("Saving…");
    try {
      await saveProviders({
        data: { llm: llmProvider, tts: ttsProvider, openrouterModel, greetingModel },
      });
      setSavedLlm(llmProvider);
      setSavedTts(ttsProvider);
      setSavedOrModel(openrouterModel);
      setSavedGrModel(greetingModel);
      const tag =
        llmProvider === "openrouter"
          ? `${llmProvider}:${openrouterModel}`
          : llmProvider;
      setProviderStatus(
        `Saved (LLM=${tag}, TTS=${ttsProvider}) at ${new Date().toLocaleTimeString()}.`,
      );
    } catch (e) {
      setProviderStatus(`Save failed: ${(e as Error).message}`);
    } finally {
      setProviderSaving(false);
    }
  };

  const onSave = async () => {
    setSaving(true);
    setStatus("");
    try {
      await savePrompt({ data: { template: value } });
      setIsDefault(false);
      setUpdatedAt(new Date().toISOString());
      setStatus(`Saved at ${new Date().toLocaleTimeString()}.`);
    } catch (err) {
      setStatus(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const onReset = async () => {
    setSaving(true);
    setStatus("");
    try {
      await resetPrompt();
      setValue(DEFAULT_SYSTEM_PROMPT_TEMPLATE);
      setIsDefault(true);
      setUpdatedAt(null);
      setStatus(`Reset to default at ${new Date().toLocaleTimeString()}.`);
    } catch (err) {
      setStatus(`Reset failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const onSaveRow = async (id: number) => {
    setKbStatus("");
    try {
      await upsertKb({ data: { id, content_text: drafts[id] ?? "" } });
      await loadKb();
      setKbStatus(`Row ${id} saved.`);
    } catch (e) {
      setKbStatus(`Save failed: ${(e as Error).message}`);
    }
  };

  const onDeleteRow = async (id: number) => {
    if (!confirm(`Delete entry ${id}?`)) return;
    try {
      await deleteKb({ data: { id } });
      await loadKb();
      setKbStatus(`Row ${id} deleted.`);
    } catch (e) {
      setKbStatus(`Delete failed: ${(e as Error).message}`);
    }
  };

  const onAddRow = async () => {
    if (!newEntry.trim()) return;
    try {
      await upsertKb({ data: { content_text: newEntry } });
      setNewEntry("");
      await loadKb();
      setKbStatus("Added new entry.");
    } catch (e) {
      setKbStatus(`Add failed: ${(e as Error).message}`);
    }
  };

  const totalChars = rows.reduce(
    (n, r) => n + (r.content_text?.length ?? 0),
    0,
  );

  return (
    <main className="min-h-screen bg-background text-foreground px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-8">
        <header className="space-y-2">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to voice companion
          </Link>
          <h1 className="text-2xl font-semibold">LLM Instructions</h1>
          <p className="text-sm text-muted-foreground">
            System prompt sent to the model on every voice session. Stored in the
            cloud and synced across all your devices. Use{" "}
            <code className="px-1 py-0.5 rounded bg-muted">{`{{context}}`}</code>{" "}
            where the knowledge base should be injected.
          </p>
        </header>

        <section className="rounded-md border border-border p-4 space-y-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">Voice providers</h2>
            <span className="text-xs text-muted-foreground">{providerStatus}</span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 block">
              <span className="text-sm font-medium">Brain (LLM)</span>
              <select
                value={llmProvider}
                onChange={(e) => setLlmProvider(e.target.value as LlmProvider)}
                disabled={loading}
                className="w-full rounded-md border border-border bg-card text-card-foreground p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              >
                {LLM_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span className="block text-xs text-muted-foreground">
                {LLM_PROVIDERS.find((p) => p.value === llmProvider)?.note}
              </span>
            </label>

            <label className="space-y-1.5 block">
              <span className="text-sm font-medium">Mouth (TTS)</span>
              <select
                value={ttsProvider}
                onChange={(e) => setTtsProvider(e.target.value as TtsProvider)}
                disabled={loading}
                className="w-full rounded-md border border-border bg-card text-card-foreground p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              >
                {TTS_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value} disabled={!p.available}>
                    {p.label}{p.available ? "" : " — coming soon"}
                  </option>
                ))}
              </select>
              <span className="block text-xs text-muted-foreground">
                {TTS_PROVIDERS.find((p) => p.value === ttsProvider)?.note}
              </span>
            </label>
          </div>

          {llmProvider === "openrouter" && (
            <label className="space-y-1.5 block">
              <span className="text-sm font-medium">OpenRouter model</span>
              <select
                value={openrouterModel}
                onChange={(e) => setOpenrouterModel(e.target.value)}
                disabled={loading}
                className="w-full rounded-md border border-border bg-card text-card-foreground p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              >
                {OPENROUTER_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label} — {m.value}
                  </option>
                ))}
              </select>
              <span className="block text-xs text-muted-foreground">
                Routed via openrouter.ai. Pricing depends on the selected model — see openrouter.ai/models.
              </span>
            </label>
          )}

          <label className="space-y-1.5 block">
            <span className="text-sm font-medium">Greeting model</span>
            <select
              value={greetingModel}
              onChange={(e) => setGreetingModel(e.target.value)}
              disabled={loading}
              className="w-full rounded-md border border-border bg-card text-card-foreground p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            >
              {GREETING_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label} — {m.value}
                </option>
              ))}
            </select>
            <span className="block text-xs text-muted-foreground">
              Fast OpenRouter model used only for the personalised greeting (Shot 2). Requires OPENROUTER_API_KEY. Separate from the main synthesiser model.
            </span>
          </label>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSaveProviders}
              disabled={!providerDirty || providerSaving || loading}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {providerSaving ? "Saving…" : "Save providers"}
            </button>
            <span className="text-xs text-muted-foreground">
              Saved: LLM={savedLlm}, TTS={savedTts}
              {providerDirty && " · unsaved changes"}
            </span>
          </div>
        </section>


        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          disabled={loading}
          className="w-full min-h-[420px] rounded-md border border-border bg-card text-card-foreground p-4 font-mono text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        />

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={loading || saving}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save prompt"}
          </button>
          <button
            type="button"
            onClick={onReset}
            disabled={loading || saving}
            className="px-4 py-2 rounded-md border border-border text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            Reset to default
          </button>
          <span className="text-xs text-muted-foreground">
            {loading
              ? "Loading…"
              : isDefault
                ? "Using default prompt."
                : `Custom prompt${updatedAt ? ` (saved ${new Date(updatedAt).toLocaleString()})` : ""}.`}
            {status && ` ${status}`}
          </span>
        </div>

        <section className="rounded-md border border-border p-4 space-y-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold">
              Knowledge base{" "}
              <code className="text-xs text-muted-foreground">(knowledge_base → {`{{context}}`})</code>
            </h2>
            <span className="text-xs text-muted-foreground">
              {rows.length} entries · {totalChars} chars
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Each row's <code>content_text</code> is concatenated (blank line
            between) and injected into <code>{`{{context}}`}</code> in the
            system prompt. Edit, add, or delete entries here — changes take
            effect the next time you press <em>Start</em>.
          </p>

          {rows.length === 0 && (
            <p className="text-sm text-muted-foreground italic">
              No entries yet. Add one below.
            </p>
          )}

          {rows.map((r) => (
            <div key={r.id} className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  #{r.id} · updated {new Date(r.updated_at).toLocaleString()}
                </span>
                <button
                  type="button"
                  onClick={() => onDeleteRow(r.id)}
                  className="text-destructive hover:underline"
                >
                  Delete
                </button>
              </div>
              <textarea
                value={drafts[r.id] ?? ""}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [r.id]: e.target.value }))
                }
                className="w-full min-h-[120px] rounded-md border border-border bg-card p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => onSaveRow(r.id)}
                disabled={(drafts[r.id] ?? "") === (r.content_text ?? "")}
                className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50"
              >
                Save row
              </button>
            </div>
          ))}

          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-xs font-medium">Add new entry</p>
            <textarea
              value={newEntry}
              onChange={(e) => setNewEntry(e.target.value)}
              placeholder="e.g. 明囡住喺香港九龍塘，鍾意飲普洱茶…"
              className="w-full min-h-[100px] rounded-md border border-border bg-card p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="button"
              onClick={onAddRow}
              disabled={!newEntry.trim()}
              className="px-3 py-1.5 rounded-md border border-border text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              Add entry
            </button>
          </div>

          {kbStatus && (
            <p className="text-xs text-muted-foreground">{kbStatus}</p>
          )}
        </section>

        <details className="rounded-md border border-border p-4 text-sm">
          <summary className="cursor-pointer font-medium">
            View default prompt (reference)
          </summary>
          <pre className="mt-3 whitespace-pre-wrap font-mono text-xs text-muted-foreground">
            {DEFAULT_SYSTEM_PROMPT_TEMPLATE}
          </pre>
        </details>
      </div>
    </main>
  );
}
