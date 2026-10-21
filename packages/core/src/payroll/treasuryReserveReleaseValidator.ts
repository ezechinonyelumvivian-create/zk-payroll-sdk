/**
 * Treasury reserve release validation for ZK Payroll.
 *
 * Validates that a treasury reserve release request is well-formed and
 * safe to execute before it is submitted on-chain. This guards operational
 * reliability by rejecting releases that would overwithdraw the reserve,
 * target an unknown reserve, execute after expiry, or run while the payroll
 * contract is paused.
 *
 * ## Privacy & Security Guarantees
 * - Pause rejections only expose reserve IDs and public pause categories;
 *   they never contain amounts, salaries, or employee identifiers.
 */

import type { ErrorContext } from "../core/errors";

/**
 * Supported reserve release modes.
 */
export type TreasuryReserveReleaseMode = "partial" | "full";

/**
 * Known treasury reserve lifecycle states.
 */
export type TreasuryReserveStatus = "active" | "locked" | "released";

/**
 * A snapshot of a treasury reserve at the time a release is requested.
 */
export interface TreasuryReserveSnapshot {
  /** Unique identifier of the reserve. */
  reserveId: string;
  /** Current lifecycle status of the reserve. */
  status: TreasuryReserveStatus;
  /** Total amount locked in the reserve (in base units). */
  lockedAmount: bigint;
  /** Amount already released from the reserve (in base units). */
  releasedAmount: bigint;
  /** Optional expiration timestamp in milliseconds. */
  expiresAt?: number;
  /** Optional owner address of the reserve. */
  owner?: string;
}

/**
 * Contract pause state used to block reserve releases while the payroll
 * contract is paused (#814).
 *
 * Mirrors the normalized pause status exposed by the SDK pause module, but is
 * intentionally structural so callers can pass decoded contract state without
 * importing another module.
 */
export interface TreasuryReserveContractPauseState {
  /** `true` when the contract is paused for every operation. */
  isPaused?: boolean;
  /** Operation categories currently paused (e.g. `"reservations"`). */
  pausedCategories?: readonly string[];
}

/** Pause categories that block treasury reserve releases. */
export const TREASURY_RESERVE_RELEASE_BLOCKED_PAUSE_CATEGORIES = [
  "reservations",
  "withdrawals",
] as const;

/** Message returned when a reserve release is attempted during a pause. */
export const TREASURY_RESERVE_RELEASE_PAUSED_MESSAGE =
  "Treasury reserve releases are blocked while the payroll contract is paused. " +
  "Wait until the contract is resumed before retrying the release.";

/**
 * A request to release funds from a treasury reserve.
 */
export interface TreasuryReserveReleaseRequest {
  /** Reserve being released from. */
  reserveId: string;
  /** Amount to release (in base units). */
  amount: bigint;
  /** Release mode. */
  mode: TreasuryReserveReleaseMode;
  /** Address requesting the release. */
  requester: string;
  /** Optional destination address for the released funds. */
  destination?: string;
  /** Optional deadline (ms) by which the release must execute. */
  deadline?: number;
  /** Optional autorized roles of the requester. */
  requesterRoles?: string[];
  /** Optional autorized roles required to release. */
  requiredRoles?: string[];
}

/**
 * Error codes emitted by the treasury reserve release validator.
 */
export const TreasuryReserveReleaseValidationErrorCode = {
  MISSING_RESERVE: "TREASURY_RESERVE_MISSING",
  UNKNOWN_RESERVE: "TREASURY_RESERVE_UNKNOWN",
  INVALID_AMOUNT: "TREASURY_RESERVE_INVALID_AMOUNT",
  INSUFFICIENT_BALANCE: "TREASURY_RESERVE_INSUFFICIENT_BALANCE",
  INVALID_STATUS: "TREASURY_RESERVE_INVALID_STATUS",
  EXPIRED: "TREASURY_RESERVE_EXPIRED",
  UNAUTHORIZED: "TREASURY_RESERVE_UNAUTHORIZED",
  CONTRACT_PAUSED: "TREASURY_RESERVE_CONTRACT_PAUSED",
} as const;

export type TreasuryReserveReleaseValidationErrorCode =
  (typeof TreasuryReserveReleaseValidationErrorCode)[keyof typeof TreasuryReserveReleaseValidationErrorCode];

/**
 * Typed error thrown when a reserve release request is invalid.
 */
export class TreasuryReserveReleaseValidationError extends Error {
  public readonly code: TreasuryReserveReleaseValidationErrorCode;
  public readonly context: ErrorContext;
  public readonly details: Record<string, unknown>;

  constructor(
    message: string,
    code: TreasuryReserveReleaseValidationErrorCode,
    context: ErrorContext = {},
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "TreasuryReserveReleaseValidationError";
    this.code = code;
    this.context = context;
    this.details = details;
  }
}

export interface TreasuryReserveReleaseValidationResult {
  /** Whether the release request is valid. */
  valid: boolean;
  /** Amount that will actually be released (in base units). */
  releaseAmount: bigint;
  /** Remaining locked amount after the release. */
  remainingLockedAmount: bigint;
  /** Next status of the reserve after the release. */
  nextStatus: TreasuryReserveStatus;
  /** Non-fatal warnings surfaced during validation. */
  warnings: string[];
}

