# Settlement Reconciliation & Creator Payout Statements

## Overview

PromptHash implements transparent, verifiable accounting and settlement reconciliation for creators. Every prompt purchase, platform fee deduction, and refund is tracked item-by-item to produce balanced, exportable payout statements.

## Reconciliation Math & Balancing Invariants

Payout reconciliation obeys the following balancing formula:

$$\text{Net Settlement Amount} = \text{Gross Amount} - \text{Platform Fee Amount} - \text{Refund Amount} + \text{Previous Balance Carryover}$$

### Platform Fee Split
- Platform fee is fixed at **500 basis points (5.00%)**.
- Evaluated with 7 decimal places (Stellar stroop precision, $10^{-7}$ XLM).
- Formula:
  $$\text{platformFeeAmount} = \frac{\text{grossAmount} \times 500}{10000}$$

### Refund vs. Clawback Classification
- **Same-Period Refund**: A refund for an item purchased during the current statement period window $[\text{periodStart}, \text{periodEnd}]$. The creator's net proceeds for that sale are subtracted.
- **Clawback**: A refund for an order purchased and paid out during a *prior* period. Because the creator already received the funds in a prior settlement, the refund is recorded as a clawback deduction in the current period.

### Negative Balance Carryover
- When refunds or clawbacks in a period exceed total gross earnings, the net settlement becomes negative ($\text{netSettlementAmount} < 0$).
- When negative:
  - $\text{payableAmount} = 0$ (no funds are disbursed).
  - $\text{closingBalanceCarryover} = \text{netSettlementAmount}$ (deficit is carried over into the next period).
- In the subsequent period, $\text{previousBalanceCarryover}$ is applied against new sales until the deficit is fully recovered.

## Settlement Status Lifecycle

Statements progress through three distinct states:

| Status | Description | Required Metadata |
|---|---|---|
| `pending` | Statement generated; awaiting on-chain batch disbursement | — |
| `settled` | Funds transferred to creator's Stellar wallet | `payoutTxHash`, `settledAt` |
| `failed` | Payment failed on Stellar network (e.g. unfunded trustline) | `failureReason` |

## Export Formats

Statements can be exported in two formats:

### 1. RFC-4180 Compliant CSV
The CSV export includes:
- Top metadata block (Statement ID, Creator Wallet, Date Range, Currency, Gross, Platform Fee, Refunds, Carryovers, Net Settlement, Payable Amount, Settlement Status, Payout Tx Hash, Settled Date).
- Blank line separator.
- Itemized transaction ledger table with column headers:
  `Line Item ID, Date, Type, Prompt ID, Prompt Title, Buyer Wallet, Gross Amount, Fee Amount, Net Amount, Status, Tx Hash, Notes`
- RFC-4180 escaping: fields with quotes, commas, or newlines are enclosed in double quotes with `""` quote escapes and `\r\n` line endings.

### 2. Structured JSON
Full JSON payload containing both the aggregated settlement summary and the complete list of itemized line item records.

## API Endpoints

### List / Preview Statements
`GET /api/payouts/statements/:walletAddress`

Query Parameters:
- `preview`: `true` to calculate on-the-fly reconciliation for a custom date window without writing to DB.
- `periodStart`: ISO timestamp or `YYYY-MM-DD`.
- `periodEnd`: ISO timestamp or `YYYY-MM-DD`.
- `page`: Page number (default: 1).
- `limit`: Items per page (default: 20).

### Get Statement Details
`GET /api/payouts/statements/:walletAddress/:statementId`

Returns the statement document with full itemized line items.

### Export Statement
`GET /api/payouts/statements/:walletAddress/:statementId/export?format=csv|json`

- If `format=csv`: Returns `text/csv` with `Content-Disposition: attachment; filename="<statementId>.csv"`.
- If `format=json`: Returns `application/json` with `Content-Disposition: attachment; filename="<statementId>.json"`.

### Generate & Persist Statement
`POST /api/payouts/statements/generate`

Request Body:
```json
{
  "creatorWallet": "G...",
  "periodStart": "2026-08-01T00:00:00.000Z",
  "periodEnd": "2026-08-31T23:59:59.999Z",
  "platformFeeBps": 500
}
```

### Update Statement Status
`PATCH /api/payouts/statements/:statementId/status`

Request Body:
```json
{
  "status": "settled",
  "payoutTxHash": "3b29c9...",
  "settledAt": "2026-09-01T12:00:00.000Z"
}
```
Or for failure:
```json
{
  "status": "failed",
  "failureReason": "destination_account_not_funded"
}
```

## Creator UI Integration

Creators can view and manage their payout statements in two locations:
1. **Payout Settings** (`/profile/payouts`): Full dedicated settlement reconciliation card with date filters, status badges, metric summaries, explorer transaction links, and CSV/JSON downloads.
2. **Profile Created Tab** (`/profile`): Embedded reconciliation card directly below the Creator Dashboard.
