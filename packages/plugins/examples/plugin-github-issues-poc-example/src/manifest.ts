import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.plugin-github-issues-poc-example",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub Concierge Webhook POC",
  description: "Creates Concierge project issues for Marvin-assigned GitHub work in tensorleap/concierge and mirrors issue or related PR activity back into Paperclip.",
  author: "Paperclip",
  categories: ["connector", "automation"],
  capabilities: [
    "agents.read",
    "projects.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "ui.dashboardWidget.register",
    "webhooks.receive"
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      companyId: {
        type: "string",
        title: "Company ID",
        description: "Paperclip company that will receive mirrored Concierge issues.",
        default: "",
      },
      projectId: {
        type: "string",
        title: "Target Project ID",
        description: "Project where new Paperclip issues will be created.",
        default: "",
      },
      webhookSecretRef: {
        type: "string",
        title: "Webhook Secret Ref",
        description: "Company secret UUID used to verify GitHub's X-Hub-Signature-256 header.",
        format: "secret-ref",
        default: "",
      },
      repositoryFullName: {
        type: "string",
        title: "GitHub Repository",
        description: "Only webhooks from this repository are processed.",
        default: "tensorleap/concierge",
      },
      syncMode: {
        type: "string",
        title: "Sync Mode",
        description: "GitHub-to-Paperclip sync policy shown on mirrored issues.",
        default: "inbound_only",
      },
      assigneeRoutes: {
        type: "array",
        title: "GitHub Assignee Routes",
        description: "Explicit GitHub assignee login to Paperclip assignee mappings.",
        default: [
          {
            githubAssigneeLogin: "marvin-tensorleap",
            paperclipAssigneeAgentId: "",
            paperclipAssigneeLabel: "CEO",
          },
        ],
        items: {
          type: "object",
          properties: {
            githubAssigneeLogin: {
              type: "string",
              title: "GitHub Assignee Login",
              default: "marvin-tensorleap",
            },
            paperclipAssigneeAgentId: {
              type: "string",
              title: "Paperclip Assignee Agent ID",
              default: "",
            },
            paperclipAssigneeLabel: {
              type: "string",
              title: "Paperclip Assignee Label",
              description: "Optional human-readable label shown on mirrored issues.",
              default: "",
            },
          },
          required: ["githubAssigneeLogin", "paperclipAssigneeAgentId"],
        },
      },
      issueTitlePrefix: {
        type: "string",
        title: "Paperclip Issue Title Prefix",
        description: "Prefix added to Paperclip issues created from GitHub.",
        default: "[GitHub]",
      },
    },
  },
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  webhooks: [
    {
      endpointKey: "github",
      displayName: "GitHub Webhook",
      description: "Receives GitHub issue and pull request events for tensorleap/concierge.",
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "GitHub Concierge Sync",
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
