export const managerRoles = ['OWNER', 'ADMINISTRATOR', 'COLLECTION_SUPERVISOR'];
export const collectionWriteRoles = [...managerRoles, 'CASHIER'];
export const billingRoles = ['OWNER', 'ADMINISTRATOR'];
export const paymentRoles = ['OWNER', 'ADMINISTRATOR', 'CASHIER'];
export const reversalRoles = ['OWNER', 'ADMINISTRATOR'];
export const auditRoles = ['OWNER', 'ADMINISTRATOR', 'ACCOUNTING_AUDITOR'];
export const ledgerViewRoles = [
  'OWNER',
  'ADMINISTRATOR',
  'ACCOUNTING_AUDITOR',
  'COLLECTION_SUPERVISOR',
  'VIEWER',
  'READ_ONLY_VIEWER',
  'READ_ONLY',
];
