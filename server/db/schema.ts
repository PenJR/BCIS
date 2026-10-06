import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  boolean,
  date,
  timestamp,
  numeric,
  unique,
  index,
} from "drizzle-orm/pg-core";

/* =========================================================
   SECURITY
   ========================================================= */

export const roles = pgTable("roles", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 50 }).notNull().unique(),
  description: text("description"),
});

export const permissions = pgTable("permissions", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 100 }).notNull().unique(),
  description: text("description"),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: serial("id").primaryKey(),
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: integer("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (table) => ({
    rolePermissionUnique: unique().on(table.roleId, table.permissionId),
  }),
);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 50 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  fullName: varchar("full_name", { length: 150 }).notNull(),
  email: varchar("email", { length: 150 }),
  status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const userRoles = pgTable(
  "user_roles",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (table) => ({
    userRoleUnique: unique().on(table.userId, table.roleId),
  }),
);

/* =========================================================
   COLLECTION AREAS
   ========================================================= */

export const collectionAreas = pgTable("collection_areas", {
  id: serial("id").primaryKey(),
  areaCode: varchar("area_code", { length: 30 }).notNull().unique(),
  areaName: varchar("area_name", { length: 100 }).notNull(),
  description: text("description"),
  status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
});

/* =========================================================
   SUBSCRIBERS
   ========================================================= */

export const subscribers = pgTable(
  "subscribers",
  {
    id: serial("id").primaryKey(),

    accountNumber: varchar("account_number", { length: 30 })
      .notNull()
      .unique(),

    firstName: varchar("first_name", { length: 80 }).notNull(),
    middleName: varchar("middle_name", { length: 80 }),
    lastName: varchar("last_name", { length: 80 }).notNull(),

    contactNumber: varchar("contact_number", { length: 30 }),
    email: varchar("email", { length: 150 }),

    collectionAreaId: integer("collection_area_id").references(
      () => collectionAreas.id,
    ),

    assignedCollectorId: integer("assigned_collector_id").references(
      () => users.id,
    ),

    billingDay: integer("billing_day").notNull().default(1),
    dueDay: integer("due_day").notNull().default(15),

    status: varchar("status", { length: 30 })
      .notNull()
      .default("ACTIVE"),

    notes: text("notes"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    accountIndex: index("subscribers_account_idx").on(table.accountNumber),
    nameIndex: index("subscribers_name_idx").on(
      table.lastName,
      table.firstName,
    ),
    contactIndex: index("subscribers_contact_idx").on(
      table.contactNumber,
    ),
  }),
);

export const subscriberAddresses = pgTable("subscriber_addresses", {
  id: serial("id").primaryKey(),

  subscriberId: integer("subscriber_id")
    .notNull()
    .references(() => subscribers.id),

  addressType: varchar("address_type", { length: 30 })
    .notNull()
    .default("SERVICE"),

  addressLine: varchar("address_line", { length: 255 }).notNull(),
  barangay: varchar("barangay", { length: 100 }),
  city: varchar("city", { length: 100 }),
  province: varchar("province", { length: 100 }),

  isPrimary: boolean("is_primary").notNull().default(false),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const subscriberContacts = pgTable("subscriber_contacts", {
  id: serial("id").primaryKey(),

  subscriberId: integer("subscriber_id")
    .notNull()
    .references(() => subscribers.id),

  contactType: varchar("contact_type", { length: 30 }).notNull(),
  contactValue: varchar("contact_value", { length: 150 }).notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
});

/* =========================================================
   SERVICES / PLANS
   ========================================================= */

export const serviceTypes = pgTable("service_types", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 50 }).notNull().unique(),
  description: text("description"),
});

