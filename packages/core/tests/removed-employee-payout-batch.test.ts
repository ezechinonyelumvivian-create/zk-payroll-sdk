import {
  BatchPayloadBuilder,
  BatchValidationFailedError,
  convertToBatchPaymentEntries,
  EmployeeBatchSchemaValidator,
  EmployeeBatchValidationFailedError,
  validateBatchPayload,
  validateEmployeeBatch,
  type BatchPaymentEntry,
  type EmployeeRecord,
} from "../src/batch";
import {
  assertNoRemovedEmployeesInPayoutBatch,
  findRemovedEmployeesInPayoutBatch,
  isRemovedEmployeeStatus,
  isRemovedPayoutEntry,
  partitionPayoutBatchByRemoval,
  REMOVED_EMPLOYEE_REJECTION_CODE,
  redactEmployeeId,
  RemovedEmployeeInPayoutBatchError,
  resolveRemovedEmployeeStatus,
} from "../src/employees/removedEmployeeGuard";

const activeEmployee: EmployeeRecord = {
  employeeId: "EMP-001",
  recipient: "GACTIVE000000000000000000000000000000000000000000000001",
  salary: 1_000n,
  asset: "native",
  status: "active",
};

const removedEmployee: EmployeeRecord = {
  employeeId: "EMP-042",
  recipient: "GREMOVED00000000000000000000000000000000000000000000042",
  salary: 987_654_321n,
  asset: "native",
  status: "removed",
};

const activeEntry: BatchPaymentEntry = {
  employeeId: "EMP-001",
  recipient: "GACTIVE000000000000000000000000000000000000000000000001",
  amount: 1_000n,
  asset: "native",
  employeeStatus: "active",
};

