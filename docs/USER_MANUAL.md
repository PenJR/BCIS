# BCIS User Manual

This guide describes controls present in the current Electron application. Use synthetic records for training. Access and available actions depend on the signed-in role. The desktop UI does not expose every API capability.

## 1. Start and sign in

1. Start PostgreSQL and the BCIS API server, or confirm the server operator has started them.
2. On Windows, launch the installed **BCIS** application.
3. Wait for the sign-in page and enter your assigned username and password.
4. Select **Sign in**.
5. On success, BCIS opens the Dashboard. The sidebar reports **API connected** when its health request succeeds.

If login fails, confirm the API address is configured and the server database is available. Contact the system administrator for account help; do not share passwords in screenshots or reports.

## 2. Dashboard and navigation

1. Select a section in the left **WORKSPACE** navigation.
2. Use the dashboard cards for subscriber, active service, outstanding, and overdue totals.
3. Review Collection desk and Attention required for open batches, pending payments, and receivables.
4. Review Recent invoices for the latest returned invoice records.
5. Use **Retry** when the summary cannot load.

The dashboard is a live summary, not an accounting approval or audit sign-off.

## 3. Subscribers

1. Open **Subscribers**.
2. Search using account number, name, or phone in the search box.
3. Select **View** to inspect the subscriber profile, addresses, and additional contacts.
4. Users in manager roles (`OWNER`, `ADMINISTRATOR`, `COLLECTION_SUPERVISOR`) can choose **Add subscriber**, complete the validated fields, and select **Create subscriber**.
5. To edit, choose **Edit**, change permitted fields, and select **Save changes**.
6. Confirm the updated record appears in the register.

The current UI displays addresses and contacts in details, but does not provide controls here to add/edit those child records.

## 4. Service accounts and plans

1. Open **Service accounts**.
2. Review subscriber, plan, rate, and status in the inventory.
3. A manager-role user can select **Add service account**, choose an existing subscriber and plan, enter billing dates/days and rate, and select **Create service account**.
4. Choose **Edit** to modify service and billing fields, then select **Save service account**.
5. Confirm the account appears with the expected subscriber, plan, rate, and status.

Plan selection uses existing plans. There is no plan-catalog management screen in the current desktop application; ask an administrator to arrange reference data through the supported server/API process.

## 5. Billing cycles and invoices

1. Open **Billing & invoices**.
2. Review the existing Billing cycles and Invoice register.
3. An `OWNER` or `ADMINISTRATOR` can create a cycle by entering its unique code, period start/end, and due date, then selecting **Create billing cycle**. The period end must not precede the start.
4. Choose an open cycle from **Choose an open cycle to generate…**.
5. Select **Generate invoices** and wait for the completion notice.
6. Check the Invoice register for generated invoices and their total, paid, balance, and status.

Generation skips service accounts already invoiced in that cycle. Confirm the right period and active plans before generation; generated transactions affect financial records.

## 6. Payments and payment history

1. Open **Payments**.
2. A payment-role user (`OWNER`, `ADMINISTRATOR`, `CASHIER`) selects a subscriber, amount, and method, then chooses **Record payment**.
3. Enter the reference when needed. GCash requires a reference number.
4. Review the payment in the list and choose **Manage**.
5. Review allocation and proof/reversal history.
6. For a posted payment, allocate to a displayed eligible invoice using **Allocate payment**, or choose **Allocate to oldest invoices first** for the available unapplied amount.
7. For a pending GCash payment, a payment-role user can attach proof. An authorized owner/administrator can select **Verify GCash payment**.
8. Only owner/administrator can reverse a posted payment. Supply the reason in **Reverse payment** and confirm the updated payment and retained reversal history.

Expected result: successful transactions update payment status, allocation balances, and invoice balances. A rejected request displays an error; resolve it before recording a duplicate payment.

## 7. Receipts, balances, and ledger

### Receipts
1. Open **Receipts**.
2. A payment-role user selects an eligible posted payment in **Issue receipt** and optionally enters a receipt number.
3. Select **Issue receipt** and verify it appears in the Receipt register.
4. Search by receipt/payment/account/name/reference or filter by status and issued-date range.

Receipts are issued only for posted payments. There is no in-app receipt printing or receipt void control in the current UI. The API schema stores void metadata but does not imply that users can perform the operation in the desktop app.

### Balances and ledger
1. Open **Receivables & aging** to review account outstanding and overdue amounts.
2. Select **Review** on an account to view aging buckets and invoice-level balances.
3. Users allowed to view **Reports** can select the **Ledger** report to see debit/credit entries.

Balances reflect posted payment allocations; compare totals with approved accounting records before external reporting.

## 8. Collections, remittances, and receivables

