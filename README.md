# Exam Portal

A student exam portal built on [Vite](https://vite.dev) and [Supabase](https://supabase.com).
Students sign in, take tests linked from Google Forms, and review their scores;
admins create tests and monitor results.

## Getting started

Requires Node.js 20.19+ (or 22.12+).

```bash
npm install
cp .env.example .env   # then fill in your Supabase values
npm run dev
```

The dev server runs at <http://localhost:5173>.

## Scripts

| Script                  | What it does                                         |
| ----------------------- | ---------------------------------------------------- |
| `npm run dev`           | Start the dev server with hot reloading              |
| `npm run build`         | Build the production bundle into `dist/`             |
| `npm run preview`       | Serve the built `dist/` locally                      |
| `npm run admin:promote` | Sync admin roles in the database from `ADMIN_EMAILS` |
| `npm run lint`          | Lint with ESLint                                     |
| `npm run lint:fix`      | Lint and auto-fix                                    |
| `npm run format`        | Format with Prettier                                 |
| `npm run format:check`  | Check formatting without writing                     |
| `npm run check`         | Lint + format check + build (use this before a PR)   |

## Configuration

Configuration lives in `.env`, which is git-ignored. Copy `.env.example` and
fill it in.

**The `VITE_` prefix is a security boundary.** Vite inlines every `VITE_*`
variable into the JavaScript bundle, so anything carrying that prefix is public
and readable in DevTools. Variables without it never leave your machine.

| Variable                    | Prefix  | Reaches the browser? | Used by                 |
| --------------------------- | ------- | -------------------- | ----------------------- |
| `VITE_SUPABASE_URL`         | `VITE_` | Yes — public         | The app                 |
| `VITE_SUPABASE_ANON_KEY`    | `VITE_` | Yes — public         | The app                 |
| `SUPABASE_SERVICE_ROLE_KEY` | none    | No                   | `npm run admin:promote` |
| `ADMIN_EMAILS`              | none    | No                   | `npm run admin:promote` |

The anon key is designed to be public, but it is only _safe_ once Row Level
Security is switched on — see below. The service role key bypasses RLS
entirely; treat it like a root password.

`npm run build` refuses to run if a variable like `VITE_..._SERVICE_ROLE_KEY`
exists, so a mis-prefixed secret fails the build instead of shipping.

Vite reads `.env` at startup, so restart the dev server after changing it.

## Project structure

```
index.html          Login             (entry: src/pages/login.js)
signup.html         Registration      (entry: src/pages/signup.js)
dashboard.html      Student dashboard (entry: src/pages/dashboard.js)
profile.html        Profile settings  (entry: src/pages/profile.js)
admin.html          Admin panel       (entry: src/pages/admin.js)

src/lib/supabase.js   Configured Supabase client + avatar upload
src/lib/session.js    Auth guards (requireUser / requireAdmin), sign-out
src/lib/ui.js         DOM builder, toasts, busy buttons, list rendering
src/lib/snow.js       Decorative canvas snowfall
src/styles/style.css  Single stylesheet for every page
public/               Copied to the build root as-is (favicon)

supabase/migrations/  SQL that enforces roles and row-level security
scripts/              Maintenance scripts run with npm (never bundled)
```

Each HTML file is a separate Vite entry point, so a page only downloads the
JavaScript it actually uses. Shared code is split into a common chunk
automatically, and third-party code into `vendor`.

## Database

| Table                              | Columns used by the app                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `users`                            | `email`, `role` (`student` \| `admin`)                                                                                    |
| `tests`                            | `id`, `title`, `subject`, `kind`, `status`, `form_url`, `duration_minutes`, `closes_at`, `requires_seb`, `seb_config_url` |
| `questions`                        | `test_id`, `prompt`, `type`, `options`, `answer_key`, `points`, `position` — **admin-only, never read by a student**      |
| `results`                          | `test_id` → `tests.id`, `email`, `score`, `total`, `percentage`, `attempted_at`                                           |
| `exam_attempts`                    | `test_id`, `email`, `started_at`, `submitted_at` — the server-held exam clock                                             |
| `test_secrets`                     | `test_id`, `quit_password` — admin-only                                                                                   |
| `videos`, `notices`, `assignments` | content shown on the student dashboard                                                                                    |

Storage buckets: `avatars` for profile pictures, `seb-configs` for generated
lockdown files.

Run the migrations in `supabase/migrations/` in numerical order, once each, in
the Supabase SQL Editor. All are idempotent. `0008_exam_delivery.sql` is the
one that adds drafts, deadlines and time limits — without it the admin page
cannot publish a test.

### Running a test

A test is a **draft** until you publish it, so questions are always finished
before anyone can open the paper. On the admin page's **Tests** tab:

1. **Create Draft.** Choose where the questions live — written here and
   auto-graded, or an existing Google Form. Set the maximum time and the
   deadline if you want them.
2. **Questions.** Build the paper. (Skipped for a Google Form.)
3. **Publish.** This is the point students first see the test. Publishing also
   generates the Safe Exam Browser config, hosts it, and mints a quit password,
   which the card then shows you.

**Maximum time** is minutes from the moment a student opens the test;
**deadline** is a wall-clock moment after which nobody can start or submit.
Both are enforced in `get_exam()` and `submit_exam()` against the database
clock, so reloading the page, editing it, or changing the computer's clock
buys no extra time. When the countdown reaches zero the page submits what the
student has answered so far.

Changing a published test's settings rebuilds its lockdown config
automatically. If you move the portal to a different address, press **Refresh
lockdown** on each test while viewing it from the new address — a config that
still points at the old one blocks the exam from inside SEB, which looks to a
student like a failed login.

### Maths questions

Questions, options and the saved-question list all understand LaTeX. Write a
formula between dollar signs and it is typeset wherever it appears:

```
What is the value of $x$ when $x^2 - 5x + 6 = 0$?
```

`$$ ... $$` centres a formula on its own line; `\( ... \)` and `\[ ... \]`
work too, which is what you usually get from pasting out of a textbook or
Word's equation editor. A literal dollar sign is `\$`.

The question builder has a symbol palette — fractions, roots, sums, integrals,
π, ±, ≤, matrices — which inserts into whichever box you were last typing in,
and puts the cursor inside the bracket you need to fill. Under each box a
**Looks like** strip shows the typeset result as soon as the text contains a
formula, so nothing is saved that you have not seen rendered. Boxes with no
maths in them never show the strip.

What is stored is the LaTeX source, so a question stays editable and no data
depends on how it was typeset. A half-finished formula renders the broken part
in red rather than blanking the question.

One exception: the **Correct answer** box for short-answer questions is matched
as plain text against what the student types, so it is not typeset. Keep those
answers typeable — `x^2` or `3.14`, not `$x^{2}$`.

Typesetting is [KaTeX](https://katex.org), bundled rather than loaded from a
CDN — the lockdown browser's URL filter would block an external CDN, and an
exam should not depend on someone else's uptime. It is split into its own
chunk, so only the admin and exam pages download it.

### Results and analysis

The **Results** tab links to a full analysis page (`results.html`), one test at
a time:

- **Headline numbers** — attempts, average, median, pass rate, highest,
  lowest, and the spread. The spread is the one people skip and shouldn't: a
  class averaging 60% because everyone scored 60 needs very different teaching
  from one that split between 20 and 100.
- **Score distribution** in ten-point bands, coloured either side of the pass
  mark so a struggling cohort is visible as a shape.
- **Question analysis** — percentage correct per question, a difficulty band,
  how many left it blank, and _the wrong answer that caught the most
  students_. That last one is the point: it tells you which misconception to
  reteach, not just that the question was hard.
- **Per-student table** with a tick or cross for every question, and a CSV
  export.

This runs on `results.detail`, a per-question record written by `submit_exam()`
at grading time (migration 0009). Attempts submitted before that migration have
no detail, so they still count toward scores and distribution but not toward
question analysis — the page says so rather than showing a misleading zero.

### Notice board

Notices carry a **category** (General, Academic, Exam, Event, Holiday), a
**priority** (Normal, Important, Urgent) and an author, which is stamped from
the signed-in session by a trigger rather than trusted from the browser.

The board sorts urgent first, then pinned, then newest, and priority shows as a
coloured rule down the left edge of each card — the one cue that survives being
skim-read. Sorting lives in `src/lib/noticeBoard.js`, shared by the student
board and the admin list, so a teacher composing a notice sees exactly what the
class will see.

### Handing in assignments

Tick **"Students hand in a link to their work"** when creating an assignment
and it grows a Submit button on the student dashboard. Students paste a Google
Docs, Drive or any other URL; teachers get the list under the assignment, with
each hand-in's address, how long ago it arrived, and a **Late** badge when it
came in after the due date.

Nothing is uploaded to this portal — the work stays where the student made it.
That is what most classes already do informally; this just records it.

The owner of a submission is stamped by a database trigger from the signed-in
session, so a student editing the request cannot hand in as somebody else, and
replacing a link keeps the original `submitted_at` so lateness cannot be
laundered by resubmitting.

**The due date locks the hand-in.** A student may replace their link as often
as they like until the deadline; after it, they cannot submit, change or
withdraw anything. Teachers are unaffected — and extending an assignment's due
date reopens it, which is how you grant an extension.

"Due 12 September" means the student has all of the 12th, so the cut-off is
midnight at the end of it. Which midnight depends on a timezone, and there is
exactly one place that decides: `public.school_timezone()` in migration 0011,
set to `Asia/Kolkata`. **Change it if your students are somewhere else** — the
browser works the deadline out in its own local timezone, so a mismatch makes
the page and the database disagree about whether an assignment is still open.
When they do disagree the database wins, and the page says so plainly rather
than showing a row-level-security error.

Requires `0010_assignment_submissions.sql` and
`0011_lock_submissions_at_deadline.sql`.

### Scheduled tests take priority

A test with a deadline is the only time-critical thing in the portal, so it is
promoted out of the Tests tab into a banner above the tabs on the student
dashboard, with a live countdown. A student who opened the site to read a
notice cannot miss an exam closing in twenty minutes.

Only one banner ever shows — two competing "urgent" strips would teach students
to ignore both. The soonest deadline wins; an undated test is surfaced only
when nothing is scheduled. The Tests tab sorts the same way, so the two never
disagree about what matters most.

### What the lockdown config does

`src/lib/seb.js` generates a standard exam configuration: full-screen kiosk
window with no address bar, no reload, no back/forward, no new windows or
downloads, no spell check, dictionary or clipboard, no screen sharing or second
display, no app switching, virtual machines refused, and the usual escape
shortcuts (Alt+Tab, Alt+F4, Esc, F1–F12, PrintScreen, right-click) disabled.
Remote-desktop and screen-recording applications are listed as prohibited
processes. Only this portal, the Supabase API — and, for a Google Form, the
Google hosts it needs — are allowed through the URL filter.

Quitting is password-protected, so a student cannot leave mid-exam. The quit
password is stored in `test_secrets`, readable only by admins; it is on the
test's card for an invigilator who needs to release a stuck machine. The one
exception is the config's `quitURL`: the exam page navigates there five
seconds after a submission, which closes Safe Exam Browser without a prompt.
Those five seconds are shown as a counting-down ring rather than simply waited
out — a locked-down browser that closes itself with no warning reads as a
crash, which is the wrong thing to feel just after finishing an exam.

### Security setup (required)

Roles and permissions are enforced by the database, not the browser. Two steps,
both one-time:

**1. Apply the migration.** Open `supabase/migrations/0001_harden_security.sql`,
paste it into the Supabase SQL Editor and run it (or `supabase db push`). It is
idempotent. This:

- adds an `on_auth_user_created` trigger that writes each new user's role row
  as `student`, so the browser never chooses its own role;
- revokes `insert`/`update`/`delete` on `users` from the public roles;
- enables RLS on `users`, `tests` and `results` — students read only their own
  results, only admins write tests;
- restricts avatar uploads to a folder named after the uploader's own user id.

**2. Name your admins.** Put them in `.env` and apply:

```bash
ADMIN_EMAILS=you@example.com,colleague@example.com
npm run admin:promote
```

**Editing `.env` alone does nothing.** The browser never reads `ADMIN_EMAILS`;
it is an input to the script above, which writes the roles into the database.
The database is what the app checks. So every change to that line needs
`npm run admin:promote` to take effect — preview it with `--dry-run` first:

```bash
npm run admin:promote -- --dry-run
```

`ADMIN_EMAILS` is authoritative in both directions:

- an address you **add** is granted the admin role;
- an address you **remove** is demoted back to `student` on the next run.

So revoking access is just deleting the address and re-running the sync. The
script only promotes addresses that have already signed up, and reports only
what actually changes:

```
unchanged      you@example.com
would demote   ex-admin@example.com — not listed in ADMIN_EMAILS
```

`npm run dev` checks for drift on start-up and warns if `.env` and the database
disagree, so a forgotten sync is hard to miss:

```
  ADMIN_EMAILS does not match the database.
    still admin, not in .env:  ex-admin@example.com
    Apply with: npm run admin:promote
```

It only warns — it never writes. Starting a dev server should not silently
change who has access to live data, and a stale `.env` on an old branch would
otherwise demote a real admin without anyone noticing.

Emptying `ADMIN_EMAILS` means "revoke every admin", but that is also what a
`.env` that failed to load looks like — so it needs to be explicit:

```bash
npm run admin:promote -- --allow-empty
```

Revocation takes effect immediately at the database level: the RLS policies
call `is_admin()` on every query, so a demoted user's writes are refused even
if their browser session is still open. They are redirected off `admin.html`
on their next page load.

If something looks wrong, `npm run db:doctor` writes nothing and reports which
steps have actually landed:

```
Environment (.env)
  ok    SUPABASE_SERVICE_ROLE_KEY carries role "service_role"
  ok    ADMIN_EMAILS -> you@example.com
Database
  ok    migration applied — public.is_admin() exists
  warn  in ADMIN_EMAILS but not admin yet: you@example.com
Next step
  npm run admin:promote
```

Why this variable has no `VITE_` prefix: an admin list shipped to the browser
would be readable by everyone and — more importantly — a client-side check is
not a permission. `requireAdmin()` in `src/lib/session.js` only decides what UI
to render; the RLS policies are what actually stop a non-admin from writing.
Both need to be in place.

## Deploying

`npm run build` produces a fully static `dist/`, deployable to Netlify, Vercel,
GitHub Pages, or any static host. Set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` in the host's build environment — `.env` is not
committed.
