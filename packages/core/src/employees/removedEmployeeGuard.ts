/**
 * Removed Employee Payout Batch Guard (#812)
 *
 * Rejects employees that have been removed from the payroll roster before they
 * can enter a payout batch. Removed employees (offboarded, terminated, or
 * explicitly deleted) must not receive a regular payroll payout, so the batch
 * builders run this guard before signing or submitting anything.
 *
 * The guard understands three removal signals, so it works with roster data the
 * SDK already exposes:
 * - an employment `status` / `employeeStatus` of `removed`, `offboarded`, or
 *   `terminated` (case-insensitive, surrounding whitespace ignored);
 * - an explicit `isRemoved: true` marker;
 * - a recorded `removedAt` timestamp.
 *
 * When a caller holds the removal state separately (for example a roster
 * snapshot fetched from an indexer), the same employee IDs can be supplied via
 * `removedEmployeeIds` instead of being copied onto every entry.
 *
 * ## Privacy & Security Guarantees
 * - Salary, amount, and payout destination values are NEVER included in
 *   rejections, messages, or thrown errors.
 * - Employee identifiers are masked in every human-readable message. The raw
 *   identifier is only exposed as a structured field, mirroring
 *   `./suspensionPayoutEvaluator.ts` and `../payroll/payoutCountValidator.ts`.
 * - Thrown errors carry only an aggregate count and the structured rejections,
 *   so they are safe to log or surface in a dashboard.
 *
 * @module
 */

import { ZkPayrollError } from "../core/errors";

// ── Removal statuses ────────────────────────────────────────────────────────

/**
 * Employment statuses that mean the employee no longer belongs on the payroll
 * roster.
 */
export const REMOVED_EMPLOYEE_STATUSES = ["removed", "offboarded", "terminated"] as const;

/** A normalized employment status that marks an employee as removed. */
export type RemovedEmployeeStatus = (typeof REMOVED_EMPLOYEE_STATUSES)[number];

/** Stable code attached to every rejected payout-batch entry. */
export const REMOVED_EMPLOYEE_REJECTION_CODE = "REMOVED_EMPLOYEE" as const;

/** Code identifying a removed-employee batch rejection. */
export type RemovedEmployeeRejectionCode = typeof REMOVED_EMPLOYEE_REJECTION_CODE;

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * The minimum shape the guard needs in order to decide whether a payout-batch
 * entry belongs to a removed employee.
 *
 * `EmployeeRecord` (employee batches) and `BatchPaymentEntry` (payment
 * batches) both satisfy this interface.
 */
export interface RemovedEmployeeCheckEntry {
  /** Employee identifier, when the entry is tied to a payroll employee. */
  employeeId?: string;
  /** Employment lifecycle status (e.g. `"active"`, `"removed"`). */
  status?: string;
  /** Alias for `status`, used by payment batch entries. */
  employeeStatus?: string;
  /** Explicit removal marker set when the employee was removed. */
  isRemoved?: boolean;
  /** Timestamp (ms, ISO string, or `Date`) recorded when the employee was removed. */
  removedAt?: number | string | Date | null;
}

/** Options controlling removed-employee detection. */
export interface RemovedEmployeeGuardOptions {
  /**
   * Employee IDs known to be removed from the roster. Use this when the removal
   * state lives outside the batch entry (e.g. a roster snapshot).
   */
  removedEmployeeIds?: Iterable<string>;
  /**
   * Whether entries carrying a removal signal are rejected. Defaults to `true`.
   *
   * Set to `false` only for flows that intentionally pay removed employees
   * (for example a reviewed offboarding settlement), which are expected to use
   * their own approval path.
   */
  rejectRemovedEmployees?: boolean;
}

/** Structured rejection for a single removed employee found in a payout batch. */
export interface RemovedEmployeeRejection {
  /** Stable rejection code. */
  code: RemovedEmployeeRejectionCode;
  /** Zero-based index of the offending entry within the batch. */
  index: number;
  /**
   * Raw employee identifier, for reconciliation against the roster.
   * Never interpolate this into user-facing text — use `redactedEmployeeId`.
   */
  employeeId?: string;
  /** Masked employee identifier, safe for UI, logs, and error messages. */
  redactedEmployeeId: string;
  /** Normalized removal status that triggered the rejection, when known. */
  status?: RemovedEmployeeStatus;
  /** Privacy-safe explanation (masked identifier, no salary or destination). */
  message: string;
  /** Actionable remediation guidance for the operator. */
  suggestedFix: string;
}

