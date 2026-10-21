/**
 * Payout total recalculation after a partial retry (#813)
 *
 * When a payout batch only partially succeeds, operators retry the failed
 * items. Replaying those retries must not double-count items that already
 * settled: the payout total has to reflect what was actually paid, what the
 * retry recovered, and what is still outstanding.
 *
 * `recalculatePayoutTotalsAfterRetry` replays the initial attempt plus every
 * retry attempt in order and returns per-asset and aggregate totals. Each
 * payout item is counted at most once, and a settled item is terminal — a
 * retry that reports it again is rejected instead of inflating the total.
 *
 * ## Privacy & Security Guarantees
 * - Issues and thrown errors never contain amounts, salaries, recipient
 *   addresses, or raw employee identifiers.
 * - Item identifiers are masked in every message; the raw identifier is not
 *   copied into issues at all.
 * - Only aggregate amounts appear in results, keyed by public asset code.
 *
 * @module
 */

import { ZkPayrollError } from "../core/errors";

/** Final outcome reported for a single payout item in one attempt. */
export type PayoutItemOutcome = "succeeded" | "failed" | "pending" | "skipped";

/** Outcome reported for one item inside an execution attempt. */
export interface PayoutAttemptOutcome {
  /** Stable identifier matching an entry in the original payout batch. */
  itemId: string;
  /** Outcome observed for this item in this attempt. */
  outcome: PayoutItemOutcome;
  /**
   * Optional stable failure code (e.g. `"INSUFFICIENT_FUNDS"`). Used only for
   * operator diagnostics; it never changes the totals.
   */
  failureCode?: string;
}

/**
 * One execution attempt over a payout batch.
 *
 * Attempt `1` is the original execution. Every later attempt is a retry and
 * only needs to contain the items that are being retried.
 */
export interface PayoutAttempt {
  /** 1-based attempt number. Attempts must be supplied in ascending order. */
  attempt: number;
  /** Outcomes observed in this attempt. */
  outcomes: readonly PayoutAttemptOutcome[];
  /** Optional execution timestamp in milliseconds. */
  executedAt?: number;
}

/** A single payout item whose total should be recalculated. */
export interface PayoutTotalEntry {
  /**
   * Stable, non-empty identifier used to match retry outcomes back to the
   * original item (for example an employee ID or batch line ID).
   */
  itemId: string;
  /** Payout amount in the asset's base units. Must be a positive bigint. */
  amount: bigint;
  /** Asset code the amount is denominated in. */
  asset: string;
}

/** Input accepted by {@link recalculatePayoutTotalsAfterRetry}. */
export interface PayoutTotalsRecalculationInput {
  /** Original payout entries, before any retry. */
  entries: readonly PayoutTotalEntry[];
  /**
   * Execution attempts in ascending order, starting at attempt `1`. Pass an
   * empty list to represent a batch whose execution has not reported back yet:
   * every entry then counts as outstanding.
   */
  attempts?: readonly PayoutAttempt[];
}

/** Per-asset totals after replaying retries. */
export interface PayoutAssetTotals {
  /** Asset code these totals belong to. */
  asset: string;
  /** Amount settled across all attempts. Each item is counted once. */
  settledAmount: bigint;
  /** Portion of `settledAmount` that was recovered by a retry (attempt > 1). */
  recoveredAmount: bigint;
  /** Amount from this asset that is still unpaid. */
  outstandingAmount: bigint;
  /** Number of payout items denominated in this asset. */
  entryCount: number;
  /** Number of items that settled. */
  settledCount: number;
  /** Number of items recovered by a retry. */
  recoveredCount: number;
  /** Number of items that are still unpaid. */
  outstandingCount: number;
}

/** Item counts after replaying retries. */
export interface PayoutRecalculationCounts {
  /** Total number of items in the original batch. */
  total: number;
  /** Items that settled, including recovered items. */
  settled: number;
  /** Items that settled on a retry. */
  recovered: number;
  /** Items that are still unpaid. */
  outstanding: number;
  /** Items whose latest reported outcome is `failed`. */
  failed: number;
  /** Items that have no reported outcome or whose latest outcome is `pending`. */
  pending: number;
  /** Items whose latest reported outcome is `skipped`. */
  skipped: number;
}

