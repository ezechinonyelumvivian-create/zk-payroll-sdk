# Removed Employee Payout Batch Guard (#812)

Removed employees must never receive a regular payroll payout. The
`removedEmployeeGuard` module and the payout batch builders enforce that rule
before a batch is signed or submitted, so a stale roster entry can no longer
sneak a payment through.

## Behavior

A payout-batch entry is rejected when any of the following holds:

| Signal                                                        | Example                                 | Detected by                         |
| ------------------------------------------------------------- | --------------------------------------- | ----------------------------------- |
| Employment status is `removed`, `offboarded`, or `terminated` | `{ status: "Terminated " }`             | `resolveRemovedEmployeeStatus`      |
| Explicit removal marker                                       | `{ isRemoved: true }`                   | `resolveRemovedEmployeeStatus`      |
| Removal timestamp recorded                                    | `{ removedAt: "2026-10-01T00:00:00Z" }` | `resolveRemovedEmployeeStatus`      |
| Employee ID appears in a roster snapshot                      | `{ removedEmployeeIds: ["EMP-042"] }`   | `findRemovedEmployeesInPayoutBatch` |

Detection is case-insensitive and ignores surrounding whitespace. Records with
no status and no removal marker keep working exactly as before, so existing
payroll flows are unaffected.

## Builders

Both payout batch builders reject removed employees by default:

```typescript
import { BatchPayloadBuilder, EmployeeBatchSchemaValidator } from "@zk-payroll/core";

// Employee batch builder — rejects on build()
const validator = new EmployeeBatchSchemaValidator({
  removedEmployeeIds: roster.removedIds, // optional roster snapshot
});
validator.addMany(employees);

const errors = validator.validate();
if (errors.some((error) => error.code === "REMOVED_EMPLOYEE")) {
  // errors[i].redactedEmployeeId is safe to render in the dashboard
}
// build() throws EmployeeBatchValidationFailedError while removed employees remain.
```

```typescript
// Payment batch builder — entries converted from employee records carry the
// removal signals, so the guard also runs on the payment side.
const payload = new BatchPayloadBuilder().addMany(convertToBatchPaymentEntries(employees)).build(); // throws BatchValidationFailedError when a removed employee is present
```

`convertToBatchPaymentEntries` forwards the employee ID, status, and removal
markers onto each `BatchPaymentEntry`, which is why the payment builder can
enforce the same rule.

### Opting out for reviewed settlements

Final wages and offboarding settlements are legitimate payouts for removed
employees. Those flows must be reviewed and should opt out explicitly:

```typescript
const settlement = new EmployeeBatchSchemaValidator({ rejectRemovedEmployees: false });
```

## Standalone helpers

Use the helpers directly when the batch is assembled elsewhere:

```typescript
import {
  assertNoRemovedEmployeesInPayoutBatch,
  findRemovedEmployeesInPayoutBatch,
  isRemovedPayoutEntry,
  partitionPayoutBatchByRemoval,
  RemovedEmployeeInPayoutBatchError,
} from "@zk-payroll/core/employees";

// Fail the whole batch.
try {
  assertNoRemovedEmployeesInPayoutBatch(entries);
} catch (error) {
  if (error instanceof RemovedEmployeeInPayoutBatchError) {
    console.error(error.message); // aggregate count only
    console.error(error.rejections); // per-entry, masked identifiers
  }
}

// Or pay everyone else and surface the skipped employees for review.
const { accepted, rejected } = partitionPayoutBatchByRemoval(entries, {
  removedEmployeeIds: roster.removedIds,
});
```

## Failure states

Every rejection is a `RemovedEmployeeRejection`:

```typescript
interface RemovedEmployeeRejection {
  code: "REMOVED_EMPLOYEE";
  index: number; // position in the batch
  employeeId?: string; // raw ID for roster reconciliation
  redactedEmployeeId: string; // safe for UI/logs, e.g. "EMP***042"
  status?: "removed" | "offboarded" | "terminated";
  message: string; // actionable, masked, no amounts
  suggestedFix: string; // next step for the operator
}
```

Builder validation surfaces the same information as a `REMOVED_EMPLOYEE`
`EmployeeBatchValidationError` / `BatchValidationError` with `index` and
`redactedEmployeeId`.

## Privacy guarantees

- Salaries, amounts, and payout destinations are never included in rejections,
  messages, or thrown errors.
- The thrown `RemovedEmployeeInPayoutBatchError` message contains only an
  aggregate count; per-entry detail lives in `rejections`.
- Identifiers are masked in every human-readable string. The raw `employeeId`
  is exposed only as a structured field so callers can reconcile it with the
  roster.

## Related

- [`checkEmployeeRemoval`](../src/employees/removal.ts) — the inverse check:
  whether an employee can be removed from a draft payroll.
- [`suspensionPayoutEvaluator`](../src/employees/suspensionPayoutEvaluator.ts) —
  payout disposition for suspended employees.
