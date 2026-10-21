import {
  PAYOUT_TOTAL_RECALCULATION_ERROR_CODE,
  PayoutRecalculationIssueCode,
  PayoutTotalRecalculationError,
  recalculatePayoutTotalsAfterRetry,
  validatePayoutTotalRecalculation,
  type PayoutAttempt,
  type PayoutTotalEntry,
} from "../../src/batch";

const entries: PayoutTotalEntry[] = [
  { itemId: "EMP-1001", amount: 1_000n, asset: "USDC" },
  { itemId: "EMP-2002", amount: 2_500n, asset: "USDC" },
  { itemId: "EMP-3003", amount: 700n, asset: "XLM" },
];

function attempt(number: number, outcomes: PayoutAttempt["outcomes"]): PayoutAttempt {
  return { attempt: number, outcomes };
}

describe("payout total recalculation after a partial retry (#813)", () => {
  describe("success cases", () => {
    it("counts retry-recovered items exactly once and reports aggregate and per-asset totals", () => {
      const totals = recalculatePayoutTotalsAfterRetry({
        entries,
        attempts: [
          attempt(1, [
            { itemId: "EMP-1001", outcome: "succeeded" },
            { itemId: "EMP-2002", outcome: "failed", failureCode: "INSUFFICIENT_FUNDS" },
            { itemId: "EMP-3003", outcome: "succeeded" },
          ]),
          attempt(2, [{ itemId: "EMP-2002", outcome: "succeeded" }]),
        ],
      });

      expect(totals.totalAmount).toBe(4_200n);
      expect(totals.originalTotalAmount).toBe(4_200n);
      expect(totals.recoveredAmount).toBe(2_500n);
      expect(totals.outstandingAmount).toBe(0n);
      expect(totals.isFullySettled).toBe(true);
      expect(totals.attemptCount).toBe(2);
      expect(totals.counts).toEqual({
        total: 3,
        settled: 3,
        recovered: 1,
        outstanding: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
      });

      expect(totals.totalsByAsset).toEqual([
        {
          asset: "USDC",
          settledAmount: 3_500n,
          recoveredAmount: 2_500n,
          outstandingAmount: 0n,
          entryCount: 2,
          settledCount: 2,
          recoveredCount: 1,
          outstandingCount: 0,
        },
        {
          asset: "XLM",
          settledAmount: 700n,
          recoveredAmount: 0n,
          outstandingAmount: 0n,
          entryCount: 1,
          settledCount: 1,
          recoveredCount: 0,
          outstandingCount: 0,
        },
      ]);
    });

    it("keeps items omitted from the retry outstanding instead of marking them paid", () => {
      const totals = recalculatePayoutTotalsAfterRetry({
        entries,
        attempts: [
          attempt(1, [
            { itemId: "EMP-1001", outcome: "failed" },
            { itemId: "EMP-2002", outcome: "failed" },
            { itemId: "EMP-3003", outcome: "skipped" },
          ]),
          attempt(2, [{ itemId: "EMP-2002", outcome: "succeeded" }]),
        ],
      });

      expect(totals.totalAmount).toBe(2_500n);
      expect(totals.recoveredAmount).toBe(2_500n);
      expect(totals.outstandingAmount).toBe(1_700n);
      expect(totals.isFullySettled).toBe(false);
      expect(totals.counts).toMatchObject({
        total: 3,
        settled: 1,
        recovered: 1,
        outstanding: 2,
        failed: 1,
        skipped: 1,
      });
    });

    it("keeps a recovered item settled when later attempts omit it", () => {
      const totals = recalculatePayoutTotalsAfterRetry({
        entries: [{ itemId: "line-1", amount: 50n, asset: "USDC" }],
        attempts: [
          attempt(1, [{ itemId: "line-1", outcome: "failed" }]),
          attempt(2, [{ itemId: "line-1", outcome: "succeeded" }]),
          attempt(3, []),
        ],
      });

      expect(totals.totalAmount).toBe(50n);
      expect(totals.recoveredAmount).toBe(50n);
      expect(totals.outstandingAmount).toBe(0n);
      expect(totals.attemptCount).toBe(3);
    });

    it("is safe for totals larger than Number.MAX_SAFE_INTEGER", () => {
      const huge = 9_007_199_254_740_993n;
      const totals = recalculatePayoutTotalsAfterRetry({
        entries: [
          { itemId: "huge-1", amount: huge, asset: "USDC" },
          { itemId: "huge-2", amount: huge, asset: "USDC" },
        ],
        attempts: [
          attempt(1, [
            { itemId: "huge-1", outcome: "succeeded" },
            { itemId: "huge-2", outcome: "failed" },
          ]),
          attempt(2, [{ itemId: "huge-2", outcome: "succeeded" }]),
        ],
      });

      expect(totals.totalAmount).toBe(huge * 2n);
      expect(totals.recoveredAmount).toBe(huge);
      expect(totals.totalsByAsset[0].settledAmount).toBe(huge * 2n);
    });
  });

  describe("boundary cases", () => {
    it("treats a batch with no reported attempts as entirely outstanding", () => {
      const totals = recalculatePayoutTotalsAfterRetry({ entries });

      expect(totals.totalAmount).toBe(0n);
      expect(totals.recoveredAmount).toBe(0n);
      expect(totals.outstandingAmount).toBe(4_200n);
      expect(totals.originalTotalAmount).toBe(4_200n);
      expect(totals.attemptCount).toBe(0);
      expect(totals.isFullySettled).toBe(false);
      expect(totals.counts.pending).toBe(3);
      expect(totals.counts.outstanding).toBe(3);
    });

    it("accepts the minimum positive amount", () => {
      const totals = recalculatePayoutTotalsAfterRetry({
        entries: [{ itemId: "tiny", amount: 1n, asset: "USDC" }],
        attempts: [attempt(1, [{ itemId: "tiny", outcome: "succeeded" }])],
      });

      expect(totals.totalAmount).toBe(1n);
      expect(totals.isFullySettled).toBe(true);
    });
  });

  describe("rejection cases", () => {
    it("rejects an already-settled item reported as succeeded again", () => {
      let error: unknown;
      try {
        recalculatePayoutTotalsAfterRetry({
          entries: [{ itemId: "EMP-1001", amount: 1_000n, asset: "USDC" }],
          attempts: [
            attempt(1, [{ itemId: "EMP-1001", outcome: "succeeded" }]),
            attempt(2, [{ itemId: "EMP-1001", outcome: "succeeded" }]),
          ],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(PayoutTotalRecalculationError);
      const recalculationError = error as PayoutTotalRecalculationError;
      expect(recalculationError.code).toBe(PAYOUT_TOTAL_RECALCULATION_ERROR_CODE);
      expect(recalculationError.issues).toHaveLength(1);
      expect(recalculationError.issues[0].code).toBe(
        PayoutRecalculationIssueCode.DUPLICATE_SUCCESS
      );
    });

    it("rejects reversing a settled outcome", () => {
      const issues = validatePayoutTotalRecalculation({
        entries: [{ itemId: "EMP-1001", amount: 1_000n, asset: "USDC" }],
        attempts: [
          attempt(1, [{ itemId: "EMP-1001", outcome: "succeeded" }]),
          attempt(2, [{ itemId: "EMP-1001", outcome: "failed" }]),
        ],
      });

      expect(issues.map((issue) => issue.code)).toContain(
        PayoutRecalculationIssueCode.SETTLED_OUTCOME_REVERSED
      );
      expect(() =>
        recalculatePayoutTotalsAfterRetry({
          entries: [{ itemId: "EMP-1001", amount: 1_000n, asset: "USDC" }],
          attempts: [
            attempt(1, [{ itemId: "EMP-1001", outcome: "succeeded" }]),
            attempt(2, [{ itemId: "EMP-1001", outcome: "failed" }]),
          ],
        })
      ).toThrow(PayoutTotalRecalculationError);
    });

    it("rejects outcomes for items that are not in the batch", () => {
      expect(() =>
        recalculatePayoutTotalsAfterRetry({
          entries: [{ itemId: "EMP-1001", amount: 1_000n, asset: "USDC" }],
          attempts: [attempt(1, [{ itemId: "EMP-9999", outcome: "succeeded" }])],
        })
      ).toThrow(PayoutTotalRecalculationError);

      const issues = validatePayoutTotalRecalculation({
        entries: [{ itemId: "EMP-1001", amount: 1_000n, asset: "USDC" }],
        attempts: [attempt(1, [{ itemId: "EMP-9999", outcome: "succeeded" }])],
      });
      expect(issues[0].code).toBe(PayoutRecalculationIssueCode.UNKNOWN_ITEM);
    });

    it("rejects duplicate item identifiers in the original entries", () => {
      const issues = validatePayoutTotalRecalculation({
        entries: [
          { itemId: "line-1", amount: 100n, asset: "USDC" },
          { itemId: " line-1 ", amount: 200n, asset: "USDC" },
        ],
      });

      expect(issues.map((issue) => issue.code)).toContain(
        PayoutRecalculationIssueCode.DUPLICATE_ITEM_ID
      );
    });

    it("rejects non-positive amounts and missing assets", () => {
      const issues = validatePayoutTotalRecalculation({
        entries: [
          { itemId: "line-1", amount: 0n, asset: "USDC" },
          { itemId: "line-2", amount: 100n, asset: " " },
        ],
      });

      expect(issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          PayoutRecalculationIssueCode.INVALID_AMOUNT,
          PayoutRecalculationIssueCode.MISSING_ASSET,
        ])
      );
    });

    it("rejects attempts that do not start at 1 or skip a number", () => {
      const startsLate = validatePayoutTotalRecalculation({
        entries: [{ itemId: "line-1", amount: 100n, asset: "USDC" }],
        attempts: [attempt(2, [{ itemId: "line-1", outcome: "succeeded" }])],
      });
      expect(startsLate[0].code).toBe(PayoutRecalculationIssueCode.INVALID_ATTEMPT_SEQUENCE);

      const skips = validatePayoutTotalRecalculation({
        entries: [{ itemId: "line-1", amount: 100n, asset: "USDC" }],
        attempts: [
          attempt(1, [{ itemId: "line-1", outcome: "failed" }]),
          attempt(3, [{ itemId: "line-1", outcome: "succeeded" }]),
        ],
      });
      expect(skips[0].code).toBe(PayoutRecalculationIssueCode.INVALID_ATTEMPT_SEQUENCE);
    });

    it("rejects duplicate outcomes for the same item within one attempt", () => {
      const issues = validatePayoutTotalRecalculation({
        entries: [{ itemId: "line-1", amount: 100n, asset: "USDC" }],
        attempts: [
          attempt(1, [
            { itemId: "line-1", outcome: "failed" },
            { itemId: "line-1", outcome: "succeeded" },
          ]),
        ],
      });

      expect(issues.map((issue) => issue.code)).toContain(
        PayoutRecalculationIssueCode.DUPLICATE_OUTCOME
      );
    });

    it("rejects an empty batch", () => {
      const issues = validatePayoutTotalRecalculation({ entries: [] });

      expect(issues).toHaveLength(1);
      expect(issues[0].code).toBe(PayoutRecalculationIssueCode.EMPTY_BATCH);
    });

    it("keeps failures actionable without exposing salaries, amounts, or raw employee IDs", () => {
      let error: PayoutTotalRecalculationError | undefined;
      try {
        recalculatePayoutTotalsAfterRetry({
          entries: [{ itemId: "EMP-SECRET-42", amount: 987_654_321n, asset: "USDC" }],
          attempts: [
            attempt(1, [{ itemId: "EMP-SECRET-42", outcome: "succeeded" }]),
            attempt(2, [{ itemId: "EMP-SECRET-42", outcome: "succeeded" }]),
          ],
        });
      } catch (caught) {
        error = caught as PayoutTotalRecalculationError;
      }

      expect(error).toBeDefined();
      const serialized = JSON.stringify(error?.issues);
      expect(serialized).not.toContain("987654321");
      expect(serialized).not.toContain("EMP-SECRET-42");
      expect(serialized).toContain("EMP***-42");
      expect(error?.issues[0].suggestedFix).toMatch(/settled/i);
    });
  });
});