/** Recalculated payout totals. */
export interface PayoutTotalsRecalculation {
  /**
   * Aggregate settled total after replaying every attempt. This is the total
   * that should be reported for the batch, not the sum of the retry payloads.
   */
  totalAmount: bigint;
  /** Aggregate amount recovered by retries (items settled on attempt > 1). */
  recoveredAmount: bigint;
  /** Aggregate amount still unpaid after the latest attempt. */
  outstandingAmount: bigint;
  /** Aggregate amount of the original batch, before retries. */
  originalTotalAmount: bigint;
  /** Per-asset breakdown, sorted by asset code for deterministic output. */
  totalsByAsset: PayoutAssetTotals[];
  /** Item counts after replaying retries. */
  counts: PayoutRecalculationCounts;
  /** Number of attempts replayed. */
  attemptCount: number;
  /** `true` when every item settled. */
  isFullySettled: boolean;
  /** Timestamp when the recalculation ran (milliseconds). */
  recalculatedAt: number;
}

/** Stable issue codes returned by the recalculation validator. */
export const PayoutRecalculationIssueCode = {
  EMPTY_BATCH: "EMPTY_BATCH",
  INVALID_ITEM_ID: "INVALID_ITEM_ID",
  DUPLICATE_ITEM_ID: "DUPLICATE_ITEM_ID",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  MISSING_ASSET: "MISSING_ASSET",
  INVALID_ATTEMPT: "INVALID_ATTEMPT",
  INVALID_ATTEMPT_SEQUENCE: "INVALID_ATTEMPT_SEQUENCE",
  DUPLICATE_OUTCOME: "DUPLICATE_OUTCOME",
  UNKNOWN_ITEM: "UNKNOWN_ITEM",
  INVALID_OUTCOME: "INVALID_OUTCOME",
  DUPLICATE_SUCCESS: "DUPLICATE_SUCCESS",
  SETTLED_OUTCOME_REVERSED: "SETTLED_OUTCOME_REVERSED",
} as const;

/** Issue code emitted while validating a recalculation input. */
export type PayoutRecalculationIssueCode =
  (typeof PayoutRecalculationIssueCode)[keyof typeof PayoutRecalculationIssueCode];

/** A single, privacy-safe validation issue. */
export interface PayoutRecalculationIssue {
  /** Stable machine-readable code. */
  code: PayoutRecalculationIssueCode;
  /** Privacy-safe explanation; item identifiers are masked and no amounts appear. */
  message: string;
  /** Field the issue relates to. */
  field: "entries" | "itemId" | "amount" | "asset" | "attempts" | "attempt" | "outcome";
  /** Zero-based index of the offending entry, when applicable. */
  entryIndex?: number;
  /** Attempt number the issue relates to, when applicable. */
  attempt?: number;
  /** Masked item identifier, safe to display in UI and logs. */
  redactedItemId?: string;
  /** Actionable remediation guidance for the operator. */
  suggestedFix: string;
}

/** Code identifying a recalculation failure. */
export const PAYOUT_TOTAL_RECALCULATION_ERROR_CODE = "PAYOUT_TOTAL_RECALCULATION_FAILED" as const;

/**
 * Thrown by {@link recalculatePayoutTotalsAfterRetry} when the retry outcomes
 * cannot be replayed safely.
 *
 * The message contains only an aggregate issue count; per-issue detail lives in
 * {@link issues} and is privacy-safe.
 */
export class PayoutTotalRecalculationError extends ZkPayrollError {
  constructor(public readonly issues: PayoutRecalculationIssue[]) {
    super(
      `Payout totals could not be recalculated: ${issues.length} retry outcome issue(s) found. ` +
        "Resolve them before reporting or retrying payouts.",
      PAYOUT_TOTAL_RECALCULATION_ERROR_CODE
    );
  }
}

const PAYOUT_ITEM_OUTCOMES: readonly PayoutItemOutcome[] = [
  "succeeded",
  "failed",
  "pending",
  "skipped",
];

const SUGGESTED_FIXES: Record<PayoutRecalculationIssueCode, string> = {
  EMPTY_BATCH: "Provide the payout entries that were submitted before the retry.",
  INVALID_ITEM_ID: "Give every payout entry a stable, non-empty itemId.",
  DUPLICATE_ITEM_ID: "Use one payout entry per itemId so retries map to a single amount.",
  INVALID_AMOUNT: "Use a positive bigint amount in the asset's base units.",
  MISSING_ASSET: "Provide the asset code for every payout entry.",
  INVALID_ATTEMPT: "Number every execution attempt with a positive integer.",
  INVALID_ATTEMPT_SEQUENCE:
    "Replay attempts in ascending order starting at attempt 1, exactly once each.",
  DUPLICATE_OUTCOME: "Report each item at most once per attempt.",
  UNKNOWN_ITEM: "Only report outcomes for itemIds that exist in the original payout entries.",
  INVALID_OUTCOME: 'Use one of "succeeded", "failed", "pending", or "skipped".',
  DUPLICATE_SUCCESS:
    "Remove already-settled items from the retry payload; a settled payout must never be paid twice.",
  SETTLED_OUTCOME_REVERSED:
    "Treat a settled item as final and exclude it from later attempts; reconcile any conflicting report separately.",
};

