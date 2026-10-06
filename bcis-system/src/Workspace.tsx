import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useForm,
  type Path,
} from 'react-hook-form';
import { z } from 'zod';
import { getCoreRowModel, useLegacyTable } from '@tanstack/react-table/legacy';
import { apiRequest, type ApiResponse } from './api';
import {
  billingRoles,
  collectionWriteRoles,
  managerRoles,
  paymentRoles,
  reversalRoles,
} from './roles';

type Auth = {
  token: string;
  user: {
    id: number;
    role: string;
  };
};
type Row = Record<string, unknown>;
type Page =
  | 'dashboard'
  | 'subscribers'
  | 'service-accounts'
  | 'billing'
  | 'payments'
  | 'collections'
  | 'receivables'
  | 'receipts'
  | 'reports';
type FormSchema = z.ZodObject<z.ZodRawShape>;
type FormInput<S extends FormSchema> = z.input<S>;
type FormField<S extends FormSchema> = {
  name: Path<FormInput<S>>;
  label: string;
  type?: 'text' | 'number' | 'date' | 'email' | 'password' | 'textarea' | 'select';
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
};
type FormProps<S extends FormSchema> = {
  schema: S;
  fields: readonly FormField<S>[];
  defaults: FormInput<S>;
  submitLabel: string;
  onSubmit: (values: z.output<S>) => Promise<void>;
  onCancel?: () => void;
};

const positiveId = z.string().regex(/^[1-9]\d*$/, 'Choose a valid record.');
const optionalId = z.string().optional();
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Use an amount with up to two decimals.');
const requiredText = (label: string) => z.string().trim().min(1, `Enter ${label}.`);

const schemas = {
  subscriber: z.object({
    accountNumber: requiredText('an account number'),
    firstName: requiredText('a first name'),
    middleName: z.string().optional(),
    lastName: requiredText('a last name'),
    contactNumber: z.string().optional(),
    email: z.union([z.literal(''), z.string().email('Enter a valid email address.')]).optional(),
    collectionAreaId: optionalId,
    billingDay: z.string().regex(/^(?:[1-9]|[12]\d|3[01])$/, 'Enter a day from 1 to 31.'),
    dueDay: z.string().regex(/^(?:[1-9]|[12]\d|3[01])$/, 'Enter a day from 1 to 31.'),
    status: z.string().min(1),
    notes: z.string().optional(),
  }),
  subscriberEdit: z.object({
    accountNumber: z.string().optional(),
    firstName: requiredText('a first name'),
    middleName: z.string().optional(),
    lastName: requiredText('a last name'),
    contactNumber: z.string().optional(),
    email: z.union([z.literal(''), z.string().email('Enter a valid email address.')]).optional(),
    collectionAreaId: optionalId,
    billingDay: z.string().regex(/^(?:[1-9]|[12]\d|3[01])$/, 'Enter a day from 1 to 31.'),
    dueDay: z.string().regex(/^(?:[1-9]|[12]\d|3[01])$/, 'Enter a day from 1 to 31.'),
    status: z.string().min(1),
    notes: z.string().optional(),
  }),
  serviceAccount: z.object({
    serviceAccountNumber: requiredText('a service account number'),
    subscriberId: positiveId,
    planId: positiveId,
    billingStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a billing start date.'),
    billingDay: z.string().regex(/^(?:[1-9]|[12]\d|3[01])$/, 'Enter a day from 1 to 31.'),
    dueDay: z.string().regex(/^(?:[1-9]|[12]\d|3[01])$/, 'Enter a day from 1 to 31.'),
    currentRate: money,
    status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'CLOSED']),
  }),
  serviceAccountEdit: z.object({
    serviceAccountNumber: requiredText('a service account number'),
    subscriberId: positiveId,
    planId: positiveId,
    billingStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a billing start date.'),
    billingDay: z.string().regex(/^(?:[1-9]|[12]\d|3[01])$/, 'Enter a day from 1 to 31.'),
    dueDay: z.string().regex(/^(?:[1-9]|[12]\d|3[01])$/, 'Enter a day from 1 to 31.'),
    currentRate: money,
  }),
  cycle: z.object({
    cycleCode: requiredText('a cycle code'),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).refine((value) => value.periodEnd >= value.periodStart, {
    message: 'Period end must not be before period start.',
    path: ['periodEnd'],
  }),
  payment: z.object({
    subscriberId: positiveId,
    amount: money.refine((value) => /[1-9]/.test(value), 'Amount must be greater than zero.'),
    paymentMethod: z.enum(['Cash', 'GCash', 'Bank Transfer', 'Cheque', 'Other']),
    referenceNumber: z.string().optional(),
    notes: z.string().optional(),
  }).superRefine((value, context) => {
    if (value.paymentMethod === 'GCash' && !value.referenceNumber?.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['referenceNumber'],
        message: 'A GCash reference number is required.',
      });
    }
  }),
  allocation: z.object({
    invoiceId: positiveId,
    amount: money.refine((value) => /[1-9]/.test(value), 'Amount must be greater than zero.'),
  }),
  proof: z.object({
    referenceNumber: requiredText('a reference number'),
    senderName: z.string().optional(),
    amount: z.union([z.literal(''), money]).optional(),
    filePath: z.string().optional(),
  }),
  reversal: z.object({ reason: requiredText('a reversal reason') }),
  receipt: z.object({ paymentId: positiveId, receiptNumber: z.string().optional() }),
  assignment: z.object({
    collectorId: positiveId,
    collectionAreaId: positiveId,
    assignedFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    assignedTo: z.string().optional(),
  }),
  batch: z.object({
    batchNumber: requiredText('a batch number'),
    collectorId: positiveId,
    collectionAreaId: positiveId,
    collectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notes: z.string().optional(),
  }),
  batchAccount: z.object({
    serviceAccountId: positiveId,
    expectedAmount: money.refine((value) => /[1-9]/.test(value), 'Amount must be greater than zero.'),
  }),
  collectionPayment: z.object({
    amount: money.refine((value) => /[1-9]/.test(value), 'Amount must be greater than zero.'),
    paymentMethod: z.enum(['Cash', 'GCash', 'Bank Transfer', 'Cheque', 'Other']),
    referenceNumber: z.string().optional(),
    notes: z.string().optional(),
  }),
  remittance: z.object({
    remittedCash: money,
    shortageReason: z.string().optional(),
  }),
  suspension: z.object({
    suspensionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: requiredText('a suspension reason'),
    notes: z.string().optional(),
  }),
  reconnection: z.object({
    requestDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    completionDate: z.string().optional(),
    reconnectionFee: money,
    notes: requiredText('a reconnection reason'),
  }),
};