1. Open **Collections** (role-restricted).
2. A manager-role user can make a **Collector assignment** for an area and date range.
3. Use **Create collection batch** with a collector and area that have a valid active assignment.
4. Find the batch in **Collection batches** and choose **Open**.
5. A manager can use **Add account** while the batch is open/in progress. A collection-write user selects **Collect** for an account and records the amount/method/reference in **Record collection**.
6. Follow the on-screen batch status and use the remittance/reconciliation operation exposed for the assigned role and status.
7. Review **Remittance reconciliation** for expected cash, remitted cash, variance, reason, and status.

Expected result: posted collection activity updates batch/account collected values and remittance history. Do not invent or override a variance reason; follow the office reconciliation procedure.

Receivables:
1. Open **Receivables & aging**.
2. Select **Review** to inspect current and overdue balances, invoice detail, and aging.
3. Use the account's service lifecycle controls only if authorized and consistent with office policy.

## 9. Suspensions and reconnections

1. Open **Receivables & aging**, select **Review** for the relevant account.
2. An authorized manager may see **Suspend service** if there is an overdue balance and no active suspension. Enter the date, reason, and optional notes, then submit.
3. The active suspension and suspension history are shown for review.
4. For an account with an active suspension, an authorized manager may complete the reconnection form with request/completion date, fee, and reason/notes.
5. Confirm the record appears under Reconnection activity and the suspension remains in history.

The desktop UI supports recording/completing this workflow; it does not automatically control network equipment. Verify that technical service restoration is performed through the organization's separate operational process.

## 10. Reports, exports, and printing

1. Open **Reports** (role-restricted).
2. Select Invoices, Payments, Collections & remittances, Receivables & aging, Suspensions, Reconnections, or Ledger.
3. Set From/Through dates, status/aging bucket, and search as needed. Select **Clear filters** to reset.
4. Select **Export Excel** or **Export PDF** to download the current filtered report. The collection report also provides exports for its batch register.
5. Open downloaded PDF/XLSX files with approved software. Print a PDF using that software if a paper copy is required.

There is no in-app generic print button. Exported files may contain sensitive operational data; store and share them according to organizational policy.

## 11. User and role administration

The API has protected user, role, and permission endpoints. The current desktop navigation has no **Users**, **Roles**, or user-administration page. An ordinary user cannot create accounts or assign roles through this UI. Contact the designated project/system administrator; do not edit the database manually without an approved procedure.

## 12. Backups and authorized restore

### Create a backup
1. Sign in as `OWNER` or `ADMINISTRATOR`.
2. Open **Backup & restore**.
3. Select **Create backup**.
4. Wait for the success or error message; a successful record is marked verified after PostgreSQL `pg_restore --list` validation.
5. Confirm the record is present in Backup history. Backup files are kept on the API server, not downloaded to the desktop.

### Restore limitations
The restore control is for an isolated database whose name ends in `_restore`, outside production only. It requires server-side `BCIS_ENABLE_RESTORE=true` and a safe `BCIS_RESTORE_DATABASE_URL`; production mode always disables the endpoint. `pg_restore --clean` replaces objects in that isolated target. Confirm the destination carefully and obtain explicit authorization.

This feature is not a production disaster-recovery switch and never changes the live `DATABASE_URL`. Current live-production restoration must follow a separately approved/manual recovery procedure. Never use a valuable/live database as the test restore target.

## 13. Sign out

1. Select **Sign out** in the upper-right profile area.
2. Confirm BCIS returns to the sign-in screen.
3. Close the application when finished.

API sessions are held in process memory and expire after eight hours; API restart invalidates active sessions.

## 14. Troubleshooting

| Symptom | Check |
| --- | --- |
| API unavailable / login cannot connect | Check server process, client `apiBaseUrl`, server LAN address, API port/firewall, and API health URL. |
| API reports connected but database actions fail | The API health endpoint indicates API availability, not database readiness. Ask the server operator to inspect PostgreSQL and the API's `DATABASE_URL`. |
| 401 Authentication required | Sign in again; token may have expired or API may have restarted. |
| 403 permission denied | Ask an administrator to confirm your assigned role and the operation's role gate. |
| Data not loading | Use the screen's refresh/retry control, confirm the database is available, and preserve the displayed error for support. |
| Backup fails | Server operator should verify `pg_dump`/`pg_restore` availability, write access/capacity in `BCIS_BACKUP_DIRECTORY`, and PostgreSQL access without sharing credentials. |
| Installer/client uses wrong server | Check `%APPDATA%\bcis-system\bcis-config.json` contains the exact JSON property `apiBaseUrl`; restart BCIS after changing it. |

Do not send `.env`, database URLs, passwords, tokens, actual subscriber data, or payment references in support screenshots.