interface MutableItemState {
  outcome: PayoutItemOutcome;
  settledAtAttempt?: number;
}

interface RecalculationRun {
  issues: PayoutRecalculationIssue[];
  result?: PayoutTotalsRecalculation;
}

/** Mask an item identifier so it stays safe to surface in messages. */
function maskItemId(itemId?: string): string {
  if (typeof itemId !== "string" || itemId.trim().length === 0) {
    return "[UNIDENTIFIED_ITEM]";
  }
  const clean = itemId.trim();
  if (clean.length <= 4) {
    return "[REDACTED_ITEM]";
  }
  return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}

function issue(
  code: PayoutRecalculationIssueCode,
  message: string,
  field: PayoutRecalculationIssue["field"],
  extra: Omit<PayoutRecalculationIssue, "code" | "message" | "field" | "suggestedFix"> = {}
): PayoutRecalculationIssue {
  return {
    code,
    message,
    field,
    ...extra,
    suggestedFix: SUGGESTED_FIXES[code],
  };
}

function validateEntries(
  entries: readonly PayoutTotalEntry[] | undefined,
  issues: PayoutRecalculationIssue[],
  itemIds: Set<string>
): void {
  if (!Array.isArray(entries) || entries.length === 0) {
    issues.push(
      issue(
        PayoutRecalculationIssueCode.EMPTY_BATCH,
        "Payout totals cannot be recalculated without at least one original payout entry.",
        "entries"
      )
    );
    return;
  }

  const seenItemIds = new Map<string, number>();

  entries.forEach((entry, entryIndex) => {
    const rawItemId = entry && typeof entry.itemId === "string" ? entry.itemId.trim() : "";
    if (rawItemId.length === 0) {
      issues.push(
        issue(
          PayoutRecalculationIssueCode.INVALID_ITEM_ID,
          `Payout entry at index ${entryIndex} has no usable item identifier.`,
          "itemId",
          { entryIndex }
        )
      );
    } else {
      const firstIndex = seenItemIds.get(rawItemId);
      if (firstIndex !== undefined) {
        issues.push(
          issue(
            PayoutRecalculationIssueCode.DUPLICATE_ITEM_ID,
            `Item ${maskItemId(rawItemId)} appears more than once in the payout entries ` +
              `(indices ${firstIndex} and ${entryIndex}).`,
            "itemId",
            { entryIndex, redactedItemId: maskItemId(rawItemId) }
          )
        );
      } else {
        seenItemIds.set(rawItemId, entryIndex);
        itemIds.add(rawItemId);
      }
    }

    if (!entry || typeof entry.amount !== "bigint" || entry.amount <= 0n) {
      issues.push(
        issue(
          PayoutRecalculationIssueCode.INVALID_AMOUNT,
          `Payout item ${maskItemId(rawItemId)} has an invalid amount; amounts must be positive bigints.`,
          "amount",
          { entryIndex, redactedItemId: maskItemId(rawItemId) }
        )
      );
    }

    if (!entry || typeof entry.asset !== "string" || entry.asset.trim().length === 0) {
      issues.push(
        issue(
          PayoutRecalculationIssueCode.MISSING_ASSET,
          `Payout item ${maskItemId(rawItemId)} has no asset code.`,
          "asset",
          { entryIndex, redactedItemId: maskItemId(rawItemId) }
        )
      );
    }
  });
}

