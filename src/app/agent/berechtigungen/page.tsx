import type { Metadata } from "next";
import { PermissionsPanel } from "@/components/agent-permissions";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Berechtigungen – Agent" };

export default function AgentPermissionsPage() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader back={{ href: "/agent", label: "Agent" }} title="Berechtigungen" />
      <PermissionsPanel />
    </div>
  );
}
