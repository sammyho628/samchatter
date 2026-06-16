import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { loadSettings, saveSettings, type VoiceSettings } from "@/lib/voice/settings";

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: (s: VoiceSettings) => void;
};

export function SettingsSheet({ open, onOpenChange, onSaved }: Props) {
  const [state, setState] = useState<VoiceSettings>(() => loadSettings());

  const update = (k: keyof VoiceSettings, v: string) =>
    setState((s) => ({ ...s, [k]: v }));

  const save = () => {
    saveSettings(state);
    onSaved(state);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[90vh] overflow-y-auto">
        <SheetHeader className="text-left">
          <SheetTitle className="text-2xl">設定 Settings</SheetTitle>
          <SheetDescription>
            Stored locally on this device only. The Gemini key will be sent
            directly from your browser — only use on a private device.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="gemini" className="text-base">
              Gemini API Key
            </Label>
            <Input
              id="gemini"
              type="password"
              autoComplete="off"
              value={state.geminiKey}
              onChange={(e) => update("geminiKey", e.target.value)}
              className="h-12 text-base"
              placeholder="AIza..."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="surl" className="text-base">
              Supabase URL
            </Label>
            <Input
              id="surl"
              value={state.supabaseUrl}
              onChange={(e) => update("supabaseUrl", e.target.value)}
              className="h-12 text-base"
              placeholder="https://xxx.supabase.co"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="skey" className="text-base">
              Supabase Anon Key
            </Label>
            <Input
              id="skey"
              type="password"
              autoComplete="off"
              value={state.supabaseAnonKey}
              onChange={(e) => update("supabaseAnonKey", e.target.value)}
              className="h-12 text-base"
              placeholder="eyJ..."
            />
          </div>
        </div>

        <SheetFooter className="mt-8">
          <Button onClick={save} className="h-14 w-full text-lg">
            儲存 Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
