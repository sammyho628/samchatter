import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  getSystemPromptTemplate,
  resetSystemPromptTemplate,
  saveSystemPromptTemplate,
} from "@/lib/voice/systemPrompt";

export const Route = createFileRoute("/instruction")({
  head: () => ({
    meta: [
      { title: "Edit Instructions — Voice Companion" },
      {
        name: "description",
        content:
          "Edit the system prompt used by the voice companion LLM to fine-tune its behaviour without redeploying.",
      },
    ],
  }),
  component: InstructionPage,
});

function InstructionPage() {
  const [value, setValue] = useState<string>("");
  const [savedAt, setSavedAt] = useState<string>("");
  const [isDefault, setIsDefault] = useState(true);

  useEffect(() => {
    const current = getSystemPromptTemplate();
    setValue(current);
    setIsDefault(current === DEFAULT_SYSTEM_PROMPT_TEMPLATE);
  }, []);

  const onSave = () => {
    saveSystemPromptTemplate(value);
    setSavedAt(new Date().toLocaleTimeString());
    setIsDefault(value === DEFAULT_SYSTEM_PROMPT_TEMPLATE);
  };

  const onReset = () => {
    resetSystemPromptTemplate();
    setValue(DEFAULT_SYSTEM_PROMPT_TEMPLATE);
    setIsDefault(true);
    setSavedAt(new Date().toLocaleTimeString());
  };

  return (
    <main className="min-h-screen bg-background text-foreground px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-2">
          <Link
            to="/"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Back to voice companion
          </Link>
          <h1 className="text-2xl font-semibold">LLM Instructions</h1>
          <p className="text-sm text-muted-foreground">
            This is the system prompt sent to the model on every voice session.
            Edit it freely to tune tone, language, or tool-use behaviour. Use{" "}
            <code className="px-1 py-0.5 rounded bg-muted">{`{{context}}`}</code>{" "}
            where the family / local context should be injected. Changes save
            to this browser and take effect the next time you press{" "}
            <em>Start</em>.
          </p>
        </header>

        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          className="w-full min-h-[480px] rounded-md border border-border bg-card text-card-foreground p-4 font-mono text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
        />

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onReset}
            className="px-4 py-2 rounded-md border border-border text-sm font-medium hover:bg-muted"
          >
            Reset to default
          </button>
          <span className="text-xs text-muted-foreground">
            {isDefault ? "Using default prompt." : "Using your custom prompt."}
            {savedAt && ` Last saved at ${savedAt}.`}
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
