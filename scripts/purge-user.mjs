/**
 * Deletes a user's login and everything the portal holds about them.
 *
 *   npm run user:purge -- someone@example.com
 *   npm run user:purge -- someone@example.com --dry-run
 *   npm run user:purge -- someone@example.com --records-only
 *
 * The admin page can already clear a student's marks, attempts and hand-ins.
 * What it cannot do is delete the login itself: that lives in auth.users,
 * which only the service role may touch. This script is the bridge, and it is
 * deliberately a command rather than a button — deleting an account is not
 * something anyone should be one misclick away from.
 *
 * Nothing here reaches the browser: the variables it reads have no VITE_
 * prefix, so Vite never inlines them into the bundle.
 */
import { existsSync } from "node:fs";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

if (existsSync(".env")) process.loadEnvFile(".env");

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const recordsOnly = args.includes("--records-only");
const email = args
  .find(arg => !arg.startsWith("--"))
  ?.trim()
  .toLowerCase();

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!url) fail("Set VITE_SUPABASE_URL in .env");
if (!serviceKey) {
  fail(
    "Set SUPABASE_SERVICE_ROLE_KEY in .env\n" +
      "  Dashboard -> Project Settings -> API -> service_role.\n" +
      "  Do not add a VITE_ prefix: that would publish it to every visitor."
  );
}
if (!email) {
  fail("Which user?\n  npm run user:purge -- someone@example.com [--dry-run] [--records-only]");
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

/** Tables keyed by the student's email address, in dependency order. */
const TABLES = ["results", "exam_attempts", "assignment_submissions", "users"];

async function countRows(table) {
  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .ilike("email", email);

  // A table that does not exist yet simply has nothing to delete.
  if (error) return error.code === "PGRST205" ? null : fail(`${table}: ${error.message}`);
  return count ?? 0;
}

const { data: accounts, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
if (listError) fail(`Could not list accounts: ${listError.message}`);

const account = accounts.users.find(user => user.email?.toLowerCase() === email);

console.log(`\n  ${email}\n`);
console.log(`  login          ${account ? account.id : "no account found"}`);

let total = 0;
for (const table of TABLES) {
  const count = await countRows(table);
  if (count === null) {
    console.log(`  ${table.padEnd(22)} table not present`);
    continue;
  }
  total += count;
  console.log(`  ${table.padEnd(22)} ${count} row(s)`);
}

if (dryRun) {
  console.log(`\n  --dry-run: nothing was deleted. ${total} row(s) would go.\n`);
  process.exit(0);
}

if (!account && total === 0) {
  console.log("\n  Nothing to delete.\n");
  process.exit(0);
}

for (const table of TABLES) {
  const { error } = await supabase.from(table).delete().ilike("email", email);
  if (error && error.code !== "PGRST205") fail(`${table}: ${error.message}`);
}

if (!recordsOnly && account) {
  const { error } = await supabase.auth.admin.deleteUser(account.id);
  if (error) fail(`Could not delete the login: ${error.message}`);
  console.log("\n  Login deleted.");
} else if (recordsOnly) {
  console.log("\n  --records-only: the login was left in place.");
}

console.log(`  ${total} row(s) removed.\n`);
