export type VoiceSettings = {
  geminiKey: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
};

const KEYS = {
  geminiKey: "vc.geminiKey",
  supabaseUrl: "vc.supabaseUrl",
  supabaseAnonKey: "vc.supabaseAnonKey",
} as const;

export function loadSettings(): VoiceSettings {
  if (typeof window === "undefined") {
    return { geminiKey: "", supabaseUrl: "", supabaseAnonKey: "" };
  }
  return {
    geminiKey: localStorage.getItem(KEYS.geminiKey) ?? "",
    supabaseUrl: localStorage.getItem(KEYS.supabaseUrl) ?? "",
    supabaseAnonKey: localStorage.getItem(KEYS.supabaseAnonKey) ?? "",
  };
}

export function saveSettings(s: VoiceSettings) {
  localStorage.setItem(KEYS.geminiKey, s.geminiKey.trim());
  localStorage.setItem(KEYS.supabaseUrl, s.supabaseUrl.trim());
  localStorage.setItem(KEYS.supabaseAnonKey, s.supabaseAnonKey.trim());
}

export function settingsComplete(s: VoiceSettings) {
  return !!(s.geminiKey && s.supabaseUrl && s.supabaseAnonKey);
}
