import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "tensorleap.plugin-github-webhook-dispatcher",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub Webhook Dispatcher",
  description: "Receives GitHub webhook events and dispatches wake comments to matching TEN issues. Handles pull_request, pull_request_review, issues, issue_comment, and check_suite events across tensorleap repos.",
  author: "Tensorleap",
  categories: ["connector", "automation"],
  capabilities: [
    "webhooks.receive",
    "issues.read",
    "issues.create",
    "issue.comments.create",
    "issue.documents.read",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
  ],
  instanceConfigSchema: {
    type: "object",
    required: ["companyId", "webhookSecretRef"],
    properties: {
      companyId: {
        type: "string",
        title: "Company ID",
        description: "Paperclip company whose issues should receive GitHub event comments.",
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
      displayName: "GitHub Events",
      description: "Receives PR, issue, and CI events from tensorleap GitHub repos",
    },
  ],
};

export default manifest;
