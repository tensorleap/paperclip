import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.github-pr-events",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub PR Events",
  description: "Bridges GitHub pull_request and pull_request_review webhook events into Paperclip issue comments, waking the assignee agent automatically when a linked PR is merged or reviewed.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "issues.read",
    "issues.wakeup",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "webhooks.receive",
  ],
  instanceConfigSchema: {
    type: "object",
    required: ["companyId", "webhookSecretRef"],
    properties: {
      companyId: {
        type: "string",
        title: "Company ID",
        description: "Paperclip company whose issues should be matched and notified.",
        default: "",
      },
      webhookSecretRef: {
        type: "string",
        title: "Webhook Secret Ref",
        description: "Company secret UUID used to verify GitHub's X-Hub-Signature-256 header.",
        format: "secret-ref",
        default: "",
      },
    },
  },
  entrypoints: {
    worker: "./dist/worker.js",
  },
  webhooks: [
    {
      endpointKey: "github",
      displayName: "GitHub Webhook",
      description: "Receives pull_request and pull_request_review events from GitHub.",
    },
  ],
};

export default manifest;