describe("removed employee payout batch guard", () => {
  describe("success cases", () => {
    it("builds an employee batch when every employee is active", () => {
      const batch = new EmployeeBatchSchemaValidator().addMany([activeEmployee]).build();

      expect(batch.employees).toHaveLength(1);
      expect(batch.totalSalary).toBe(1_000n);
    });

    it("builds an employee batch when no status is supplied (existing flows keep working)", () => {
      const batch = new EmployeeBatchSchemaValidator()
        .add({ employeeId: "EMP-002", recipient: "GA2", salary: 500n, asset: "native" })
        .build();

      expect(batch.employees).toHaveLength(1);
    });

    it("builds a payment batch when every entry belongs to an active employee", () => {
      const payload = new BatchPayloadBuilder().addMany([activeEntry]).build();

      expect(payload.entries).toHaveLength(1);
      expect(payload.totalAmount).toBe(1_000n);
    });

    it("does not flag a non-removal status such as inactive or suspended", () => {
      expect(isRemovedEmployeeStatus("inactive")).toBe(false);
      expect(isRemovedEmployeeStatus("suspended")).toBe(false);
      expect(resolveRemovedEmployeeStatus({ employeeId: "EMP-001", status: "suspended" })).toBe(
        undefined
      );
    });

    it("treats null and empty removal timestamps as no removal record", () => {
      expect(isRemovedPayoutEntry({ employeeId: "EMP-001", removedAt: null })).toBe(false);
      expect(isRemovedPayoutEntry({ employeeId: "EMP-001", removedAt: "" })).toBe(false);
    });

    it("allows a reviewed offboarding settlement when rejection is disabled", () => {
      const validator = new EmployeeBatchSchemaValidator({ rejectRemovedEmployees: false }).add(
        removedEmployee
      );

      expect(validator.validate()).toHaveLength(0);
      expect(validator.build().employees).toHaveLength(1);

      const payload = new BatchPayloadBuilder({ rejectRemovedEmployees: false })
        .add({ ...activeEntry, employeeStatus: "removed" })
        .build();
      expect(payload.entries).toHaveLength(1);
    });

    it("partitions a clean batch without dropping anything", () => {
      const result = partitionPayoutBatchByRemoval([activeEmployee]);

      expect(result.hasRemovedEmployees).toBe(false);
      expect(result.accepted).toEqual([activeEmployee]);
      expect(result.rejected).toHaveLength(0);
    });
  });

  describe("rejection cases", () => {
    it("rejects a removed employee in the employee batch builder", () => {
      const validator = new EmployeeBatchSchemaValidator().addMany([
        activeEmployee,
        removedEmployee,
      ]);

      const errors = validator.validate();
      const removalError = errors.find((error) => error.code === "REMOVED_EMPLOYEE");

      expect(removalError).toBeDefined();
      expect(removalError?.index).toBe(1);
      expect(removalError?.field).toBe("employeeId");
      expect(removalError?.redactedEmployeeId).toBe("EMP***042");

      expect(() => validator.build()).toThrow(EmployeeBatchValidationFailedError);
    });

    it("rejects at build() time with a REMOVED_EMPLOYEE validation error", () => {
      try {
        new EmployeeBatchSchemaValidator().add(removedEmployee).build();
        throw new Error("expected build() to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(EmployeeBatchValidationFailedError);
        const validationError = error as EmployeeBatchValidationFailedError;
        expect(validationError.validationErrors.map((e) => e.code)).toContain("REMOVED_EMPLOYEE");
      }
    });

    it("rejects offboarded and terminated employees", () => {
      for (const status of ["offboarded", "terminated"] as const) {
        const errors = validateEmployeeBatch([{ ...activeEmployee, status }]);
        expect(errors.map((error) => error.code)).toContain("REMOVED_EMPLOYEE");
      }
    });

    it("rejects an employee carrying an explicit isRemoved marker", () => {
      const errors = validateEmployeeBatch([{ ...activeEmployee, isRemoved: true }]);
      expect(errors.map((error) => error.code)).toContain("REMOVED_EMPLOYEE");
    });

    it("rejects an employee carrying a removedAt timestamp", () => {
      const errors = validateEmployeeBatch([
        { ...activeEmployee, removedAt: "2026-10-01T00:00:00.000Z" },
      ]);
      expect(errors.map((error) => error.code)).toContain("REMOVED_EMPLOYEE");
    });

    it("rejects an employee listed in the removedEmployeeIds roster snapshot", () => {
      const employees = [
        activeEmployee,
        { ...activeEmployee, employeeId: "EMP-099", status: undefined, name: "Grace" },
      ];

      const errors = validateEmployeeBatch(employees, { removedEmployeeIds: ["EMP-099"] });
      const removalError = errors.find((error) => error.code === "REMOVED_EMPLOYEE");

      expect(removalError?.index).toBe(1);
      expect(removalError?.redactedEmployeeId).toBe("EMP***099");
    });

    it("rejects removed employees in the payment batch builder", () => {
      const entries: BatchPaymentEntry[] = [
        activeEntry,
        { ...activeEntry, employeeId: "EMP-042", employeeStatus: "removed" },
      ];

      const errors = validateBatchPayload(entries);
      const removalError = errors.find((error) => error.code === "REMOVED_EMPLOYEE");

      expect(removalError?.index).toBe(1);
      expect(removalError?.redactedEmployeeId).toBe("EMP***042");
      expect(() => new BatchPayloadBuilder().addMany(entries).build()).toThrow(
        BatchValidationFailedError
      );
    });

    it("honours removedEmployeeIds on the payment batch builder", () => {
      const errors = validateBatchPayload([activeEntry], { removedEmployeeIds: ["EMP-001"] });

      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("REMOVED_EMPLOYEE");
    });

    it("rejects converted entries end to end", () => {
      const entries = convertToBatchPaymentEntries([activeEmployee, removedEmployee]);

      expect(entries[1].employeeId).toBe("EMP-042");
      expect(entries[1].employeeStatus).toBe("removed");
      expect(() => new BatchPayloadBuilder().addMany(entries).build()).toThrow(
        BatchValidationFailedError
      );
    });

    it("throws RemovedEmployeeInPayoutBatchError from the standalone assertion", () => {
      expect(() => assertNoRemovedEmployeesInPayoutBatch([removedEmployee])).toThrow(
        RemovedEmployeeInPayoutBatchError
      );
    });

    it("drops removed employees from accepted entries when partitioning", () => {
      const result = partitionPayoutBatchByRemoval([activeEmployee, removedEmployee]);

      expect(result.hasRemovedEmployees).toBe(true);
      expect(result.accepted).toEqual([activeEmployee]);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].code).toBe(REMOVED_EMPLOYEE_REJECTION_CODE);
      expect(result.rejected[0].index).toBe(1);
    });

    it("reports every offending line instead of deduplicating them", () => {
      const rejections = findRemovedEmployeesInPayoutBatch([removedEmployee, removedEmployee]);

      expect(rejections).toHaveLength(2);
      expect(rejections.map((rejection) => rejection.index)).toEqual([0, 1]);
    });
  });

  describe("boundary cases", () => {
    it("matches status case-insensitively and ignores surrounding whitespace", () => {
      const errors = validateEmployeeBatch([{ ...activeEmployee, status: "  ReMoVeD  " }]);
      expect(errors.map((error) => error.code)).toContain("REMOVED_EMPLOYEE");
      expect(resolveRemovedEmployeeStatus({ status: " TERMINATED " })).toBe("terminated");
    });

    it("treats an empty or whitespace-only status as active", () => {
      expect(isRemovedEmployeeStatus("")).toBe(false);
      expect(isRemovedEmployeeStatus("   ")).toBe(false);
      expect(validateEmployeeBatch([{ ...activeEmployee, status: "   " }])).toHaveLength(0);
    });

    it("treats an epoch-zero removal timestamp as a removal record", () => {
      expect(isRemovedPayoutEntry({ employeeId: "EMP-001", removedAt: 0 })).toBe(true);
    });

    it("ignores a roster match when the entry has no employee ID", () => {
      const entries: BatchPaymentEntry[] = [
        { recipient: "GA1", amount: 10n, asset: "native" },
        { recipient: "GB2", amount: 20n, asset: "native", employeeId: "   " },
      ];

      const rejection = findRemovedEmployeesInPayoutBatch(entries, {
        removedEmployeeIds: ["EMP-042"],
      });

      expect(rejection).toHaveLength(0);
    });

    it("masks short and missing identifiers instead of leaking them", () => {
      expect(redactEmployeeId()).toBe("[ANONYMOUS_EMPLOYEE]");
      expect(redactEmployeeId("   ")).toBe("[ANONYMOUS_EMPLOYEE]");
      expect(redactEmployeeId("EM42")).toBe("[REDACTED_EMPLOYEE]");
      expect(redactEmployeeId("EMP-042")).toBe("EMP***042");
    });

    it("does not expose salary or raw identifiers in messages or thrown errors", () => {
      const [rejection] = findRemovedEmployeesInPayoutBatch([removedEmployee]);

      expect(rejection.message).not.toContain("987654321");
      expect(rejection.message).not.toContain("EMP-042");
      expect(rejection.message).toContain("EMP***042");
      expect(rejection.suggestedFix.length).toBeGreaterThan(0);

      try {
        assertNoRemovedEmployeesInPayoutBatch([removedEmployee]);
        throw new Error("expected assertion to throw");
      } catch (error) {
        const batchError = error as RemovedEmployeeInPayoutBatchError;
        expect(batchError.message).not.toContain("987654321");
        expect(batchError.message).not.toContain("EMP-042");
        expect(batchError.rejections).toHaveLength(1);
      }
    });

    it("reports a removal status without an employee ID using anonymous redaction", () => {
      const rejection = findRemovedEmployeesInPayoutBatch([{ employeeStatus: "offboarded" }]);

      expect(rejection).toHaveLength(1);
      expect(rejection[0].redactedEmployeeId).toBe("[ANONYMOUS_EMPLOYEE]");
      expect(rejection[0].status).toBe("offboarded");
    });
  });
});
