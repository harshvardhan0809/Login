-- ===========================================================================
-- Safe Exam Browser support for tests.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

-- Defaults to true: every test is gated behind Safe Exam Browser unless an
-- admin deliberately turns it off for a particular test.
alter table public.tests
  add column if not exists requires_seb boolean not null default true;

-- Existing rows predate the column and would otherwise keep the old default.
update public.tests set requires_seb = true where requires_seb is null;

-- Public URL of the .seb configuration file students launch. SEB is opened by
-- pointing a seb:// link at this address.
alter table public.tests
  add column if not exists seb_config_url text;

-- The Browser Exam Key that SEB derives from that config file. Read it from
-- SEB Config Tool once the config is finalised.
--
-- IMPORTANT: storing it here makes it readable by any signed-in student,
-- because the tests table is world-readable to authenticated users. That is
-- acceptable only while the exam is a Google Form, where nothing verifies the
-- key anyway. Before you rely on the key for enforcement, move it out of this
-- table and into a server-side secret — see README "Enforcing SEB".
alter table public.tests
  add column if not exists seb_browser_exam_key text;

-- Only admins may change these; the existing "tests: admins manage" policy
-- already covers writes, and students keep read access for the launch link.
