import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AgentHistory } from "@/components/agent-history";

export const metadata: Metadata = { title: "Agent" };

// Unterhaltungs-IDs sind erst zur Laufzeit bekannt; die Seite ist ohnehin rein clientseitig (lädt per API)
export const instant = false;

export default async function AgentSessionPage({ params }: PageProps<"/agent/[id]">) {
  const { id } = await params;
  if (!/^\d{1,12}$/.test(id)) notFound();
  return <AgentHistory activeId={Number(id)} />;
}
