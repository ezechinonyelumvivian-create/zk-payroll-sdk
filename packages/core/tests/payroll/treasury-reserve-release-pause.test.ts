import {
  assertTreasuryReserveReleaseNotPaused,
  isTreasuryReserveReleasePaused,
  TREASURY_RESERVE_RELEASE_BLOCKED_PAUSE_CATEGORIES,
  TREASURY_RESERVE_RELEASE_PAUSED_MESSAGE,
  TreasuryReserveReleaseValidationError,
  TreasuryReserveReleaseValidationErrorCode,
  validateTreasuryReserveRelease,
  type TreasuryReserveContractPauseState,
  type TreasuryReserveReleaseRequest,
  type TreasuryReserveSnapshot,
} from "../../src/payroll/treasuryReserveReleaseValidator";

const reserve: TreasuryReserveSnapshot = {
  reserveId: "reserve-1",
  status: "locked",
  lockedAmount: 10_000n,
  releasedAmount: 1_000n,
};

const request: TreasuryReserveReleaseRequest = {
  reserveId: "reserve-1",
  amount: 2_000n,
  mode: "partial",
  requester: "GADMIN",
  requesterRoles: ["TREASURY"],
};

function captureError(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("treasury reserve release pause guard (#814)", () => {
  describe("success cases", () => {
    it("still validates a release when no pause state is supplied", () => {
      const result = validateTreasuryReserveRelease(request, reserve, 1_000);

      expect(result.valid).toBe(true);
      expect(result.releaseAmount).toBe(2_000n);
      expect(result.remainingLockedAmount).toBe(7_000n);
      expect(result.nextStatus).toBe("locked");
    });

    it("allows releases when only unrelated categories are paused", () => {
      const pauseState: TreasuryReserveContractPauseState = {
        isPaused: false,
        pausedCategories: ["payroll", "proofs", "operations"],
      };

      expect(isTreasuryReserveReleasePaused(pauseState)).toBe(false);
      expect(validateTreasuryReserveRelease(request, reserve, 1_000, {}, pauseState).valid).toBe(
        true
      );
      expect(() => assertTreasuryReserveReleaseNotPaused(pauseState)).not.toThrow();
    });

    it("does not treat an empty pause state as paused", () => {
      expect(isTreasuryReserveReleasePaused(undefined)).toBe(false);
      expect(isTreasuryReserveReleasePaused(null)).toBe(false);
      expect(isTreasuryReserveReleasePaused({})).toBe(false);
      expect(isTreasuryReserveReleasePaused({ isPaused: false, pausedCategories: [] })).toBe(false);
    });
  });

  describe("rejection cases", () => {
    it("blocks a release while the contract is globally paused", () => {
      const error = captureError(() =>
        validateTreasuryReserveRelease(request, reserve, 1_000, {}, { isPaused: true })
      );

      expect(error).toBeInstanceOf(TreasuryReserveReleaseValidationError);
      const validationError = error as TreasuryReserveReleaseValidationError;
      expect(validationError.code).toBe(TreasuryReserveReleaseValidationErrorCode.CONTRACT_PAUSED);
      expect(validationError.message).toBe(TREASURY_RESERVE_RELEASE_PAUSED_MESSAGE);
    });

    it.each([...TREASURY_RESERVE_RELEASE_BLOCKED_PAUSE_CATEGORIES])(
      "blocks a release while the %s category is paused",
      (category) => {
        const error = captureError(() =>
          validateTreasuryReserveRelease(
            request,
            reserve,
            1_000,
            {},
            { pausedCategories: [category] }
          )
        );

        expect(error).toBeInstanceOf(TreasuryReserveReleaseValidationError);
        expect((error as TreasuryReserveReleaseValidationError).code).toBe(
          TreasuryReserveReleaseValidationErrorCode.CONTRACT_PAUSED
        );
      }
    );

    it("normalizes category names before blocking", () => {
      expect(isTreasuryReserveReleasePaused({ pausedCategories: ["  RESERVATIONS  "] })).toBe(true);
      expect(isTreasuryReserveReleasePaused({ pausedCategories: ["Withdrawals"] })).toBe(true);
    });

    it("blocks through the fail-fast helper before a request is built", () => {
      const error = captureError(() => assertTreasuryReserveReleaseNotPaused({ isPaused: true }));

      expect(error).toBeInstanceOf(TreasuryReserveReleaseValidationError);
      expect((error as TreasuryReserveReleaseValidationError).code).toBe(
        TreasuryReserveReleaseValidationErrorCode.CONTRACT_PAUSED
      );
    });

    it("reports the pause before amount validation so the failure is actionable", () => {
      const error = captureError(() =>
        validateTreasuryReserveRelease(
          { ...request, amount: 0n },
          reserve,
          1_000,
          {},
          { isPaused: true }
        )
      );

      expect((error as TreasuryReserveReleaseValidationError).code).toBe(
        TreasuryReserveReleaseValidationErrorCode.CONTRACT_PAUSED
      );
    });

    it("does not expose amounts or employee data in the pause rejection", () => {
      const error = captureError(() =>
        validateTreasuryReserveRelease(request, reserve, 1_000, {}, { isPaused: true })
      ) as TreasuryReserveReleaseValidationError;

      const serialized = JSON.stringify({
        message: error.message,
        context: error.context,
        details: error.details,
      });

      expect(serialized).not.toContain("10000");
      expect(serialized).not.toContain("2000");
      expect(serialized).not.toContain("salary");
      expect(serialized).not.toContain("employee");
      expect(error.details).toEqual({ isPaused: true, pausedCategories: [] });
    });
  });

  describe("boundary cases", () => {
    it("treats a category-only pause without isPaused as paused", () => {
      expect(isTreasuryReserveReleasePaused({ pausedCategories: ["reservations"] })).toBe(true);
      expect(isTreasuryReserveReleasePaused({ pausedCategories: ["deposits"] })).toBe(false);
    });

    it("keeps category pauses blocking even when isPaused is false", () => {
      const error = captureError(() =>
        validateTreasuryReserveRelease(
          request,
          reserve,
          1_000,
          {},
          {
            isPaused: false,
            pausedCategories: ["withdrawals"],
          }
        )
      );

      expect((error as TreasuryReserveReleaseValidationError).code).toBe(
        TreasuryReserveReleaseValidationErrorCode.CONTRACT_PAUSED
      );
    });
  });
});
