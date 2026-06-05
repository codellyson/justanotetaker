import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

// Better Auth core tables for SQLite/D1.
// These match the shape Better Auth's CLI would generate for a Drizzle
// adapter with provider: "sqlite" + plugins: [anonymous(), bearer()].
// If a Better Auth upgrade changes the expected schema, re-generate via:
//   pnpm --filter @justnotes/api auth:generate

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  // Added by the anonymous() plugin
  isAnonymous: integer("isAnonymous", { mode: "boolean" }),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
});

// ── justnotes domain tables ─────────────────────────────────────────────

// One row per note. user_id partitions the table for multi-tenant safety.
// `t` is the note's "moment" (recency/scrub axis). `updated_at` is the
// LWW sync key — server-assigned on every write. Soft delete via
// `deleted_at`; clients filter, server keeps until a future cleanup job.
export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    x: real("x").notNull(),
    y: real("y").notNull(),
    t: integer("t").notNull(),
    text: text("text").notNull().default(""),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => ({
    userUpdated: index("notes_user_updated").on(table.userId, table.updatedAt),
  }),
);

// One row per user. `tweaks` is a JSON-serialized Tweaks object — kept
// as TEXT to avoid migration pain when individual tweak fields evolve.
// `seeded` flags whether SEED has been written to this user's notes —
// flipped true on first successful seed so re-empty doesn't re-seed.
export const settings = sqliteTable("settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  tweaks: text("tweaks"),
  seeded: integer("seeded", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at").notNull(),
});

export const schema = { user, session, account, verification, notes, settings };