/** Result of partitioning a payout batch around removed employees. */
export interface RemovedEmployeeBatchPartition<T extends RemovedEmployeeCheckEntry> {
  /** Entries that may proceed into the payout batch. */
  accepted: T[];
  /** Entries rejected because the employee was removed. */
  rejected: RemovedEmployeeRejection[];
  /** Whether at least one entry was rejected. */
  hasRemovedEmployees: boolean;
}

/**
 * Thrown by {@link assertNoRemovedEmployeesInPayoutBatch} when a payout batch
 * contains removed employees.
 *
 * The message contains only an aggregate count; per-entry detail lives in
 * {@link rejections} and is safe to display.
 */
export class RemovedEmployeeInPayoutBatchError extends ZkPayrollError {
  constructor(public readonly rejections: RemovedEmployeeRejection[]) {
    super(
      `Payout batch rejected: ${rejections.length} entr${
        rejections.length === 1 ? "y belongs" : "ies belong"
      } to removed employees. Remove them before building the batch.`,
      "REMOVED_EMPLOYEE_IN_PAYOUT_BATCH"
    );
  }
}

/** Message used for every removed-employee rejection. */
const REMOVED_EMPLOYEE_MESSAGE =
  "Employee has been removed from the payroll roster and cannot be included in a payout batch.";

/** Remediation guidance used for every removed-employee rejection. */
const REMOVED_EMPLOYEE_SUGGESTED_FIX =
  "Remove this payout line from the batch. If final wages are owed, process them through an offboarding settlement.";

// ── Detection helpers ───────────────────────────────────────────────────────

/** Mask an employee identifier so it stays safe to surface. */
export function redactEmployeeId(employeeId?: string): string {
  if (typeof employeeId !== "string" || employeeId.trim().length === 0) {
    return "[ANONYMOUS_EMPLOYEE]";
  }
  const clean = employeeId.trim();
  if (clean.length <= 4) {
    return "[REDACTED_EMPLOYEE]";
  }
  return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}