const DEFAULT_REQUIRED_ROLES: readonly string[] = ["PAYROLL_ADMIN", "TREASURY", "Employer"];

function isPositiveBigint(value: unknown): value is bigint {
  return typeof value === "bigint" && value > 0n;
}

function isNonNegativeBigint(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n;
}

function normalizeRoles(roles: unknown): string[] {
  if (!Array.isArray(roles)) {
    return [];
  }
  return roles.map((role) => String(role).toUpperCase());
}

function normalizePausedCategories(state?: TreasuryReserveContractPauseState | null): string[] {
  if (!state || !Array.isArray(state.pausedCategories)) {
    return [];
  }
  return Array.from(
    new Set(
      state.pausedCategories
        .map((category) => String(category).trim().toLowerCase())
        .filter((category) => category.length > 0)
    )
  ).sort();
}

/**
 * Whether reserve releases are currently blocked by a contract pause.
 *
 * A release is blocked when the contract is paused globally or when any of the
 * reserve-relevant categories (`reservations`, `withdrawals`) is paused.
 * Unknown categories are preserved by callers but never block a release on
 * their own, so new contract capabilities do not silently disable treasury
 * operations.
 */
export function isTreasuryReserveReleasePaused(
  state?: TreasuryReserveContractPauseState | null
): boolean {
  if (!state) {
    return false;
  }
  if (state.isPaused === true) {
    return true;
  }
  const paused = new Set(normalizePausedCategories(state));
  return TREASURY_RESERVE_RELEASE_BLOCKED_PAUSE_CATEGORIES.some((category) => paused.has(category));
}

/**
 * Assert that treasury reserve releases are allowed by the contract pause state.
 *
 * Use this before building a release request when the caller wants to fail fast
 * without a reserve snapshot. The thrown error is privacy-safe: it contains no
 * amounts, salaries, or employee identifiers.
 *
 * @throws {TreasuryReserveReleaseValidationError} with code
 * `TREASURY_RESERVE_CONTRACT_PAUSED` when the contract is paused.
 */
export function assertTreasuryReserveReleaseNotPaused(
  state?: TreasuryReserveContractPauseState | null,
  context: ErrorContext = {}
): void {
  if (!isTreasuryReserveReleasePaused(state)) {
    return;
  }

  throw new TreasuryReserveReleaseValidationError(
    TREASURY_RESERVE_RELEASE_PAUSED_MESSAGE,
    TreasuryReserveReleaseValidationErrorCode.CONTRACT_PAUSED,
    context,
    {
      isPaused: state?.isPaused === true,
      pausedCategories: normalizePausedCategories(state),
    }
  );
}

/**
 * Validates a treasury reserve release request against the current reserve
 * snapshot and optional clock time.
 *
 * Throws a `TreasuryReserveReleaseValidationError` with an actionable
 * message and typed error code when the request is invalid.
 *
 * @param request - The release request to validate.
 * @param reserve - Current snapshot of the treasury reserve.
 * @param now - Optional current timestamp in milliseconds (defaults to Date.now()).
 * @param context - Optional debugging context.
 * @param contractPauseState - Optional decoded contract pause state. When the
 * contract is paused (globally or for `reservations`/`withdrawals`), the release
 * is rejected with `TREASURY_RESERVE_CONTRACT_PAUSED`.
 * @returns Validation result describing the release.
 */