export const servicePlans = pgTable(
  "service_plans",
  {
    id: serial("id").primaryKey(),

    serviceTypeId: integer("service_type_id")
      .notNull()
      .references(() => serviceTypes.id),

    planCode: varchar("plan_code", { length: 50 }).notNull().unique(),
    planName: varchar("plan_name", { length: 100 }).notNull(),

    price: numeric("price", {
      precision: 12,
      scale: 2,
    }).notNull(),

    installationFee: numeric("installation_fee", {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default("0"),

    reconnectionFee: numeric("reconnection_fee", {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default("0"),

    speedMbps: integer("speed_mbps"),
    channelCount: integer("channel_count"),

    description: text("description"),

    status: varchar("status", { length: 20 })
      .notNull()
      .default("ACTIVE"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    planCodeIndex: index("service_plans_code_idx").on(table.planCode),
  }),
);

export const serviceAccounts = pgTable(
  "service_accounts",
  {
    id: serial("id").primaryKey(),

    serviceAccountNumber: varchar("service_account_number", {
      length: 30,
    })
      .notNull()
      .unique(),

    subscriberId: integer("subscriber_id")
      .notNull()
      .references(() => subscribers.id),

    planId: integer("plan_id")
      .notNull()
      .references(() => servicePlans.id),

    installationAddressId: integer("installation_address_id").references(
      () => subscriberAddresses.id,
    ),

    activationDate: date("activation_date"),
    billingStartDate: date("billing_start_date").notNull(),

    billingDay: integer("billing_day").notNull(),
    dueDay: integer("due_day").notNull(),

    currentRate: numeric("current_rate", {
      precision: 12,
      scale: 2,
    }).notNull(),

    assignedCollectorId: integer("assigned_collector_id").references(
      () => users.id,
    ),

    status: varchar("status", { length: 30 })
      .notNull()
      .default("ACTIVE"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    subscriberIndex: index("service_accounts_subscriber_idx").on(
      table.subscriberId,
    ),
    statusIndex: index("service_accounts_status_idx").on(
      table.status,
    ),
  }),
);

export const serviceEvents = pgTable("service_events", {
  id: serial("id").primaryKey(),

  serviceAccountId: integer("service_account_id")
    .notNull()
    .references(() => serviceAccounts.id),

  eventType: varchar("event_type", { length: 50 }).notNull(),

  eventDate: timestamp("event_date").defaultNow().notNull(),

  description: text("description"),

  actorId: integer("actor_id").references(() => users.id),
});

/* =========================================================
   BILLING
   ========================================================= */

export const billingCycles = pgTable(
  "billing_cycles",
  {
    id: serial("id").primaryKey(),

    cycleCode: varchar("cycle_code", { length: 30 })
      .notNull()
      .unique(),

    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),

    dueDate: date("due_date").notNull(),

    status: varchar("status", { length: 20 })
      .notNull()
      .default("OPEN"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    periodIndex: index("billing_cycles_period_idx").on(
      table.periodStart,
      table.periodEnd,
    ),
  }),
);

export const invoices = pgTable(
  "invoices",
  {
    id: serial("id").primaryKey(),

    invoiceNumber: varchar("invoice_number", { length: 40 })
      .notNull()
      .unique(),

    serviceAccountId: integer("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id),

    billingCycleId: integer("billing_cycle_id")
      .notNull()
      .references(() => billingCycles.id),

    invoiceDate: date("invoice_date").notNull(),
    dueDate: date("due_date").notNull(),

    subtotal: numeric("subtotal", {
      precision: 12,
      scale: 2,
    }).notNull(),

    discountAmount: numeric("discount_amount", {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default("0"),

    penaltyAmount: numeric("penalty_amount", {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default("0"),

    totalAmount: numeric("total_amount", {
      precision: 12,
      scale: 2,
    }).notNull(),

    status: varchar("status", { length: 30 })
      .notNull()
      .default("UNPAID"),

    finalizedAt: timestamp("finalized_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    duplicateBilling: unique().on(
      table.serviceAccountId,
      table.billingCycleId,
    ),

    dueDateIndex: index("invoices_due_date_idx").on(
      table.dueDate,
    ),

    statusIndex: index("invoices_status_idx").on(
      table.status,
    ),
  }),
);

export const invoiceItems = pgTable("invoice_items", {
  id: serial("id").primaryKey(),

  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => invoices.id),

  itemType: varchar("item_type", { length: 50 }).notNull(),

  description: varchar("description", { length: 255 }).notNull(),

  quantity: numeric("quantity", {
    precision: 10,
    scale: 2,
  })
    .notNull()
    .default("1"),

  unitPrice: numeric("unit_price", {
    precision: 12,
    scale: 2,
  }).notNull(),

  amount: numeric("amount", {
    precision: 12,
    scale: 2,
  }).notNull(),
});

export const invoiceAdjustments = pgTable("invoice_adjustments", {
  id: serial("id").primaryKey(),

  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => invoices.id),

  adjustmentType: varchar("adjustment_type", { length: 30 }).notNull(),

  amount: numeric("amount", {
    precision: 12,
    scale: 2,
  }).notNull(),

  reason: text("reason").notNull(),

  createdBy: integer("created_by")
    .notNull()
    .references(() => users.id),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* =========================================================
   LEDGER
   ========================================================= */

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: serial("id").primaryKey(),

    serviceAccountId: integer("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id),

    invoiceId: integer("invoice_id").references(() => invoices.id),

    paymentId: integer("payment_id"),

    entryDate: timestamp("entry_date").defaultNow().notNull(),

    entryType: varchar("entry_type", { length: 30 }).notNull(),

    description: varchar("description", { length: 255 }).notNull(),

    debit: numeric("debit", {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default("0"),

    credit: numeric("credit", {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default("0"),

    referenceNumber: varchar("reference_number", {
      length: 50,
    }),
  },
  (table) => ({
    serviceAccountIndex: index(
      "ledger_service_account_idx",
    ).on(table.serviceAccountId),

    entryDateIndex: index("ledger_entry_date_idx").on(
      table.entryDate,
    ),
  }),
);

/* =========================================================
   PAYMENTS
   ========================================================= */

export const payments = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),

    paymentNumber: varchar("payment_number", {
      length: 40,
    })
      .notNull()
      .unique(),

    subscriberId: integer("subscriber_id")
      .notNull()
      .references(() => subscribers.id),

    paymentDate: timestamp("payment_date").defaultNow().notNull(),

    amount: numeric("amount", {
      precision: 12,
      scale: 2,
    }).notNull(),

    paymentMethod: varchar("payment_method", {
      length: 30,
    }).notNull(),

    referenceNumber: varchar("reference_number", {
      length: 100,
    }),

    notes: text("notes"),

    status: varchar("status", { length: 30 })
      .notNull()
      .default("POSTED"),

    receivedBy: integer("received_by")
      .notNull()
      .references(() => users.id),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    paymentDateIndex: index("payments_date_idx").on(
      table.paymentDate,
    ),

    referenceIndex: index("payments_reference_idx").on(
      table.referenceNumber,
    ),
  }),
);

export const paymentAllocations = pgTable("payment_allocations", {
  id: serial("id").primaryKey(),

  paymentId: integer("payment_id")
    .notNull()
    .references(() => payments.id),

  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => invoices.id),

  amount: numeric("amount", {
    precision: 12,
    scale: 2,
  }).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const paymentProofs = pgTable("payment_proofs", {
  id: serial("id").primaryKey(),

  paymentId: integer("payment_id")
    .notNull()
    .references(() => payments.id),

  referenceNumber: varchar("reference_number", {
    length: 100,
  }),

  senderName: varchar("sender_name", { length: 150 }),

  amount: numeric("amount", {
    precision: 12,
    scale: 2,
  }),

  filePath: varchar("file_path", { length: 500 }),

  status: varchar("status", { length: 30 })
    .notNull()
    .default("PENDING"),

  verifiedBy: integer("verified_by").references(() => users.id),

  verifiedAt: timestamp("verified_at"),

  rejectionReason: text("rejection_reason"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const paymentReversals = pgTable("payment_reversals", {
  id: serial("id").primaryKey(),

  paymentId: integer("payment_id")
    .notNull()
    .references(() => payments.id),

  reason: text("reason").notNull(),

  reversedBy: integer("reversed_by")
    .notNull()
    .references(() => users.id),

  reversedAt: timestamp("reversed_at").defaultNow().notNull(),
});

/* =========================================================
   RECEIPTS
   ========================================================= */

export const receipts = pgTable(
  "receipts",
  {
    id: serial("id").primaryKey(),

    receiptNumber: varchar("receipt_number", {
      length: 40,
    })
      .notNull()
      .unique(),

    paymentId: integer("payment_id")
      .notNull()
      .references(() => payments.id),

    issuedAt: timestamp("issued_at").defaultNow().notNull(),

    status: varchar("status", { length: 20 })
      .notNull()
      .default("ACTIVE"),

    voidReason: text("void_reason"),

    voidedBy: integer("voided_by").references(() => users.id),

    voidedAt: timestamp("voided_at"),
  },
  (table) => ({
    receiptNumberIndex: index("receipts_number_idx").on(
      table.receiptNumber,
    ),
  }),
);

/* =========================================================
   COLLECTIONS
   ========================================================= */

export const collectorAssignments = pgTable("collector_assignments", {
  id: serial("id").primaryKey(),

  collectorId: integer("collector_id")
    .notNull()
    .references(() => users.id),

  collectionAreaId: integer("collection_area_id")
    .notNull()
    .references(() => collectionAreas.id),

  assignedFrom: date("assigned_from").notNull(),
  assignedTo: date("assigned_to"),

  status: varchar("status", { length: 20 })
    .notNull()
    .default("ACTIVE"),
});

export const collectionBatches = pgTable(
  "collection_batches",
  {
    id: serial("id").primaryKey(),

    batchNumber: varchar("batch_number", {
      length: 40,
    })
      .notNull()
      .unique(),

    collectorId: integer("collector_id")
      .notNull()
      .references(() => users.id),

    collectionAreaId: integer("collection_area_id")
      .notNull()
      .references(() => collectionAreas.id),

    collectionDate: date("collection_date").notNull(),

    status: varchar("status", { length: 30 })
      .notNull()
      .default("OPEN"),

    expectedCash: numeric("expected_cash", {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default("0"),

    expectedNonCash: numeric("expected_non_cash", {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default("0"),

    notes: text("notes"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    collectorIndex: index(
      "collection_batches_collector_idx",
    ).on(table.collectorId),

    areaIndex: index(
      "collection_batches_area_idx",
    ).on(table.collectionAreaId),
  }),
);

export const batchAccounts = pgTable("batch_accounts", {
  id: serial("id").primaryKey(),

  batchId: integer("batch_id")
    .notNull()
    .references(() => collectionBatches.id),

  serviceAccountId: integer("service_account_id")
    .notNull()
    .references(() => serviceAccounts.id),

  expectedAmount: numeric("expected_amount", {
    precision: 12,
    scale: 2,
  }).notNull(),

  collectedAmount: numeric("collected_amount", {
    precision: 12,
    scale: 2,
  })
    .notNull()
    .default("0"),

  status: varchar("status", { length: 30 })
    .notNull()
    .default("UNPAID"),
});

export const collectorRemittances = pgTable(
  "collector_remittances",
  {
    id: serial("id").primaryKey(),

    batchId: integer("batch_id")
      .notNull()
      .references(() => collectionBatches.id),

    remittanceDate: timestamp("remittance_date")
      .defaultNow()
      .notNull(),

    expectedCash: numeric("expected_cash", {
      precision: 12,
      scale: 2,
    }).notNull(),

    remittedCash: numeric("remitted_cash", {
      precision: 12,
      scale: 2,
    }).notNull(),

    difference: numeric("difference", {
      precision: 12,
      scale: 2,
    }).notNull(),

    shortageReason: text("shortage_reason"),

    receivedBy: integer("received_by")
      .notNull()
      .references(() => users.id),

    status: varchar("status", { length: 30 })
      .notNull()
      .default("PENDING"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
);

/* =========================================================
   SUSPENSION / RECONNECTION
   ========================================================= */

export const suspensionRecords = pgTable("suspension_records", {
  id: serial("id").primaryKey(),

  serviceAccountId: integer("service_account_id")
    .notNull()
    .references(() => serviceAccounts.id),

  suspensionDate: date("suspension_date").notNull(),

  reason: text("reason").notNull(),

  approvedBy: integer("approved_by").references(() => users.id),

  notes: text("notes"),

  status: varchar("status", { length: 30 })
    .notNull()
    .default("ACTIVE"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const reconnectionRecords = pgTable("reconnection_records", {
  id: serial("id").primaryKey(),

  serviceAccountId: integer("service_account_id")
    .notNull()
    .references(() => serviceAccounts.id),

  suspensionId: integer("suspension_id").references(
    () => suspensionRecords.id,
  ),

  requestDate: date("request_date").notNull(),

  completionDate: date("completion_date"),

  reconnectionFee: numeric("reconnection_fee", {
    precision: 12,
    scale: 2,
  })
    .notNull()
    .default("0"),

  requestedBy: integer("requested_by").references(() => users.id),

  technicianId: integer("technician_id").references(
    () => users.id,
  ),

  status: varchar("status", { length: 30 })
    .notNull()
    .default("REQUESTED"),

  notes: text("notes"),
});

/* =========================================================
   SYSTEM / AUDIT
   ========================================================= */

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),

    userId: integer("user_id").references(() => users.id),

    action: varchar("action", { length: 100 }).notNull(),

    entityType: varchar("entity_type", {
      length: 100,
    }).notNull(),

    entityId: integer("entity_id"),

    reason: text("reason"),

    oldValues: text("old_values"),
    newValues: text("new_values"),

    ipAddress: varchar("ip_address", { length: 50 }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    userIndex: index("audit_logs_user_idx").on(
      table.userId,
    ),

    entityIndex: index("audit_logs_entity_idx").on(
      table.entityType,
      table.entityId,
    ),

    dateIndex: index("audit_logs_date_idx").on(
      table.createdAt,
    ),
  }),
);

export const applicationSettings = pgTable("application_settings", {
  id: serial("id").primaryKey(),

  settingKey: varchar("setting_key", {
    length: 100,
  })
    .notNull()
    .unique(),

  settingValue: text("setting_value"),

  description: text("description"),

  updatedBy: integer("updated_by").references(() => users.id),

  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const backupHistory = pgTable("backup_history", {
  id: serial("id").primaryKey(),

  backupFile: varchar("backup_file", {
    length: 500,
  }).notNull(),

  backupDate: timestamp("backup_date")
    .defaultNow()
    .notNull(),

  createdBy: integer("created_by").references(() => users.id),

  status: varchar("status", { length: 30 })
    .notNull()
    .default("SUCCESS"),

  verified: boolean("verified").notNull().default(false),

  notes: text("notes"),
});