import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from "@/lib/voice/systemPrompt";
import {
  getSystemPrompt,
  saveSystemPrompt,
  resetSystemPrompt,
} from "@/lib/voice/prompt.functions";
import { getVoiceSession } from "@/lib/voice/session.functions";

export const Route = createFileRoute("/instruction")({
  head: () => ({
    meta: [
      { title: "Edit Instructions — Voice Companion" },
      {
        name: "description",
        content:
          "Edit the system prompt used by the voice companion LLM. Syncs across all your devices.",
      },
    ],
  }),
  component: InstructionPage,
});

function InstructionPage() {
  const fetchPrompt = useServerFn(getSystemPrompt);
  const savePrompt = useServerFn(saveSystemPrompt);
  const resetPrompt = useServerFn(resetSystemPrompt);
  const fetchSession = useServerFn(getVoiceSession);

  const [value, setValue] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [isDefault, setIsDefault] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [contextText, setContextText] = useState<string>("");
  const [contextErr, setContextErr] = useState<string>("");

  useEffect(() => {
    void (async () => {
      try {
        const [{ template, updatedAt }, session] = await Promise.all([
          fetchPrompt(),
          fetchSession().catch((e) => {
            setContextErr((e as Error).message);
            return { contextText: "" } as { contextText: string };
          }),
        ]);
        const effective = template ?? DEFAULT_SYSTEM_PROMPT_TEMPLATE;
        setValue(effective);
        setIsDefault(template === null);
        setUpdatedAt(updatedAt);
        setContextText(session.contextText ?? "");
      } catch (err) {
        setStatus(`Load failed: ${(err as Error).message}`);
        setValue(DEFAULT_SYSTEM_PROMPT_TEMPLATE);
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchPrompt, fetchSession]);

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

  return (
    <main className="min-h-screen bg-background text-foreground px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-2">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← Back to voice companion
          </Link>
          <h1 className="text-2xl font-semibold">LLM Instructions</h1>
          <p className="text-sm text-muted-foreground">
            This is the system prompt sent to the model on every voice session.
            It is stored in the cloud and syncs across all your devices. Use{" "}
            <code className="px-1 py-0.5 rounded bg-muted">{`{{context}}`}</code>{" "}
            where the family / local context should be injected. Changes take
            effect the next time you press <em>Start</em>.
          </p>
        </header>

        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          disabled={loading}
          className="w-full min-h-[480px] rounded-md border border-border bg-card text-card-foreground p-4 font-mono text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        />

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={loading || saving}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
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
                : `Using your custom prompt${updatedAt ? ` (saved ${new Date(updatedAt).toLocaleString()})` : ""}.`}
            {status && ` ${status}`}
          </span>
        </div>

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