export function validateTreasuryReserveRelease(
  request: TreasuryReserveReleaseRequest,
  reserve: TreasuryReserveSnapshot | null | undefined,
  now: number = Date.now(),
  context: ErrorContext = {},
  contractPauseState?: TreasuryReserveContractPauseState | null
): TreasuryReserveReleaseValidationResult {
  if (!reserve || typeof reserve !== "object") {
    throw new TreasuryReserveReleaseValidationError(
      "Treasury reserve snapshot is required to validate a release",
      TreasuryReserveReleaseValidationErrorCode.MISSING_RESERVE,
      { ...context, reserveId: request?.reserveId },
      { reserveId: request?.reserveId }
    );
  }

  if (!request || typeof request !== "object") {
    throw new TreasuryReserveReleaseValidationError(
      "Treasury reserve release request is required",
      TreasuryReserveReleaseValidationErrorCode.MISSING_RESERVE,
      context,
      {}
    );
  }

  if (!request.reserveId || typeof request.reserveId !== "string") {
    throw new TreasuryReserveReleaseValidationError(
      "Reserve ID is required to validate a treasury reserve release",
      TreasuryReserveReleaseValidationErrorCode.MISSING_RESERVE,
      context,
      { reserveId: request.reserveId }
    );
  }

  if (!reserve.reserveId || reserve.reserveId !== request.reserveId) {
    throw new TreasuryReserveReleaseValidationError(
      `Reserve ${request.reserveId} does not match the provided snapshot ${reserve.reserveId ?? "[empty]"}`,
      TreasuryReserveReleaseValidationErrorCode.UNKNOWN_RESERVE,
      { ...context, reserveId: request.reserveId },
      { requestedReserveId: request.reserveId, snapshotReserveId: reserve.reserveId }
    );
  }

  if (isTreasuryReserveReleasePaused(contractPauseState)) {
    throw new TreasuryReserveReleaseValidationError(
      TREASURY_RESERVE_RELEASE_PAUSED_MESSAGE,
      TreasuryReserveReleaseValidationErrorCode.CONTRACT_PAUSED,
      { ...context, reserveId: request.reserveId },
      {
        isPaused: contractPauseState?.isPaused === true,
        pausedCategories: normalizePausedCategories(contractPauseState),
      }
    );
  }

  if (!isPositiveBigint(request.amount)) {
    throw new TreasuryReserveReleaseValidationError(
      "Release amount must be a positive bigint",
      TreasuryReserveReleaseValidationErrorCode.INVALID_AMOUNT,
      { ...context, reserveId: request.reserveId },
      { amount: request.amount }
    );
  }

  if (!isNonNegativeBigint(reserve.lockedAmount) || !isNonNegativeBigint(reserve.releasedAmount)) {
    throw new TreasuryReserveReleaseValidationError(
      "Reserve amounts (locked/released) must be non-negative bigints",
      TreasuryReserveReleaseValidationErrorCode.INVALID_AMOUNT,
      { ...context, reserveId: request.reserveId },
      { lockedAmount: reserve.lockedAmount, releasedAmount: reserve.releasedAmount }
    );
  }

  if (reserve.status !== "active" && reserve.status !== "locked") {
    throw new TreasuryReserveReleaseValidationError(
      `Reserve ${reserve.reserveId} is ${reserve.status} and cannot be released`,
      TreasuryReserveReleaseValidationErrorCode.INVALID_STATUS,
      { ...context, reserveId: request.reserveId },
      { status: reserve.status }
    );
  }

  if (typeof reserve.expiresAt === "number" && reserve.expiresAt <= now) {
    throw new TreasuryReserveReleaseValidationError(
      `Reserve ${reserve.reserveId} expired at ${reserve.expiresAt} and cannot be released`,
      TreasuryReserveReleaseValidationErrorCode.EXPIRED,
      { ...context, reserveId: request.reserveId },
      { expiresAt: reserve.expiresAt, now }
    );
  }

  if (typeof request.deadline === "number" && request.deadline < now) {
    throw new TreasuryReserveReleaseValidationError(
      `Release deadline ${request.deadline} has already passed (current time ${now})`,
      TreasuryReserveReleaseValidationErrorCode.EXPIRED,
      { ...context, reserveId: request.reserveId },
      { deadline: request.deadline, now }
    );
  }

  const requiredRoles =
    Array.isArray(request.requiredRoles) && request.requiredRoles.length > 0
      ? request.requiredRoles.map((role) => String(role).toUpperCase())
      : DEFAULT_REQUIRED_ROLES;

  const requesterRoles = normalizeRoles(request.requesterRoles);
  const isAuthorized = requesterRoles.some((role) => requiredRoles.includes(role));

  if (!isAuthorized) {
    throw new TreasuryReserveReleaseValidationError(
      `Requester ${request.requester ?? "[empty]"} is not authorized to release reserve ${request.reserveId}. Required one of: ${requiredRoles.join(", ")}`,
      TreasuryReserveReleaseValidationErrorCode.UNAUTHORIZED,
      { ...context, reserveId: request.reserveId },
      { requester: request.requester, requesterRoles, requiredRoles }
    );
  }

  const available = reserve.lockedAmount - reserve.releasedAmount;
  const warnings: string[] = [];

  let releaseAmount: bigint;
  if (request.mode === "full") {
    releaseAmount = available;
    if (request.amount !== available) {
      warnings.push(
        `Release mode "full" overrides requested amount ${request.amount} to available ${available}`
      );
    }
  } else if (request.mode === "partial") {
    releaseAmount = request.amount;
  } else {
    throw new TreasuryReserveReleaseValidationError(
      `Unsupported release mode "${String(request.mode)}". Expected "full" or "partial"`,
      TreasuryReserveReleaseValidationErrorCode.INVALID_AMOUNT,
      { ...context, reserveId: request.reserveId },
      { mode: request.mode }
    );
  }

  if (releaseAmount > available) {
    throw new TreasuryReserveReleaseValidationError(
      `Release amount ${releaseAmount} exceeds available reserve balance ${available}`,
      TreasuryReserveReleaseValidationErrorCode.INSUFFICIENT_BALANCE,
      { ...context, reserveId: request.reserveId },
      { releaseAmount, available }
    );
  }

  const remainingLockedAmount = available - releaseAmount;
  const nextStatus: TreasuryReserveStatus = remainingLockedAmount === 0n ? "released" : "locked";

  if (remainingLockedAmount > 0n && remainingLockedAmount < releaseAmount) {
    warnings.push(
      "Remaining locked balance is lower than the released amount; consider a full release"
    );
  }

  return {
    valid: true,
    releaseAmount,
    remainingLockedAmount,
    nextStatus,
    warnings,
  };
}
