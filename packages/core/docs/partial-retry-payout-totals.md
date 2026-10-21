# Payout Totals After a Partial Retry (#813)

When a payout batch only partially succeeds, operators retry the failed items.
The retry payload is not the batch total: summing it would double-count items
that already settled or miss items that are still outstanding.

`recalculatePayoutTotalsAfterRetry` replays the original attempt and every
retry attempt in order, then reports:

- **`totalAmount`** — aggregate amount actually settled, with each item counted
  at most once.
- **`recoveredAmount`** — the portion of `totalAmount` that settled on a retry
  (attempt `2` or later).
- **`outstandingAmount`** — amount that is still unpaid after the latest
  reported attempt.
- **`totalsByAsset`** — the same settled, recovered, and outstanding amounts,
  grouped by asset code and sorted for deterministic output.
- **`counts`** — settled, recovered, outstanding, failed, pending, and skipped
  item counts.

## Usage

```ts
import { recalculatePayoutTotalsAfterRetry } from "@zk-payroll/core";

const totals = recalculatePayoutTotalsAfterRetry({
  entries: [
    { itemId: "line-1", amount: 1_000n, asset: "USDC" },
    { itemId: "line-2", amount: 2_500n, asset: "USDC" },
  ],
  attempts: [
    {
      attempt: 1,
      outcomes: [
        { itemId: "line-1", outcome: "succeeded" },
        { itemId: "line-2", outcome: "failed", failureCode: "INSUFFICIENT_FUNDS" },
      ],
    },
    {
      attempt: 2,
      outcomes: [{ itemId: "line-2", outcome: "succeeded" }],
    },
  ],
});

totals.totalAmount; // 3_500n
totals.recoveredAmount; // 2_500n
totals.outstandingAmount; // 0n
totals.isFullySettled; // true
```

`itemId` is a stable identifier the caller owns (an employee ID, batch line ID,
or idempotency key). Attempt `1` is the original execution; retries supply only
the items they retry. Items omitted from a retry keep their latest reported
outcome, so an item that failed and was not retried stays outstanding.

## Validation and failure states

`validatePayoutTotalRecalculation` returns structured issues without throwing.
`recalculatePayoutTotalsAfterRetry` throws `PayoutTotalRecalculationError`
(`PAYOUT_TOTAL_RECALCULATION_FAILED`) when any issue is present.

| Code                       | Meaning                                                          | Fix                                                                 |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `EMPTY_BATCH`              | No original payout entries were supplied.                        | Pass the entries that were submitted before the retry.              |
| `INVALID_ITEM_ID`          | An entry has no usable `itemId`.                                 | Give every entry a stable, non-empty identifier.                    |
| `DUPLICATE_ITEM_ID`        | Two entries share an `itemId`.                                   | Use one entry per item so retries map to a single amount.           |
| `INVALID_AMOUNT`           | An amount is not a positive `bigint`.                            | Use a positive `bigint` in the asset's base units.                  |
| `MISSING_ASSET`            | An entry has no asset code.                                      | Provide the asset for every entry.                                  |
| `INVALID_ATTEMPT`          | An attempt is malformed or its number is not a positive integer. | Number attempts with positive integers.                             |
| `INVALID_ATTEMPT_SEQUENCE` | Attempts do not start at `1` or skip a number.                   | Replay attempts in ascending order, starting at `1`.                |
| `DUPLICATE_OUTCOME`        | The same item is reported twice in one attempt.                  | Report each item once per attempt.                                  |
| `UNKNOWN_ITEM`             | An outcome references an item outside the batch.                 | Only report outcomes for `itemId`s in the original entries.         |
| `INVALID_OUTCOME`          | The outcome value is unsupported.                                | Use `succeeded`, `failed`, `pending`, or `skipped`.                 |
| `DUPLICATE_SUCCESS`        | A settled item is reported as succeeded again.                   | Remove settled items from the retry payload.                        |
| `SETTLED_OUTCOME_REVERSED` | A settled item is later reported as failed, pending, or skipped. | Treat settled outcomes as final and reconcile conflicts separately. |

## Privacy guarantees

- Issues and thrown errors never contain amounts, salaries, recipient
  addresses, or raw employee identifiers.
- Item identifiers are masked in messages (`EMP***001`); the raw identifier is
  not copied into issues.
- Results only contain aggregate amounts keyed by public asset codes.