function validateAttempts(
  attempts: readonly PayoutAttempt[] | undefined,
  issues: PayoutRecalculationIssue[],
  itemIds: Set<string>,
  states: Map<string, MutableItemState>
): void {
  if (attempts === undefined) {
    return;
  }

  if (!Array.isArray(attempts)) {
    issues.push(
      issue(
        PayoutRecalculationIssueCode.INVALID_ATTEMPT,
        "Execution attempts must be an array.",
        "attempts"
      )
    );
    return;
  }

  let expectedAttempt = 1;

  attempts.forEach((attempt, attemptIndex) => {
    if (!attempt || typeof attempt !== "object") {
      issues.push(
        issue(
          PayoutRecalculationIssueCode.INVALID_ATTEMPT,
          `Execution attempt at index ${attemptIndex} is not a valid attempt object.`,
          "attempts"
        )
      );
      return;
    }

    if (!Number.isInteger(attempt.attempt) || attempt.attempt <= 0) {
      issues.push(
        issue(
          PayoutRecalculationIssueCode.INVALID_ATTEMPT,
          `Execution attempt at index ${attemptIndex} must have a positive integer attempt number.`,
          "attempt"
        )
      );
    } else if (attempt.attempt !== expectedAttempt) {
      issues.push(
        issue(
          PayoutRecalculationIssueCode.INVALID_ATTEMPT_SEQUENCE,
          `Expected attempt ${expectedAttempt} but received attempt ${attempt.attempt}.`,
          "attempt",
          { attempt: attempt.attempt }
        )
      );
      expectedAttempt = attempt.attempt + 1;
    } else {
      expectedAttempt += 1;
    }

    const outcomes = attempt.outcomes;
    if (!Array.isArray(outcomes)) {
      issues.push(
        issue(
          PayoutRecalculationIssueCode.INVALID_ATTEMPT,
          `Attempt ${attempt.attempt} must provide an array of outcomes.`,
          "attempts",
          { attempt: attempt.attempt }
        )
      );
      return;
    }

    const seenItemIds = new Set<string>();

    outcomes.forEach((outcome) => {
      const rawItemId = outcome && typeof outcome.itemId === "string" ? outcome.itemId.trim() : "";
      const redactedItemId = maskItemId(rawItemId);
      const attemptNumber = attempt.attempt;

      if (!itemIds.has(rawItemId)) {
        issues.push(
          issue(
            PayoutRecalculationIssueCode.UNKNOWN_ITEM,
            `Attempt ${attemptNumber} reports an outcome for unknown item ${redactedItemId}.`,
            "itemId",
            { attempt: attemptNumber, redactedItemId }
          )
        );
        return;
      }

      if (seenItemIds.has(rawItemId)) {
        issues.push(
          issue(
            PayoutRecalculationIssueCode.DUPLICATE_OUTCOME,
            `Attempt ${attemptNumber} reports more than one outcome for item ${redactedItemId}.`,
            "outcome",
            { attempt: attemptNumber, redactedItemId }
          )
        );
        return;
      }
      seenItemIds.add(rawItemId);

      if (!outcome || !PAYOUT_ITEM_OUTCOMES.includes(outcome.outcome as PayoutItemOutcome)) {
        issues.push(
          issue(
            PayoutRecalculationIssueCode.INVALID_OUTCOME,
            `Attempt ${attemptNumber} reports an unsupported outcome for item ${redactedItemId}.`,
            "outcome",
            { attempt: attemptNumber, redactedItemId }
          )
        );
        return;
      }

      const state = states.get(rawItemId);
      if (!state) {
        return;
      }

      if (state.settledAtAttempt !== undefined) {
        const code =
          outcome.outcome === "succeeded"
            ? PayoutRecalculationIssueCode.DUPLICATE_SUCCESS
            : PayoutRecalculationIssueCode.SETTLED_OUTCOME_REVERSED;
        const message =
          outcome.outcome === "succeeded"
            ? `Item ${redactedItemId} already settled on attempt ${state.settledAtAttempt} ` +
              `but attempt ${attemptNumber} reports it as succeeded again.`
            : `Item ${redactedItemId} settled on attempt ${state.settledAtAttempt}, so attempt ` +
              `${attemptNumber} cannot report it as "${outcome.outcome}".`;
        issues.push(issue(code, message, "outcome", { attempt: attemptNumber, redactedItemId }));
        return;
      }

      state.outcome = outcome.outcome;
      if (outcome.outcome === "succeeded") {
        state.settledAtAttempt = attemptNumber;
      }
    });
  });
}

