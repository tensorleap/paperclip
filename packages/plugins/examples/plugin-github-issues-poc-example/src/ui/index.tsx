import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";

type HealthData = {
  status: "ok" | "degraded";
  checkedAt: string;
  companyId: string | null;
  projectId: string | null;
  repositoryFullName: string;
  syncMode: string;
  assigneeRoutes: Array<{
    githubAssigneeLogin: string;
    paperclipAssigneeAgentId: string;
    paperclipAssigneeLabel: string | null;
  }>;
  webhookSecretConfigured: boolean;
  webhookPath: string;
  lastDelivery: {
    deliveryId: string;
    eventType: string;
    action: string;
    processed: boolean;
    reason: string;
    mappedIssueId: string | null;
    processedAt: string;
  } | null;
};

export function DashboardWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<HealthData>("health");

  if (loading) return <div>Loading plugin health...</div>;
  if (error) return <div>Plugin error: {error.message}</div>;

  return (
    <div style={{ display: "grid", gap: "0.5rem", fontSize: "0.9rem" }}>
      <strong>GitHub Concierge Webhook</strong>
      <div>Status: {data?.status ?? "unknown"}</div>
      <div>Repository: {data?.repositoryFullName ?? "unconfigured"}</div>
      <div>Sync mode: {data?.syncMode ?? "unconfigured"}</div>
      <div>Company: {data?.companyId ?? "missing"}</div>
      <div>Project: {data?.projectId ?? "missing"}</div>
      <div>
        Routes: {data?.assigneeRoutes?.length
          ? data.assigneeRoutes
            .map((route) => `${route.githubAssigneeLogin} -> ${route.paperclipAssigneeLabel ?? route.paperclipAssigneeAgentId}`)
            .join(", ")
          : "missing"}
      </div>
      <div>Secret configured: {data?.webhookSecretConfigured ? "yes" : "no"}</div>
      <div>Webhook path: <code>{data?.webhookPath ?? "unavailable"}</code></div>
      <div>Checked: {data?.checkedAt ?? "never"}</div>
      {data?.lastDelivery ? (
        <div style={{ display: "grid", gap: "0.25rem", paddingTop: "0.5rem", borderTop: "1px solid var(--border, #ddd)" }}>
          <strong>Last delivery</strong>
          <div>ID: <code>{data.lastDelivery.deliveryId}</code></div>
          <div>Event: {data.lastDelivery.eventType}.{data.lastDelivery.action}</div>
          <div>Processed: {data.lastDelivery.processed ? "yes" : "no"}</div>
          <div>Reason: {data.lastDelivery.reason}</div>
          <div>Mapped issue: {data.lastDelivery.mappedIssueId ?? "none"}</div>
          <div>At: {data.lastDelivery.processedAt}</div>
        </div>
      ) : null}
    </div>
  );
}