/** Normalize a status string for comparison (trim + lowercase). */
function normalizeStatus(status?: string): string | undefined {
  if (typeof status !== "string") {
    return undefined;
  }
  const normalized = status.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

/** Whether a raw status value marks an employee as removed. */
export function isRemovedEmployeeStatus(status?: string): boolean {
  const normalized = normalizeStatus(status);
  return (
    normalized !== undefined &&
    (REMOVED_EMPLOYEE_STATUSES as readonly string[]).includes(normalized)
  );
}

/** Whether a `removedAt` value records an actual removal timestamp. */
function hasRemovalTimestamp(removedAt?: number | string | Date | null): boolean {
  if (removedAt === undefined || removedAt === null) {
    return false;
  }
  if (removedAt instanceof Date) {
    return !Number.isNaN(removedAt.getTime());
  }
  if (typeof removedAt === "number") {
    return Number.isFinite(removedAt);
  }
  return removedAt.trim().length > 0;
}

/**
 * Resolve the removal signal carried by an entry, if any.
 *
 * Explicit statuses take precedence over the `isRemoved`/`removedAt` markers so
 * the rejection can report the most specific status.
 */
export function resolveRemovedEmployeeStatus(
  entry: RemovedEmployeeCheckEntry
): RemovedEmployeeStatus | undefined {
  const status = normalizeStatus(entry.status) ?? normalizeStatus(entry.employeeStatus);
  if (status !== undefined && (REMOVED_EMPLOYEE_STATUSES as readonly string[]).includes(status)) {
    return status as RemovedEmployeeStatus;
  }
  if (entry.isRemoved === true) {
    return "removed";
  }
  if (hasRemovalTimestamp(entry.removedAt)) {
    return "removed";
  }
  return undefined;
}

/**
 * Whether a single payout-batch entry belongs to a removed employee.
 *
 * A removal is detected from the entry's status/`isRemoved`/`removedAt` fields
 * or from membership in `options.removedEmployeeIds`.
 */
export function isRemovedPayoutEntry(
  entry: RemovedEmployeeCheckEntry,
  options: RemovedEmployeeGuardOptions = {}
): boolean {
  if (options.rejectRemovedEmployees === false) {
    return false;
  }
  if (resolveRemovedEmployeeStatus(entry) !== undefined) {
    return true;
  }
  if (options.removedEmployeeIds && typeof entry.employeeId === "string") {
    const employeeId = entry.employeeId.trim();
    if (employeeId.length === 0) {
      return false;
    }
    for (const removedId of options.removedEmployeeIds) {
      if (removedId.trim() === employeeId) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Collect every removed employee found in a payout batch as structured,
 * privacy-safe rejections.
 *
 * Returns an empty array when the batch is clean (or when
 * `rejectRemovedEmployees` is `false`).
 */
export function findRemovedEmployeesInPayoutBatch(
  entries: readonly RemovedEmployeeCheckEntry[],
  options: RemovedEmployeeGuardOptions = {}
): RemovedEmployeeRejection[] {
  if (options.rejectRemovedEmployees === false) {
    return [];
  }

  const removedIds =
    options.removedEmployeeIds === undefined
      ? undefined
      : new Set(
          Array.from(options.removedEmployeeIds, (id) => id.trim()).filter((id) => id.length > 0)
        );

  const rejections: RemovedEmployeeRejection[] = [];

  entries.forEach((entry, index) => {
    const status = resolveRemovedEmployeeStatus(entry);
    const employeeId =
      typeof entry.employeeId === "string" && entry.employeeId.trim().length > 0
        ? entry.employeeId.trim()
        : undefined;
    const matchedRoster =
      removedIds !== undefined && employeeId !== undefined && removedIds.has(employeeId);

    if (status === undefined && !matchedRoster) {
      return;
    }

    const redactedEmployeeId = redactEmployeeId(employeeId);
    rejections.push({
      code: REMOVED_EMPLOYEE_REJECTION_CODE,
      index,
      ...(employeeId !== undefined ? { employeeId } : {}),
      redactedEmployeeId,
      ...(status !== undefined ? { status } : {}),
      message: `Employee ${redactedEmployeeId} ${REMOVED_EMPLOYEE_MESSAGE}`,
      suggestedFix: REMOVED_EMPLOYEE_SUGGESTED_FIX,
    });
  });

  return rejections;
}

/**
 * Split a payout batch into entries that may proceed and entries rejected
 * because the employee was removed.
 *
 * Use this when the caller wants to pay everyone else and surface the skipped
 * employees for review; use {@link assertNoRemovedEmployeesInPayoutBatch} when
 * the whole batch must fail.
 */
export function partitionPayoutBatchByRemoval<T extends RemovedEmployeeCheckEntry>(
  entries: readonly T[],
  options: RemovedEmployeeGuardOptions = {}
): RemovedEmployeeBatchPartition<T> {
  const rejected = findRemovedEmployeesInPayoutBatch(entries, options);
  if (rejected.length === 0) {
    return { accepted: [...entries], rejected, hasRemovedEmployees: false };
  }

  const rejectedIndices = new Set(rejected.map((rejection) => rejection.index));
  return {
    accepted: entries.filter((_, index) => !rejectedIndices.has(index)),
    rejected,
    hasRemovedEmployees: true,
  };
}

/**
 * Assert that a payout batch contains no removed employees.
 *
 * @throws {RemovedEmployeeInPayoutBatchError} when at least one entry belongs
 * to a removed employee. The error exposes structured, privacy-safe rejections.
 */
export function assertNoRemovedEmployeesInPayoutBatch(
  entries: readonly RemovedEmployeeCheckEntry[],
  options: RemovedEmployeeGuardOptions = {}
): void {
  const rejections = findRemovedEmployeesInPayoutBatch(entries, options);
  if (rejections.length > 0) {
    throw new RemovedEmployeeInPayoutBatchError(rejections);
  }
}
