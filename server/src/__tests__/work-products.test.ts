import { describe, expect, it, vi } from "vitest";
import { workProductService } from "../services/work-products.ts";

function createWorkProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-03-17T00:00:00.000Z");
  return {
    id: "work-product-1",
    companyId: "company-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "PR 1",
    url: "https://example.com/pr/1",
    status: "open",
    reviewState: "draft",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("workProductService", () => {
  it("uses a transaction when creating a new primary work product", async () => {
    const updatedWhere = vi.fn(async () => undefined);
    const updateSet = vi.fn(() => ({ where: updatedWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const insertedRow = createWorkProductRow();
    const insertReturning = vi.fn(async () => [insertedRow]);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const tx = {
      update: txUpdate,
      insert: txInsert,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.createForIssue("issue-1", "company-1", {
      type: "pull_request",
      provider: "github",
      title: "PR 1",
      status: "open",
      reviewState: "draft",
      isPrimary: true,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(result?.id).toBe("work-product-1");
  });

  it("uses a transaction when promoting an existing work product to primary", async () => {
    const existingRow = createWorkProductRow({ isPrimary: false });

    const selectWhere = vi.fn(async () => [existingRow]);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const txSelect = vi.fn(() => ({ from: selectFrom }));

    const updateReturning = vi
      .fn()
      .mockResolvedValue([createWorkProductRow({ reviewState: "ready_for_review" })]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const tx = {
      select: txSelect,
      update: txUpdate,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.update("work-product-1", {
      isPrimary: true,
      reviewState: "ready_for_review",
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txSelect).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(result?.reviewState).toBe("ready_for_review");
  });

  it("upserts an existing work product when the same provider external id is linked again", async () => {
    const existingRow = createWorkProductRow({
      externalId: "tensorleap/concierge#28",
      title: "Old title",
      status: "draft",
      metadata: { merged: false },
    });

    const selectWhere = vi.fn(async () => [existingRow]);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const txSelect = vi.fn(() => ({ from: selectFrom }));

    const updatedRow = createWorkProductRow({
      externalId: "tensorleap/concierge#28",
      title: "Clarify onboarding docs",
      status: "merged",
      metadata: { merged: true },
    });
    const updateReturning = vi.fn(async () => [updatedRow]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));
    const txInsert = vi.fn();

    const tx = {
      select: txSelect,
      update: txUpdate,
      insert: txInsert,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.upsertForIssue("issue-1", "company-1", {
      type: "pull_request",
      provider: "github",
      externalId: "tensorleap/concierge#28",
      title: "Clarify onboarding docs",
      status: "merged",
      reviewState: "none",
      isPrimary: true,
      healthStatus: "healthy",
      metadata: { merged: true },
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txSelect).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(txInsert).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      created: false,
      product: expect.objectContaining({
        id: "work-product-1",
        externalId: "tensorleap/concierge#28",
        title: "Clarify onboarding docs",
        status: "merged",
      }),
    }));
  });

  it("lists work products by provider external id across the company", async () => {
    const matchingPrimary = createWorkProductRow({
      id: "work-product-1",
      issueId: "issue-1",
      externalId: "tensorleap/concierge#28",
      isPrimary: true,
      updatedAt: new Date("2026-03-17T00:00:00.000Z"),
    });
    const matchingSecondary = createWorkProductRow({
      id: "work-product-2",
      issueId: "issue-2",
      externalId: "tensorleap/concierge#28",
      isPrimary: false,
      updatedAt: new Date("2026-03-16T00:00:00.000Z"),
    });

    const orderBy = vi.fn(async () => [matchingPrimary, matchingSecondary]);
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    const svc = workProductService({ select } as any);
    const result = await svc.listByExternalId({
      companyId: "company-1",
      type: "pull_request",
      provider: "github",
      externalId: "tensorleap/concierge#28",
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    expect(orderBy).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      expect.objectContaining({ id: "work-product-1", issueId: "issue-1", isPrimary: true }),
      expect.objectContaining({ id: "work-product-2", issueId: "issue-2", isPrimary: false }),
    ]);
  });
});