const formFields = {
  subscriber: [
    { name: 'accountNumber', label: 'Subscriber account number' },
    { name: 'firstName', label: 'First name' },
    { name: 'middleName', label: 'Middle name' },
    { name: 'lastName', label: 'Last name' },
    { name: 'contactNumber', label: 'Contact number' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'collectionAreaId', label: 'Collection area ID', type: 'number' },
    { name: 'billingDay', label: 'Billing day', type: 'number' },
    { name: 'dueDay', label: 'Due day', type: 'number' },
    { name: 'status', label: 'Status' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ],
  subscriberEdit: [
    { name: 'firstName', label: 'First name' },
    { name: 'middleName', label: 'Middle name' },
    { name: 'lastName', label: 'Last name' },
    { name: 'contactNumber', label: 'Contact number' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'collectionAreaId', label: 'Collection area ID', type: 'number' },
    { name: 'billingDay', label: 'Billing day', type: 'number' },
    { name: 'dueDay', label: 'Due day', type: 'number' },
    { name: 'status', label: 'Status' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ],
  serviceAccount: [
    { name: 'serviceAccountNumber', label: 'Service account number' },
    { name: 'subscriberId', label: 'Subscriber', type: 'select' },
    { name: 'planId', label: 'Service plan ID', type: 'number' },
    { name: 'billingStartDate', label: 'Billing start date', type: 'date' },
    { name: 'billingDay', label: 'Billing day', type: 'number' },
    { name: 'dueDay', label: 'Due day', type: 'number' },
    { name: 'currentRate', label: 'Monthly rate' },
    { name: 'status', label: 'Status', type: 'select' },
  ],
  cycle: [
    { name: 'cycleCode', label: 'Cycle code' },
    { name: 'periodStart', label: 'Period start', type: 'date' },
    { name: 'periodEnd', label: 'Period end', type: 'date' },
    { name: 'dueDate', label: 'Due date', type: 'date' },
  ],
  payment: [
    { name: 'subscriberId', label: 'Subscriber', type: 'select' },
    { name: 'amount', label: 'Amount' },
    { name: 'paymentMethod', label: 'Payment method', type: 'select' },
    { name: 'referenceNumber', label: 'Reference number' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ],
  allocation: [
    { name: 'invoiceId', label: 'Invoice', type: 'select' },
    { name: 'amount', label: 'Allocation amount' },
  ],
  proof: [
    { name: 'referenceNumber', label: 'GCash reference number' },
    { name: 'senderName', label: 'Sender name' },
    { name: 'amount', label: 'Proof amount' },
    { name: 'filePath', label: 'Proof file path' },
  ],
  reversal: [{ name: 'reason', label: 'Reversal reason', type: 'textarea' }],
  receipt: [
    { name: 'paymentId', label: 'Payment', type: 'select' },
    { name: 'receiptNumber', label: 'Receipt number (optional)' },
  ],
  assignment: [
    { name: 'collectorId', label: 'Collector user ID', type: 'number' },
    { name: 'collectionAreaId', label: 'Collection area ID', type: 'number' },
    { name: 'assignedFrom', label: 'Start date', type: 'date' },
    { name: 'assignedTo', label: 'End date (optional)', type: 'date' },
  ],
  batch: [
    { name: 'batchNumber', label: 'Batch number' },
    { name: 'collectorId', label: 'Collector user ID', type: 'number' },
    { name: 'collectionAreaId', label: 'Collection area ID', type: 'number' },
    { name: 'collectionDate', label: 'Collection date', type: 'date' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ],
  batchAccount: [
    { name: 'serviceAccountId', label: 'Service account', type: 'select' },
    { name: 'expectedAmount', label: 'Expected amount' },
  ],
  collectionPayment: [
    { name: 'amount', label: 'Collected amount' },
    { name: 'paymentMethod', label: 'Payment method', type: 'select' },
    { name: 'referenceNumber', label: 'Reference number' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ],
  remittance: [
    { name: 'remittedCash', label: 'Cash remitted' },
    { name: 'shortageReason', label: 'Variance explanation (if short)' },
  ],
  suspension: [
    { name: 'suspensionDate', label: 'Suspension date', type: 'date' },
    { name: 'reason', label: 'Reason', type: 'textarea' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ],
  reconnection: [
    { name: 'requestDate', label: 'Reconnection date', type: 'date' },
    { name: 'completionDate', label: 'Completion date', type: 'date' },
    { name: 'reconnectionFee', label: 'Fee' },
    { name: 'notes', label: 'Reason / work notes', type: 'textarea' },
  ],
} as const;

function FormPanel<S extends FormSchema>({
  schema,
  fields,
  defaults,
  submitLabel,
  onSubmit,
  onCancel,
}: FormProps<S>) {
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const form = useForm<Record<string, string | undefined>>({
    defaultValues: defaults as Record<string, string | undefined>,
  });

  const submit = form.handleSubmit(async (values) => {
    setFormError('');
    setMessage('');
    form.clearErrors();
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === 'string') {
          form.setError(field as Path<Record<string, string | undefined>>, {
            type: 'validate',
            message: issue.message,
          });
        }
      }
      return;
    }
    setSaving(true);
    try {
      await onSubmit(parsed.data);
      setMessage('Saved successfully.');
      form.reset(defaults as Record<string, string | undefined>);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Unable to save this record.');
    } finally {
      setSaving(false);
    }
  });

  return (
    <form className="form-panel form-grid" onSubmit={submit}>
      {fields.map((field) => {
        const name = field.name as Path<Record<string, string | undefined>>;
        const errorMessage = form.formState.errors[name]?.message;
        const type = field.type ?? 'text';
        return (
          <label className={`field ${type === 'textarea' ? 'field-wide' : ''}`} key={field.name}>
            {field.label}
            {type === 'textarea' ? (
              <textarea rows={3} {...form.register(name)} />
            ) : type === 'select' ? (
              <select {...form.register(name)}>
                <option value="">Choose…</option>
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : (
              <input type={type} placeholder={field.placeholder} {...form.register(name)} />
            )}
            {errorMessage !== undefined && <small className="field-error">{String(errorMessage)}</small>}
          </label>
        );
      })}
      {formError && <div className="notice error field-wide" role="alert">{formError}</div>}
      {message && <div className="notice success field-wide" role="status">{message}</div>}
      <div className="form-actions field-wide">
        {onCancel && <button className="button button-quiet" type="button" onClick={onCancel}>Cancel</button>}
        <button className="primary-button" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

function useResource<T extends Row>(path: string, token: string) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await apiRequest<T[]>(path, token);
      if (!response.success) throw new Error(response.message ?? 'Unable to load records.');
      setData(Array.isArray(response.data) ? response.data : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load records.');
    } finally {
      setLoading(false);
    }
  }, [path, token]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { data, loading, error, refresh, setData };
}

function rowString(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function DataTable({
  rows,
  fields,
  labels = {},
  empty = 'No records found.',
  actions,
}: {
  rows: Row[];
  fields: string[];
  labels?: Record<string, string>;
  empty?: string;
  actions?: (row: Row) => React.ReactNode;
}) {
  const columns = useMemo(
    () => fields.map((field) => ({
      accessorKey: field,
      header: labels[field] ?? field.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()),
    })),
    [fields, labels],
  );
  const table = useLegacyTable<Row>({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (rows.length === 0) return <div className="empty-state">{empty}</div>;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th key={header.id}>{rowString(header.column.columnDef.header)}</th>
              ))}
              {actions && <th>Actions</th>}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{rowString(cell.getValue())}</td>
              ))}
              {actions && <td className="row-actions">{actions(row.original)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LoadState({
  loading,
  error,
  refresh,
  children,
}: {
  loading: boolean;
  error: string;
  refresh?: () => void;
  children: React.ReactNode;
}) {
  if (loading) return <div className="loading-state"><span className="spinner" />Loading records…</div>;
  if (error) {
    return (
      <div className="notice error load-error" role="alert">
        <span>{error}</span>
        {refresh && <button className="button button-quiet" onClick={refresh}>Retry</button>}
      </div>
    );
  }
  return <>{children}</>;
}

function Panel({ title, description, children, className = '' }: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
      </div>
      {children}
    </section>
  );
}

function SectionTitle({ title, detail }: { title: string; detail: string }) {
  return <div className="section-title"><div><h2>{title}</h2><p>{detail}</p></div></div>;
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cents(value: unknown): bigint {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '0';
  const [whole, fraction = ''] = text.split('.');
  if (!/^\d+$/.test(whole)) return 0n;
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

function moneyText(value: bigint): string {
  return `₱${(value / 100n).toLocaleString('en-PH')}.${(value % 100n).toString().padStart(2, '0')}`;
}

async function mutate<T = Row>(
  path: string,
  token: string,
  body: unknown,
  method = 'POST',
): Promise<T> {
  const response = await apiRequest<T>(path, token, {
    method,
    body: JSON.stringify(body),
  });
  if (!response.success) throw new Error(response.message ?? 'The request could not be completed.');
  return response.data as T;
}

function optionRows(rows: Row[], valueKey: string, label: (row: Row) => string) {
  return rows.map((row) => ({ value: String(row[valueKey] ?? ''), label: label(row) }));
}

function Dashboard({ auth }: { auth: Auth }) {
  const [summary, setSummary] = useState<{
    subscribers: Row[];
    accounts: Row[];
    invoices: Row[];
    payments: Row[];
    batches: Row[];
    receivables: Row[];
  }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [subscribers, accounts, invoices, payments, batches, receivables] = await Promise.all([
        apiRequest<Row[]>('/api/v1/subscribers', auth.token),
        apiRequest<Row[]>('/api/v1/service-accounts', auth.token),
        apiRequest<Row[]>('/api/v1/invoices', auth.token),
        apiRequest<Row[]>('/api/v1/payments', auth.token),
        apiRequest<Row[]>('/api/v1/collection-batches', auth.token),
        apiRequest<Row[]>('/api/v1/receivables', auth.token),
      ]);
      const responses: ApiResponse<Row[]>[] = [subscribers, accounts, invoices, payments, batches, receivables];
      const failed = responses.find((item) => !item.success);
      if (failed) throw new Error(failed.message ?? 'A dashboard data source could not be loaded.');
      setSummary({
        subscribers: subscribers.data ?? [],
        accounts: accounts.data ?? [],
        invoices: invoices.data ?? [],
        payments: payments.data ?? [],
        batches: batches.data ?? [],
        receivables: receivables.data ?? [],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Dashboard data could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [auth.token]);
  useEffect(() => { void load(); }, [load]);

  if (loading) return <div className="loading-state"><span className="spinner" />Loading office summary…</div>;
  if (error || !summary) return <div className="notice error">{error || 'Dashboard unavailable.'}<button className="button button-quiet" onClick={() => void load()}>Retry</button></div>;

  const outstanding = summary.receivables.reduce(
    (sum, account) => sum + cents(account.outstandingBalance),
    0n,
  );
  const overdue = summary.receivables.reduce(
    (sum, account) => sum + cents(account.overdueBalance),
    0n,
  );
  const today = new Date().toISOString().slice(0, 10);
  const pendingPayments = summary.payments.filter((payment) => payment.status === 'PENDING');
  const openBatches = summary.batches.filter((batch) => ['OPEN', 'IN_PROGRESS', 'SUBMITTED'].includes(String(batch.status)));
  const activeAccounts = summary.accounts.filter((account) => account.status === 'ACTIVE');

  return (
    <div className="page-content">
      <SectionTitle title="Good day" detail="A live snapshot of subscriber, billing and collection activity." />
      <section className="metric-grid">
        <Metric label="Subscribers" value={summary.subscribers.length.toLocaleString()} note="Accounts in the register" />
        <Metric label="Active services" value={activeAccounts.length.toLocaleString()} note="Service accounts currently active" />
        <Metric label="Outstanding" value={moneyText(outstanding)} note={`${summary.receivables.length} service accounts with balances`} />
        <Metric label="Overdue receivables" value={moneyText(overdue)} note="Based on invoices past due date" tone="warning" />
      </section>
      <div className="dashboard-grid">
        <Panel title="Collection desk" description={`Open batches and pending digital payments as of ${today}.`}>
          <div className="summary-lines">
            <SummaryLine label="Open collection batches" value={String(openBatches.length)} />
            <SummaryLine label="Pending payments" value={String(pendingPayments.length)} />
            <SummaryLine label="Invoices currently listed" value={String(summary.invoices.length)} />
          </div>
        </Panel>
        <Panel title="Attention required" description="Items that may need follow-up by the office.">
          {pendingPayments.length === 0 && summary.receivables.length === 0
            ? <div className="empty-state compact">No outstanding follow-up items.</div>
            : (
              <div className="summary-lines">
                <SummaryLine label="Unverified / pending payments" value={String(pendingPayments.length)} />
                <SummaryLine label="Accounts with receivables" value={String(summary.receivables.length)} />
                <SummaryLine label="Past-due balance" value={moneyText(overdue)} />
              </div>
            )}
        </Panel>
      </div>
      <Panel title="Recent invoices" description="Latest invoices returned by the billing service.">
        <DataTable
          rows={summary.invoices.slice(0, 8)}
          fields={['invoiceNumber', 'subscriberAccountNumber', 'totalAmount', 'amountPaid', 'balance', 'status']}
          labels={{ invoiceNumber: 'Invoice', subscriberAccountNumber: 'Subscriber', totalAmount: 'Total', amountPaid: 'Paid', balance: 'Balance' }}
        />
      </Panel>
    </div>
  );
}

function Metric({ label, value, note, tone = '' }: { label: string; value: string; note: string; tone?: string }) {
  return <article className={`metric-card ${tone}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return <div className="summary-line"><span>{label}</span><strong>{value}</strong></div>;
}

function Subscribers({ auth }: { auth: Auth }) {
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<Row | 'new' | null>(null);
  const [detail, setDetail] = useState<Row | null>(null);
  const { data, loading, error, refresh } = useResource<Row>(`/api/v1/subscribers${search ? `?search=${encodeURIComponent(search)}` : ''}`, auth.token);
  const areas = useResource<Row>('/api/v1/collection-areas', auth.token);
  const canEdit = managerRoles.includes(auth.user.role);
  const schema = editor === 'new' ? schemas.subscriber : schemas.subscriberEdit;
  const defaults = editor === 'new'
    ? { accountNumber: '', firstName: '', middleName: '', lastName: '', contactNumber: '', email: '', collectionAreaId: '', billingDay: '1', dueDay: '15', status: 'ACTIVE', notes: '' }
    : {
      accountNumber: String(editor?.accountNumber ?? ''),
      firstName: String(editor?.firstName ?? ''),
      middleName: String(editor?.middleName ?? ''),
      lastName: String(editor?.lastName ?? ''),
      contactNumber: String(editor?.contactNumber ?? ''),
      email: String(editor?.email ?? ''),
      collectionAreaId: String(editor?.collectionAreaId ?? ''),
      billingDay: String(editor?.billingDay ?? '1'),
      dueDay: String(editor?.dueDay ?? '15'),
      status: String(editor?.status ?? 'ACTIVE'),
      notes: String(editor?.notes ?? ''),
    };

  const submit = async (
    values: z.output<typeof schemas.subscriber> | z.output<typeof schemas.subscriberEdit>,
  ) => {
    const payload: Row = {
      ...values,
      billingDay: asNumber(values.billingDay),
      dueDay: asNumber(values.dueDay),
    };
    if (editor !== 'new') delete payload.accountNumber;
    if (values.collectionAreaId) payload.collectionAreaId = asNumber(values.collectionAreaId);
    else if (editor !== 'new') payload.collectionAreaId = null;
    if (!values.email) {
      if (editor !== 'new') payload.email = null;
      else delete payload.email;
    }
    if (editor === 'new') {
      await mutate('/api/v1/subscribers', auth.token, payload);
    } else if (editor && typeof editor !== 'string') {
      await mutate(`/api/v1/subscribers/${editor.id}`, auth.token, payload, 'PUT');
    }
    setEditor(null);
    await refresh();
  };

  return (
    <div className="page-content">
      <SectionTitle title="Subscriber register" detail="Search customer accounts, review contact details and maintain subscriber records." />
      <Panel title="Subscribers" description={`${data.length.toLocaleString()} records`}>
        <div className="toolbar">
          <input className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search account, name or phone…" aria-label="Search subscribers" />
          {canEdit && <button className="primary-button" onClick={() => setEditor('new')}>Add subscriber</button>}
        </div>
        <LoadState loading={loading} error={error} refresh={() => void refresh()}>
          <DataTable
            rows={data}
            fields={['accountNumber', 'firstName', 'lastName', 'contactNumber', 'collectionAreaName', 'status']}
            labels={{ accountNumber: 'Account no.', firstName: 'First name', lastName: 'Last name', contactNumber: 'Contact', collectionAreaName: 'Collection area' }}
            actions={(row) => (
              <>
                <button className="text-button" onClick={() => setDetail(row)}>View</button>
                {canEdit && <button className="text-button" onClick={() => setEditor(row)}>Edit</button>}
              </>
            )}
          />
        </LoadState>
      </Panel>
      {editor && (
        <Panel title={editor === 'new' ? 'New subscriber' : `Edit ${String(editor.accountNumber)}`} description="Changes are saved to the subscriber register.">
          <FormPanel
            key={editor === 'new' ? 'new' : String(editor.id)}
            schema={schema}
            fields={(editor === 'new' ? formFields.subscriber : formFields.subscriberEdit).map((field) =>
              field.name === 'collectionAreaId'
                ? { ...field, type: 'select' as const, options: optionRows(areas.data, 'id', (row) => `${row.areaCode} — ${row.areaName}`) }
                : field.name === 'status'
                  ? { ...field, type: 'select' as const, options: ['ACTIVE', 'INACTIVE'].map((value) => ({ value, label: value })) }
                : field)}
            defaults={defaults}
            submitLabel={editor === 'new' ? 'Create subscriber' : 'Save changes'}
            onSubmit={submit}
            onCancel={() => setEditor(null)}
          />
        </Panel>
      )}
      {detail && <SubscriberDetails row={detail} token={auth.token} onClose={() => setDetail(null)} />}
    </div>
  );
}

function SubscriberDetails({ row, token, onClose }: { row: Row; token: string; onClose: () => void }) {
  const [data, setData] = useState<Row | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void apiRequest<Row>(`/api/v1/subscribers/${row.id}`, token)
      .then((response) => {
        if (!response.success || !response.data) throw new Error(response.message ?? 'Unable to load subscriber.');
        setData(response.data);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to load subscriber.'));
  }, [row.id, token]);
  return (
    <Panel title="Subscriber details" description={String(row.accountNumber)} className="detail-panel">
      <button className="button button-quiet close-button" onClick={onClose}>Close</button>
      {error && <div className="notice error">{error}</div>}
      {!data && !error && <div className="loading-state"><span className="spinner" />Loading profile…</div>}
      {data && <>
        <dl className="detail-grid">
          {([
            ['Account number', data.accountNumber],
            ['Name', [data.firstName, data.middleName, data.lastName].filter(Boolean).join(' ')],
            ['Contact number', data.contactNumber],
            ['Email', data.email],
            ['Billing day', data.billingDay],
            ['Due day', data.dueDay],
            ['Status', data.status],
            ['Notes', data.notes],
          ] as const).map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{rowString(value)}</dd></div>
          ))}
        </dl>
        <h3>Addresses</h3>
        <DataTable rows={(data.addresses as Row[] | undefined) ?? []} fields={['addressType', 'addressLine', 'barangay', 'city', 'province', 'isPrimary']} labels={{ addressType: 'Type', addressLine: 'Address', isPrimary: 'Primary' }} />
        <h3>Additional contacts</h3>
        <DataTable rows={(data.contacts as Row[] | undefined) ?? []} fields={['contactType', 'contactValue', 'isPrimary']} labels={{ contactType: 'Type', contactValue: 'Contact', isPrimary: 'Primary' }} />
      </>}
    </Panel>
  );
}

function ServiceAccounts({ auth }: { auth: Auth }) {
  const { data, loading, error, refresh } = useResource<Row>('/api/v1/service-accounts', auth.token);
  const subscribers = useResource<Row>('/api/v1/subscribers', auth.token);
  const plans = useResource<Row>('/api/v1/service-plans', auth.token);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const canWrite = managerRoles.includes(auth.user.role);
  const defaults = {
    serviceAccountNumber: '',
    subscriberId: '',
    planId: '',
    billingStartDate: new Date().toISOString().slice(0, 10),
    billingDay: '1',
    dueDay: '15',
    currentRate: '0.00',
    status: 'ACTIVE' as const,
  };
  return (
    <div className="page-content">
      <SectionTitle title="Service accounts" detail="Manage active services and the subscriber plan and billing details." />
      <Panel title="Service account inventory" description={`${data.length.toLocaleString()} services`}>
        <div className="toolbar">
          <span className="muted">Search is available on the server route via service account list filters.</span>
          {canWrite && <button className="primary-button" onClick={() => setCreating((value) => !value)}>{creating ? 'Close form' : 'Add service account'}</button>}
        </div>
        <LoadState loading={loading} error={error} refresh={() => void refresh()}>
          <DataTable rows={data} fields={['serviceAccountNumber', 'subscriberAccountNumber', 'subscriberFirstName', 'subscriberLastName', 'planName', 'currentRate', 'status']} labels={{ serviceAccountNumber: 'Service no.', subscriberAccountNumber: 'Subscriber', subscriberFirstName: 'First name', subscriberLastName: 'Last name', planName: 'Plan', currentRate: 'Monthly rate' }} actions={canWrite ? (row) => <button className="text-button" onClick={() => setEditing(row)}>Edit</button> : undefined} />
        </LoadState>
      </Panel>
      {creating && canWrite && (
        <Panel title="Create service account" description="Choose a subscriber and service plan from the office register.">
          <FormPanel
            schema={schemas.serviceAccount}
            fields={formFields.serviceAccount.map((field) => field.name === 'subscriberId'
              ? { ...field, options: optionRows(subscribers.data, 'id', (row) => `${row.accountNumber} — ${row.firstName} ${row.lastName}`) }
              : field.name === 'planId'
                ? { ...field, type: 'select' as const, options: optionRows(plans.data, 'id', (row) => `${row.planCode} — ${row.planName}`) }
                : field)}
            defaults={defaults}
            submitLabel="Create service account"
            onSubmit={async (values) => {
              await mutate('/api/v1/service-accounts', auth.token, {
                ...values,
                subscriberId: asNumber(values.subscriberId),
                planId: asNumber(values.planId),
                billingDay: asNumber(values.billingDay),
                dueDay: asNumber(values.dueDay),
              });
              await refresh();
            }}
          />
        </Panel>
      )}
      {editing && canWrite && (
        <Panel title={`Edit service ${String(editing.serviceAccountNumber)}`} description="Update plan and billing details. Use the suspension workflow to change service suspension status.">
          <FormPanel
            key={String(editing.id)}
            schema={schemas.serviceAccountEdit}
            fields={formFields.serviceAccount.filter((field) => field.name !== 'status').map((field) => field.name === 'subscriberId'
              ? { ...field, options: optionRows(subscribers.data, 'id', (row) => `${row.accountNumber} — ${row.firstName} ${row.lastName}`) }
              : field.name === 'planId'
                ? { ...field, type: 'select' as const, options: optionRows(plans.data, 'id', (row) => `${row.planCode} — ${row.planName}`) }
                : field)}
            defaults={{
              serviceAccountNumber: String(editing.serviceAccountNumber ?? ''),
              subscriberId: String(editing.subscriberId ?? ''),
              planId: String(editing.planId ?? ''),
              billingStartDate: String(editing.billingStartDate ?? ''),
              billingDay: String(editing.billingDay ?? '1'),
              dueDay: String(editing.dueDay ?? '15'),
              currentRate: String(editing.currentRate ?? '0.00'),
            }}
            submitLabel="Save service account"
            onSubmit={async (values) => {
              await mutate(`/api/v1/service-accounts/${editing.id}`, auth.token, {
                ...values,
                subscriberId: asNumber(values.subscriberId),
                planId: asNumber(values.planId),
                billingDay: asNumber(values.billingDay),
                dueDay: asNumber(values.dueDay),
              }, 'PUT');
              setEditing(null);
              await refresh();
            }}
            onCancel={() => setEditing(null)}
          />
        </Panel>
      )}
    </div>
  );
}

function Billing({ auth }: { auth: Auth }) {
  const invoices = useResource<Row>('/api/v1/invoices', auth.token);
  const cycles = useResource<Row>('/api/v1/billing-cycles', auth.token);
  const [selectedCycle, setSelectedCycle] = useState('');
  const [notice, setNotice] = useState('');
  const canGenerate = billingRoles.includes(auth.user.role);
  return (
    <div className="page-content">
      <SectionTitle title="Billing & invoices" detail="Review invoice balances and create billing cycles or generate cycle invoices." />
      <Panel title="Billing cycles" description="Existing cycles are loaded from billing services.">
        <LoadState loading={cycles.loading} error={cycles.error} refresh={() => void cycles.refresh()}>
          <div className="table-actions">
            <DataTable rows={cycles.data} fields={['cycleCode', 'periodStart', 'periodEnd', 'dueDate', 'status']} />
            {canGenerate && <div className="inline-form">
              <select value={selectedCycle} onChange={(event) => setSelectedCycle(event.target.value)}>
                <option value="">Choose an open cycle to generate…</option>
                {cycles.data.filter((cycle) => cycle.status === 'OPEN').map((cycle) => (
                  <option value={String(cycle.id)} key={String(cycle.id)}>{String(cycle.cycleCode)} — due {String(cycle.dueDate)}</option>
                ))}
              </select>
              <button className="button" disabled={!selectedCycle} onClick={async () => {
                setNotice('');
                try {
                  await mutate('/api/v1/billing/generate', auth.token, { billingCycleId: Number(selectedCycle) });
                  setNotice('Invoices generated successfully.');
                  await invoices.refresh();
                } catch (cause) {
                  setNotice(cause instanceof Error ? cause.message : 'Invoice generation failed.');
                }
              }}>Generate invoices</button>
            </div>}
          </div>
          {canGenerate && <FormPanel
            schema={schemas.cycle}
            fields={formFields.cycle}
            defaults={{ cycleCode: '', periodStart: '', periodEnd: '', dueDate: '' }}
            submitLabel="Create billing cycle"
            onSubmit={async (values) => {
              await mutate('/api/v1/billing-cycles', auth.token, values);
              await cycles.refresh();
            }}
          />}
          {notice && <div className="notice info">{notice}</div>}
        </LoadState>
      </Panel>
      <Panel title="Invoice register" description={`${invoices.data.length.toLocaleString()} invoices`}>
        <LoadState loading={invoices.loading} error={invoices.error} refresh={() => void invoices.refresh()}>
          <DataTable rows={invoices.data} fields={['invoiceNumber', 'subscriberAccountNumber', 'serviceAccountNumber', 'invoiceDate', 'dueDate', 'totalAmount', 'amountPaid', 'balance', 'status']} labels={{ invoiceNumber: 'Invoice', subscriberAccountNumber: 'Subscriber', serviceAccountNumber: 'Service', invoiceDate: 'Issued', dueDate: 'Due', totalAmount: 'Total', amountPaid: 'Paid', balance: 'Balance' }} />
        </LoadState>
      </Panel>
    </div>
  );
}

function Payments({ auth }: { auth: Auth }) {
  const payments = useResource<Row>('/api/v1/payments', auth.token);
  const subscribers = useResource<Row>('/api/v1/subscribers', auth.token);
  const serviceAccounts = useResource<Row>('/api/v1/service-accounts', auth.token);
  const invoices = useResource<Row>('/api/v1/invoices', auth.token);
  const [selected, setSelected] = useState<Row | null>(null);
  const [notice, setNotice] = useState('');
  const [paymentDetails, setPaymentDetails] = useState<Row | null>(null);
  const [paymentAllocations, setPaymentAllocations] = useState<Row[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState('');
  const [allocatingOldest, setAllocatingOldest] = useState(false);
  const canWrite = paymentRoles.includes(auth.user.role);
  const canReverse = reversalRoles.includes(auth.user.role);
  const paymentDefaults = { subscriberId: '', amount: '', paymentMethod: 'Cash' as const, referenceNumber: '', notes: '' };
  const selectedId = selected ? String(selected.id) : '';
  const serviceIdsForSelectedSubscriber = new Set(serviceAccounts.data
    .filter((account) => String(account.subscriberId) === String(selected?.subscriberId))
    .map((account) => String(account.id)));
  const allowedInvoices = invoices.data.filter((invoice) =>
    serviceIdsForSelectedSubscriber.has(String(invoice.serviceAccountId))
    && ['UNPAID', 'PARTIALLY_PAID', 'OVERDUE'].includes(String(invoice.status)),
  );
  const loadPaymentDetails = useCallback(async () => {
    if (!selectedId) {
      setPaymentDetails(null);
      setPaymentAllocations([]);
      return;
    }
    setDetailsLoading(true);
    setDetailsError('');
    try {
      const [detailsResponse, allocationsResponse] = await Promise.all([
        apiRequest<Row>(`/api/v1/payments/${selectedId}`, auth.token),
        apiRequest<Row[]>(`/api/v1/payments/${selectedId}/allocations`, auth.token),
      ]);
      if (!detailsResponse.success || !detailsResponse.data) {
        throw new Error(detailsResponse.message ?? 'Unable to load payment details.');
      }
      if (!allocationsResponse.success) {
        throw new Error(allocationsResponse.message ?? 'Unable to load payment allocations.');
      }
      setPaymentDetails(detailsResponse.data);
      setPaymentAllocations(allocationsResponse.data ?? []);
      setSelected(detailsResponse.data);
    } catch (cause) {
      setDetailsError(cause instanceof Error ? cause.message : 'Unable to load payment details.');
    } finally {
      setDetailsLoading(false);
    }
  }, [auth.token, selectedId]);
  useEffect(() => { void loadPaymentDetails(); }, [loadPaymentDetails]);

  return (
    <div className="page-content">
      <SectionTitle title="Payment desk" detail="Record payments, allocate balances, verify digital references and preserve reversal history." />
      {canWrite && <Panel title="Record a payment" description="Cash, GCash and other supported methods are recorded through the payment API.">
        <FormPanel schema={schemas.payment} fields={formFields.payment.map((field) => field.name === 'subscriberId'
          ? { ...field, options: optionRows(subscribers.data, 'id', (row) => `${row.accountNumber} — ${row.firstName} ${row.lastName}`) }
          : field.name === 'paymentMethod'
            ? { ...field, options: ['Cash', 'GCash', 'Bank Transfer', 'Cheque', 'Other'].map((value) => ({ value, label: value })) }
            : field)} defaults={paymentDefaults} submitLabel="Record payment" onSubmit={async (values) => {
          await mutate('/api/v1/payments', auth.token, {
            ...values,
            subscriberId: asNumber(values.subscriberId),
            referenceNumber: values.referenceNumber || undefined,
            notes: values.notes || undefined,
          });
          await payments.refresh();
        }} />
      </Panel>}
      <Panel title="Payments" description="Select a payment to see permitted payment actions.">
        <LoadState loading={payments.loading} error={payments.error} refresh={() => void payments.refresh()}>
          <DataTable rows={payments.data} fields={['paymentNumber', 'subscriberAccountNumber', 'paymentDate', 'amount', 'paymentMethod', 'referenceNumber', 'status', 'unappliedAmount']} labels={{ paymentNumber: 'Payment', subscriberAccountNumber: 'Subscriber', paymentDate: 'Date', amount: 'Amount', paymentMethod: 'Method', referenceNumber: 'Reference', unappliedAmount: 'Unapplied' }} actions={(row) => <button className="text-button" onClick={() => { setSelected(row); setPaymentDetails(null); setPaymentAllocations([]); setNotice(''); }}>Manage</button>} />
        </LoadState>
      </Panel>
      {selected && <Panel title={`Payment ${String(selected.paymentNumber)}`} description={`Status ${String(selected.status)} · ${String(selected.paymentMethod)} · ${String(selected.amount)}`}>
        <div className="selected-toolbar">
          <p className="muted">Unapplied amount: <strong>{String(selected.unappliedAmount ?? '—')}</strong></p>
          <button className="button button-quiet" onClick={() => setSelected(null)}>Close</button>
        </div>
        {notice && <div className="notice info">{notice}</div>}
        <LoadState loading={detailsLoading} error={detailsError} refresh={() => void loadPaymentDetails()}>
          <Panel title="Allocation history" description="Invoices allocated to this payment.">
            <DataTable rows={paymentAllocations} fields={['invoiceNumber', 'dueDate', 'amount', 'invoiceStatus']} labels={{ invoiceNumber: 'Invoice', dueDate: 'Due date', amount: 'Allocated', invoiceStatus: 'Invoice status' }} />
          </Panel>
          <Panel title="GCash proof and reversal history" description="Supporting records are retained with the payment.">
            <DataTable rows={(paymentDetails?.proofs as Row[] | undefined) ?? []} fields={['referenceNumber', 'senderName', 'amount', 'filePath', 'status', 'createdAt']} labels={{ referenceNumber: 'Reference', senderName: 'Sender', amount: 'Proof amount', filePath: 'Proof path', createdAt: 'Submitted' }} />
            <DataTable rows={(paymentDetails?.reversals as Row[] | undefined) ?? []} fields={['reason', 'reversedAt']} labels={{ reason: 'Reversal reason', reversedAt: 'Reversed at' }} />
          </Panel>
        </LoadState>
        {canWrite && selected.status === 'POSTED' && <FormPanel
          schema={schemas.allocation}
          fields={formFields.allocation.map((field) => field.name === 'invoiceId'
            ? { ...field, options: optionRows(allowedInvoices, 'id', (row) => `${row.invoiceNumber} · due ${row.dueDate} · balance ${row.balance}`) }
            : field)}
          defaults={{ invoiceId: '', amount: '' }}
          submitLabel="Allocate payment"
          onSubmit={async (values) => {
            await mutate(`/api/v1/payments/${selectedId}/allocations`, auth.token, {
              invoiceId: asNumber(values.invoiceId),
              amount: values.amount,
            });
            await Promise.all([payments.refresh(), invoices.refresh(), loadPaymentDetails()]);
          }}
        />}
        {canWrite && selected.status === 'POSTED' && cents(selected.unappliedAmount) > 0n && <button
          className="button"
          disabled={allocatingOldest}
          onClick={async () => {
            setNotice('');
            setAllocatingOldest(true);
            try {
              await mutate(`/api/v1/payments/${selectedId}/allocate-oldest`, auth.token, {});
              setNotice('Payment allocated to the oldest outstanding invoices.');
              await Promise.all([payments.refresh(), invoices.refresh(), loadPaymentDetails()]);
            } catch (cause) {
              setNotice(cause instanceof Error ? cause.message : 'Oldest-first allocation failed.');
            } finally {
              setAllocatingOldest(false);
            }
          }}
        >{allocatingOldest ? 'Allocating…' : 'Allocate to oldest invoices first'}</button>}
        {canWrite && selected.paymentMethod === 'GCash' && selected.status === 'PENDING' && <>
          <FormPanel schema={schemas.proof} fields={formFields.proof} defaults={{ referenceNumber: String(selected.referenceNumber ?? ''), senderName: '', amount: String(selected.amount ?? ''), filePath: '' }} submitLabel="Attach GCash proof" onSubmit={async (values) => {
            await mutate(`/api/v1/payments/${selectedId}/proof`, auth.token, {
              ...values,
              senderName: values.senderName || undefined,
              amount: values.amount || undefined,
              filePath: values.filePath || undefined,
            });
            setNotice('Proof recorded. An authorized supervisor can verify the payment.');
            await loadPaymentDetails();
          }} />
          {reversalRoles.includes(auth.user.role) && <button className="button" onClick={async () => {
            try {
              await mutate(`/api/v1/payments/${selectedId}/verify`, auth.token, {});
              setNotice('Payment verified and posted.');
              await Promise.all([payments.refresh(), loadPaymentDetails()]);
            } catch (cause) {
              setNotice(cause instanceof Error ? cause.message : 'Verification failed.');
            }
          }}>Verify GCash payment</button>}
        </>}
        {canReverse && selected.status === 'POSTED' && <FormPanel schema={schemas.reversal} fields={formFields.reversal} defaults={{ reason: '' }} submitLabel="Reverse payment" onSubmit={async (values) => {
          await mutate(`/api/v1/payments/${selectedId}/reverse`, auth.token, values);
          setNotice('Payment reversed; original payment was retained.');
          await Promise.all([payments.refresh(), invoices.refresh(), loadPaymentDetails()]);
        }} />}
      </Panel>}
    </div>
  );
}

function Collections({ auth }: { auth: Auth }) {
  const batches = useResource<Row>('/api/v1/collection-batches', auth.token);
  const accounts = useResource<Row>('/api/v1/service-accounts', auth.token);
  const assignments = useResource<Row>('/api/v1/collection-assignments', auth.token);
  const remittances = useResource<Row>('/api/v1/collector-remittances', auth.token);
  const users = useResource<Row>('/api/v1/users', auth.token);
  const areas = useResource<Row>('/api/v1/collection-areas', auth.token);
  const [selected, setSelected] = useState<Row | null>(null);
  const [batchAccounts, setBatchAccounts] = useState<Row[]>([]);
  const [batchAccountError, setBatchAccountError] = useState('');
  const [batchAccountsLoading, setBatchAccountsLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const canManage = managerRoles.includes(auth.user.role);
  const canCollect = collectionWriteRoles.includes(auth.user.role);
  const loadBatchAccounts = async (id: string) => {
    setBatchAccountsLoading(true);
    setBatchAccountError('');
    try {
      const response = await apiRequest<Row[]>(`/api/v1/collection-batches/${id}/accounts`, auth.token);
      if (!response.success) throw new Error(response.message ?? 'Unable to load batch accounts.');
      setBatchAccounts(response.data ?? []);
    } catch (cause) {
      setBatchAccountError(cause instanceof Error ? cause.message : 'Unable to load batch accounts.');
    } finally {
      setBatchAccountsLoading(false);
    }
  };

  return (
    <div className="page-content">
      <SectionTitle title="Collections" detail="Manage collector assignments, field collection batches and cash remittance reconciliation." />
      {canManage && users.error && <div className="notice info">The user directory is restricted for this role. Enter the collector’s user ID directly in the assignment or batch form.</div>}
      {canManage && <Panel title="Collector assignment" description="Assign a collector to a collection area for a date range.">
        <FormPanel schema={schemas.assignment} fields={formFields.assignment.map((field) => field.name === 'collectorId' && users.data.length
          ? { ...field, type: 'select' as const, options: optionRows(users.data.filter((row) => row.status === 'ACTIVE'), 'id', (row) => `${row.fullName} (${row.username})`) }
          : field.name === 'collectionAreaId'
            ? { ...field, type: 'select' as const, options: optionRows(areas.data.filter((row) => row.status === 'ACTIVE'), 'id', (row) => `${row.areaCode} — ${row.areaName}`) }
            : field)} defaults={{ collectorId: '', collectionAreaId: '', assignedFrom: new Date().toISOString().slice(0, 10), assignedTo: '' }} submitLabel="Create assignment" onSubmit={async (values) => {
          await mutate('/api/v1/collection-assignments', auth.token, {
            ...values,
            collectorId: asNumber(values.collectorId),
            collectionAreaId: asNumber(values.collectionAreaId),
            assignedTo: values.assignedTo || null,
          });
          await assignments.refresh();
        }} />
        <DataTable rows={assignments.data} fields={['collectorName', 'areaName', 'assignedFrom', 'assignedTo', 'status']} labels={{ collectorName: 'Collector', areaName: 'Area', assignedFrom: 'Start', assignedTo: 'End' }} />
      </Panel>}
      {canManage && <Panel title="Create collection batch" description="Collector and area must have a valid active assignment.">
        <FormPanel schema={schemas.batch} fields={formFields.batch.map((field) => field.name === 'collectorId' && users.data.length
          ? { ...field, type: 'select' as const, options: optionRows(users.data.filter((row) => row.status === 'ACTIVE'), 'id', (row) => `${row.fullName} (${row.username})`) }
          : field.name === 'collectionAreaId'
            ? { ...field, type: 'select' as const, options: optionRows(areas.data.filter((row) => row.status === 'ACTIVE'), 'id', (row) => `${row.areaCode} — ${row.areaName}`) }
            : field)} defaults={{ batchNumber: '', collectorId: '', collectionAreaId: '', collectionDate: new Date().toISOString().slice(0, 10), notes: '' }} submitLabel="Create batch" onSubmit={async (values) => {
          await mutate('/api/v1/collection-batches', auth.token, {
            ...values,
            collectorId: asNumber(values.collectorId),
            collectionAreaId: asNumber(values.collectionAreaId),
          });
          await batches.refresh();
        }} />
      </Panel>}
      <Panel title="Collection batches" description="Open a batch to add accounts, record collections and reconcile remittance.">
        <LoadState loading={batches.loading} error={batches.error} refresh={() => void batches.refresh()}>
          <DataTable rows={batches.data} fields={['batchNumber', 'collectionDate', 'collectorName', 'areaName', 'expectedCash', 'expectedNonCash', 'status']} labels={{ batchNumber: 'Batch', collectionDate: 'Date', collectorName: 'Collector', areaName: 'Area', expectedCash: 'Expected cash', expectedNonCash: 'Non-cash' }} actions={(row) => <button className="text-button" onClick={() => { setSelected(row); setNotice(''); void loadBatchAccounts(String(row.id)); }}>Open</button>} />
        </LoadState>
      </Panel>
      {selected && <Panel title={`Batch ${String(selected.batchNumber)}`} description={`${String(selected.collectorName)} · ${String(selected.areaName)} · ${String(selected.status)}`}>
        <div className="selected-toolbar">
          <span>Expected cash <strong>{String(selected.expectedCash)}</strong> · Non-cash <strong>{String(selected.expectedNonCash)}</strong></span>
          <button className="button button-quiet" onClick={() => setSelected(null)}>Close</button>
        </div>
        <LoadState loading={batchAccountsLoading} error={batchAccountError} refresh={() => void loadBatchAccounts(String(selected.id))}>
          <DataTable rows={batchAccounts} fields={['serviceAccountNumber', 'subscriberAccountNumber', 'expectedAmount', 'collectedAmount', 'status']} labels={{ serviceAccountNumber: 'Service', subscriberAccountNumber: 'Subscriber', expectedAmount: 'Expected', collectedAmount: 'Collected' }} actions={canCollect && ['OPEN', 'IN_PROGRESS'].includes(String(selected.status)) ? (row) => (
            <button className="text-button" onClick={() => setSelected({ ...selected, activeBatchAccountId: row.id })}>Collect</button>
          ) : undefined} />
        </LoadState>
        {canManage && ['OPEN', 'IN_PROGRESS'].includes(String(selected.status)) && <FormPanel schema={schemas.batchAccount} fields={formFields.batchAccount.map((field) => field.name === 'serviceAccountId'
          ? { ...field, options: optionRows(accounts.data.filter((row) => row.status === 'ACTIVE'), 'id', (row) => `${row.serviceAccountNumber} · ${row.subscriberAccountNumber}`) }
          : field)} defaults={{ serviceAccountId: '', expectedAmount: '' }} submitLabel="Add account" onSubmit={async (values) => {
          await mutate(`/api/v1/collection-batches/${selected.id}/accounts`, auth.token, {
            serviceAccountId: asNumber(values.serviceAccountId),
            expectedAmount: values.expectedAmount,
          });
          await loadBatchAccounts(String(selected.id));
        }} />}
        {canCollect && ['OPEN', 'IN_PROGRESS'].includes(String(selected.status)) && Boolean(selected.activeBatchAccountId) && <FormPanel schema={schemas.collectionPayment} fields={formFields.collectionPayment.map((field) => field.name === 'paymentMethod'
          ? { ...field, options: ['Cash', 'GCash', 'Bank Transfer', 'Cheque', 'Other'].map((value) => ({ value, label: value })) }
          : field)} defaults={{ amount: '', paymentMethod: 'Cash', referenceNumber: '', notes: '' }} submitLabel="Record collection" onSubmit={async (values) => {
            await mutate(`/api/v1/collection-batches/${selected.id}/accounts/${String(selected.activeBatchAccountId)}/payments`, auth.token, values);
          await Promise.all([loadBatchAccounts(String(selected.id)), batches.refresh()]);
          setNotice('Collection payment recorded.');
        }} />}
        {canManage && ['OPEN', 'IN_PROGRESS'].includes(String(selected.status)) && <FormPanel schema={schemas.remittance} fields={formFields.remittance} defaults={{ remittedCash: '', shortageReason: '' }} submitLabel="Record cash remittance" onSubmit={async (values) => {
          await mutate('/api/v1/collector-remittances', auth.token, {
            batchId: Number(selected.id),
            remittedCash: values.remittedCash,
            shortageReason: values.shortageReason || undefined,
          });
          setNotice('Remittance recorded and reconciled against expected cash.');
          await Promise.all([batches.refresh(), remittances.refresh()]);
        }} />}
        {notice && <div className="notice info">{notice}</div>}
      </Panel>}
      <Panel title="Remittance reconciliation" description="Expected, remitted and variance amounts from posted collector remittances.">
        <LoadState loading={remittances.loading} error={remittances.error} refresh={() => void remittances.refresh()}>
          <DataTable rows={remittances.data} fields={['batchNumber', 'remittanceDate', 'expectedCash', 'remittedCash', 'difference', 'shortageReason', 'status']} labels={{ batchNumber: 'Batch', remittanceDate: 'Received', expectedCash: 'Expected cash', remittedCash: 'Remitted cash', difference: 'Variance', shortageReason: 'Shortage reason' }} />
        </LoadState>
      </Panel>
    </div>
  );
}

function Receivables({ auth }: { auth: Auth }) {
  const resource = useResource<Row>('/api/v1/receivables', auth.token);
  const suspensionRecords = useResource<Row>('/api/v1/suspensions', auth.token);
  const [selected, setSelected] = useState<Row | null>(null);
  const [notice, setNotice] = useState('');
  const [reconnections, setReconnections] = useState<Row[]>([]);
  const [reconnectionsLoading, setReconnectionsLoading] = useState(true);
  const [reconnectionsError, setReconnectionsError] = useState('');
  const [activeSuspension, setActiveSuspension] = useState<Row | null>(null);
  const [suspensionError, setSuspensionError] = useState('');
  const canManage = managerRoles.includes(auth.user.role);
  const today = new Date().toISOString().slice(0, 10);
  const selectedServiceAccountId = selected ? String(selected.serviceAccountId) : '';
  const loadActiveSuspension = useCallback(async () => {
    setSuspensionError('');
    if (!selectedServiceAccountId) {
      setActiveSuspension(null);
      return;
    }
    const response = await apiRequest<Row[]>(
      `/api/v1/suspensions?serviceAccountId=${selectedServiceAccountId}&status=ACTIVE`,
      auth.token,
    );
    if (!response.success) throw new Error(response.message ?? 'Unable to check suspension status.');
    setActiveSuspension(response.data?.[0] ?? null);
  }, [auth.token, selectedServiceAccountId]);
  const loadReconnections = useCallback(async () => {
    setReconnectionsLoading(true);
    setReconnectionsError('');
    try {
      const response = await apiRequest<Row[]>('/api/v1/reconnections', auth.token);
      if (!response.success) throw new Error(response.message ?? 'Unable to load reconnection records.');
      setReconnections(response.data ?? []);
    } catch (cause) {
      setReconnectionsError(cause instanceof Error ? cause.message : 'Unable to load reconnection records.');
    } finally {
      setReconnectionsLoading(false);
    }
  }, [auth.token]);
  useEffect(() => { void loadReconnections(); }, [loadReconnections]);
  useEffect(() => {
    void loadActiveSuspension().catch((cause: unknown) => {
      setActiveSuspension(null);
      setSuspensionError(cause instanceof Error ? cause.message : 'Unable to check suspension status.');
    });
  }, [loadActiveSuspension]);

  return (
    <div className="page-content">
      <SectionTitle title="Receivables & aging" detail="Outstanding balances are derived from valid posted invoice allocations. Aging is calculated from due dates." />
      {notice && <div className="notice info" role="status">{notice}</div>}
      <Panel title="Account receivables" description={`${resource.data.length} service accounts have outstanding balances.`}>
        <LoadState loading={resource.loading} error={resource.error} refresh={() => void resource.refresh()}>
          <DataTable rows={resource.data} fields={['subscriberAccountNumber', 'subscriberFirstName', 'subscriberLastName', 'serviceAccountNumber', 'outstandingBalance', 'overdueBalance']} labels={{ subscriberAccountNumber: 'Subscriber', subscriberFirstName: 'First name', subscriberLastName: 'Last name', serviceAccountNumber: 'Service account', outstandingBalance: 'Outstanding', overdueBalance: 'Overdue' }} actions={(row) => <button className="text-button" onClick={() => { setSelected(row); setNotice(''); }}>Review</button>} />
        </LoadState>
      </Panel>
      {selected && <Panel title={`Account ${String(selected.serviceAccountNumber)}`} description={`${String(selected.subscriberFirstName)} ${String(selected.subscriberLastName)} · outstanding ${String(selected.outstandingBalance)}`}>
        <div className="selected-toolbar"><strong>Aging breakdown</strong><button className="button button-quiet" onClick={() => setSelected(null)}>Close</button></div>
        <DataTable rows={[selected.aging as Row]} fields={['current', 'days1To30', 'days31To60', 'days61To90', 'over90Days']} labels={{ current: 'Current', days1To30: '1–30 days', days31To60: '31–60 days', days61To90: '61–90 days', over90Days: 'Over 90 days' }} />
        <DataTable rows={(selected.invoices as Row[] | undefined) ?? []} fields={['invoiceNumber', 'dueDate', 'totalAmount', 'amountPaid', 'balance', 'daysOverdue', 'agingBucket']} labels={{ invoiceNumber: 'Invoice', dueDate: 'Due', totalAmount: 'Total', amountPaid: 'Paid', balance: 'Balance', daysOverdue: 'Days overdue', agingBucket: 'Bucket' }} />
        {suspensionError && <div className="notice error" role="alert">{suspensionError}</div>}
        {canManage && cents(selected.overdueBalance) > 0n && !activeSuspension && <FormPanel schema={schemas.suspension} fields={formFields.suspension} defaults={{ suspensionDate: today, reason: 'Overdue balance', notes: '' }} submitLabel="Suspend service" onSubmit={async (values) => {
          await mutate('/api/v1/suspensions', auth.token, {
            serviceAccountId: Number(selected.serviceAccountId),
            ...values,
          });
          setNotice('Suspension recorded.');
          await Promise.all([resource.refresh(), suspensionRecords.refresh(), loadActiveSuspension()]);
        }} />}
        {canManage && activeSuspension && <FormPanel schema={schemas.reconnection} fields={formFields.reconnection} defaults={{ requestDate: today, completionDate: today, reconnectionFee: '0.00', notes: '' }} submitLabel="Complete reconnection" onSubmit={async (values) => {
          await mutate('/api/v1/reconnections', auth.token, {
            serviceAccountId: Number(selected.serviceAccountId),
            suspensionId: Number(activeSuspension.id),
            requestDate: values.requestDate,
            completionDate: values.completionDate || values.requestDate,
            reconnectionFee: values.reconnectionFee,
            status: 'COMPLETED',
            notes: values.notes,
          });
          setNotice('Reconnection completed.');
          setActiveSuspension(null);
          await Promise.all([resource.refresh(), suspensionRecords.refresh(), loadReconnections()]);
        }} />}
        {canManage && activeSuspension && <div className="notice info">This service currently has an active suspension ({String(activeSuspension.reason ?? 'No reason recorded')}).</div>}
      </Panel>}
      <Panel title="Reconnection activity" description="Service restoration records from the suspension workflow.">
        <LoadState loading={reconnectionsLoading} error={reconnectionsError} refresh={() => void loadReconnections()}>
          <DataTable rows={reconnections} fields={['serviceAccountNumber', 'requestDate', 'completionDate', 'reconnectionFee', 'status', 'notes']} labels={{ serviceAccountNumber: 'Service account', requestDate: 'Requested', completionDate: 'Completed', reconnectionFee: 'Fee' }} />
        </LoadState>
      </Panel>
      <Panel title="Suspension history" description="Auditable suspension records are retained after reconnection.">
        <LoadState loading={suspensionRecords.loading} error={suspensionRecords.error} refresh={() => void suspensionRecords.refresh()}>
          <DataTable rows={suspensionRecords.data} fields={['subscriberAccountNumber', 'serviceAccountNumber', 'suspensionDate', 'reason', 'approvedByName', 'status']} labels={{ subscriberAccountNumber: 'Subscriber', serviceAccountNumber: 'Service account', suspensionDate: 'Date', approvedByName: 'Recorded by' }} />
        </LoadState>
      </Panel>
    </div>
  );
}

function Receipts({ auth }: { auth: Auth }) {
  const receipts = useResource<Row>('/api/v1/receipts', auth.token);
  const payments = useResource<Row>('/api/v1/payments', auth.token);
  const canWrite = paymentRoles.includes(auth.user.role);
  return (
    <div className="page-content">
      <SectionTitle title="Receipts" detail="Issue receipt records for posted payments and review receipt history." />
      {canWrite && <Panel title="Issue receipt" description="Only posted payments can be receipted.">
        <FormPanel schema={schemas.receipt} fields={formFields.receipt.map((field) => field.name === 'paymentId'
          ? { ...field, options: optionRows(payments.data.filter((payment) => payment.status === 'POSTED'), 'id', (row) => `${row.paymentNumber} · ${row.subscriberAccountNumber} · ${row.amount}`) }
          : field)} defaults={{ paymentId: '', receiptNumber: '' }} submitLabel="Issue receipt" onSubmit={async (values) => {
          await mutate('/api/v1/receipts', auth.token, {
            paymentId: asNumber(values.paymentId),
            receiptNumber: values.receiptNumber || undefined,
          });
          await receipts.refresh();
        }} />
      </Panel>}
      <Panel title="Receipt register" description={`${receipts.data.length} receipt records`}>
        <LoadState loading={receipts.loading} error={receipts.error} refresh={() => void receipts.refresh()}>
          <DataTable rows={receipts.data} fields={['receiptNumber', 'paymentNumber', 'subscriberAccountNumber', 'paymentDate', 'paymentAmount', 'paymentMethod', 'status']} labels={{ receiptNumber: 'Receipt no.', paymentNumber: 'Payment', subscriberAccountNumber: 'Subscriber', paymentDate: 'Date', paymentAmount: 'Amount', paymentMethod: 'Method' }} />
        </LoadState>
      </Panel>
    </div>
  );
}

function Reports({ auth }: { auth: Auth }) {
  const ledger = useResource<Row>('/api/v1/ledger', auth.token);
  const receivables = useResource<Row>('/api/v1/receivables', auth.token);
  const payments = useResource<Row>('/api/v1/payments', auth.token);
  const loading = ledger.loading || receivables.loading || payments.loading;
  const error = ledger.error || receivables.error || payments.error;
  const refresh = () => { void Promise.all([ledger.refresh(), receivables.refresh(), payments.refresh()]); };
  const posted = payments.data.filter((payment) => payment.status === 'POSTED');
  const totalPayments = posted.reduce((sum, payment) => sum + cents(payment.amount), 0n);
  const totalReceivables = receivables.data.reduce((sum, account) => sum + cents(account.outstandingBalance), 0n);
  return (
    <div className="page-content">
      <SectionTitle title="Reports" detail="Live operational summaries from payment, receivable and ledger endpoints." />
      <LoadState loading={loading} error={error} refresh={refresh}>
        <div className="metric-grid two">
          <Metric label="Posted payment volume" value={moneyText(totalPayments)} note={`${posted.length} posted payments`} />
          <Metric label="Outstanding receivables" value={moneyText(totalReceivables)} note={`${receivables.data.length} service accounts`} />
        </div>
        <Panel title="Ledger activity" description="Read-only accounting entries.">
          <DataTable rows={ledger.data} fields={['entryDate', 'entryType', 'serviceAccountNumber', 'invoiceNumber', 'paymentNumber', 'debit', 'credit', 'referenceNumber']} labels={{ entryDate: 'Date', entryType: 'Entry', serviceAccountNumber: 'Service account', invoiceNumber: 'Invoice', paymentNumber: 'Payment', referenceNumber: 'Reference' }} />
        </Panel>
      </LoadState>
    </div>
  );
}

export default function Workspace({ page, auth }: { page: Page; auth: Auth }) {
  if (page === 'dashboard') return <Dashboard auth={auth} />;
  if (page === 'subscribers') return <Subscribers auth={auth} />;
  if (page === 'service-accounts') return <ServiceAccounts auth={auth} />;
  if (page === 'billing') return <Billing auth={auth} />;
  if (page === 'payments') return <Payments auth={auth} />;
  if (page === 'collections') return <Collections auth={auth} />;
  if (page === 'receivables') return <Receivables auth={auth} />;
  if (page === 'receipts') return <Receipts auth={auth} />;
  return <Reports auth={auth} />;
}
