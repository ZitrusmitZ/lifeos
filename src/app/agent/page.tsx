import type { Metadata } from "next";
import { AgentHistory } from "@/components/agent-history";

export const metadata: Metadata = { title: "Agent" };

export default function AgentPage() {
  return <AgentHistory activeId={null} />;
}
