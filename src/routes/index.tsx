import { createFileRoute } from "@tanstack/react-router";
import { VoiceCompanion } from "@/components/VoiceCompanion";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "傾偈 — Voice Companion" },
      {
        name: "description",
        content: "A warm Cantonese voice companion for elderly family members.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  return <VoiceCompanion />;
}