function computeResult(
  entries: readonly PayoutTotalEntry[],
  attempts: readonly PayoutAttempt[],
  states: Map<string, MutableItemState>
): PayoutTotalsRecalculation {
  const totalsByAsset = new Map<string, PayoutAssetTotals>();
  const counts: PayoutRecalculationCounts = {
    total: entries.length,
    settled: 0,
    recovered: 0,
    outstanding: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
  };

  let totalAmount = 0n;
  let recoveredAmount = 0n;
  let outstandingAmount = 0n;
  let originalTotalAmount = 0n;

  for (const entry of entries) {
    const itemId = entry.itemId.trim();
    const asset = entry.asset.trim();
    const state = states.get(itemId) ?? { outcome: "pending" };

    let bucket = totalsByAsset.get(asset);
    if (!bucket) {
      bucket = {
        asset,
        settledAmount: 0n,
        recoveredAmount: 0n,
        outstandingAmount: 0n,
        entryCount: 0,
        settledCount: 0,
        recoveredCount: 0,
        outstandingCount: 0,
      };
      totalsByAsset.set(asset, bucket);
    }

    bucket.entryCount += 1;
    originalTotalAmount += entry.amount;

    if (state.settledAtAttempt !== undefined) {
      totalAmount += entry.amount;
      bucket.settledAmount += entry.amount;
      counts.settled += 1;
      bucket.settledCount += 1;

      if (state.settledAtAttempt > 1) {
        recoveredAmount += entry.amount;
        bucket.recoveredAmount += entry.amount;
        counts.recovered += 1;
        bucket.recoveredCount += 1;
      }
    } else {
      outstandingAmount += entry.amount;
      bucket.outstandingAmount += entry.amount;
      counts.outstanding += 1;
      bucket.outstandingCount += 1;
      counts[state.outcome as "failed" | "pending" | "skipped"] += 1;
    }
  }

  return {
    totalAmount,
    recoveredAmount,
    outstandingAmount,
    originalTotalAmount,
    totalsByAsset: Array.from(totalsByAsset.values()).sort((a, b) =>
      a.asset.localeCompare(b.asset)
    ),
    counts,
    attemptCount: attempts.length,
    isFullySettled: counts.outstanding === 0,
    recalculatedAt: Date.now(),
  };
}

function runRecalculation(input: PayoutTotalsRecalculationInput): RecalculationRun {
  const issues: PayoutRecalculationIssue[] = [];
  const itemIds = new Set<string>();

  validateEntries(input?.entries, issues, itemIds);

  if (issues.length > 0) {
    return { issues };
  }

  const states = new Map<string, MutableItemState>();
  for (const itemId of itemIds) {
    states.set(itemId, { outcome: "pending" });
  }

  validateAttempts(input.attempts, issues, itemIds, states);

  if (issues.length > 0) {
    return { issues };
  }

  const attempts = input.attempts ?? [];
  return { issues, result: computeResult(input.entries, attempts, states) };
}

/**
 * Validate a recalculation input without computing totals.
 *
 * Returns an empty array when the retry outcomes can be replayed safely. Issues
 * are privacy-safe: identifiers are masked and amounts are never included.
 */
export function validatePayoutTotalRecalculation(
  input: PayoutTotalsRecalculationInput
): PayoutRecalculationIssue[] {
  return runRecalculation(input).issues;
}

/**
 * Recalculate payout totals after a partial retry.
 *
 * Each payout item is counted at most once, even if an item appears in several
 * attempts. Items that settled on attempt `1` are never re-counted; items that
 * settled on a later attempt are reported as recovered. Items without a
 * successful outcome remain outstanding and are broken down by their latest
 * reported state.
 *
 * @param input - Original payout entries plus execution attempts in order.
 * @returns Per-asset and aggregate totals for the batch.
 * @throws {PayoutTotalRecalculationError} when the outcomes cannot be replayed
 * safely (duplicate successes, reversed settled outcomes, unknown items, or
 * malformed attempts).
 *
 * @example
 * const totals = recalculatePayoutTotalsAfterRetry({
 *   entries: [
 *     { itemId: "line-1", amount: 100n, asset: "USDC" },
 *     { itemId: "line-2", amount: 250n, asset: "USDC" },
 *   ],
 *   attempts: [
 *     { attempt: 1, outcomes: [
 *       { itemId: "line-1", outcome: "succeeded" },
 *       { itemId: "line-2", outcome: "failed" },
 *     ] },
 *     { attempt: 2, outcomes: [{ itemId: "line-2", outcome: "succeeded" }] },
 *   ],
 * });
 * // totals.totalAmount === 350n, totals.recoveredAmount === 250n,
 * // totals.outstandingAmount === 0n
 */
export function recalculatePayoutTotalsAfterRetry(
  input: PayoutTotalsRecalculationInput
): PayoutTotalsRecalculation {
  const { issues, result } = runRecalculation(input);
  if (issues.length > 0 || result === undefined) {
    throw new PayoutTotalRecalculationError(issues);
  }
  return result;
}
