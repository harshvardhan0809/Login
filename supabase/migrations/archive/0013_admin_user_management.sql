-- ===========================================================================
-- Admin management of users, results and exam attempts.
--
-- Why every write here is a function rather than a table policy:
--
--   INSERT/UPDATE/DELETE on results and users are revoked from `authenticated`
--   (migrations 0001 and 0007), and an admin IS `authenticated`. A policy can
--   never grant a privilege the role does not hold, so "results: admins
--   manage" has in fact been doing nothing. That revoke is what guarantees no
--   student can ever write their own score, and it is worth keeping exactly as
--   it is -- so admin writes go through SECURITY DEFINER functions that check
--   is_admin() themselves.
--
-- Every manual score change is recorded: who made it, when, and why. A mark a
-- teacher can silently overwrite is not a mark anyone should trust.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

-- --- audit trail on results ------------------------------------------------

alter table public.results
  add column if not exists adjusted_by text,
  add column if not exists adjusted_at timestamptz,
  add column if not exists adjustment_note text;

-- --- admins can see the whole roll -----------------------------------------

-- Added alongside 0001's "users: read own row" rather than replacing it.
-- Permissive SELECT policies are OR'd, so re-running 0001 cannot take this
-- away again.
drop policy if exists "users: read own or admin" on public.users;
create policy "users: read own or admin"
  on public.users for select to authenticated
  using (email = auth.jwt() ->> 'email' or public.is_admin());

-- --- guard -----------------------------------------------------------------

create or replace function public.require_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only a teacher can do this.' using errcode = '42501';
  end if;
end;
$$;

-- --- who is on the system --------------------------------------------------

-- One call for the whole directory. last_sign_in_at lives in auth.users, which
-- PostgREST will not expose, so it can only be reached from a definer function
-- like this one.
create or replace function public.admin_user_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
begin
  perform public.require_admin();

  select coalesce(jsonb_agg(row_to_json(d)::jsonb order by d.email), '[]'::jsonb)
    into v_rows
  from (
    select
      u.email,
      u.role,
      au.created_at            as joined_at,
      au.last_sign_in_at,
      coalesce(r.attempts, 0)  as attempts,
      r.average,
      coalesce(s.submissions, 0) as submissions
    from public.users u
    left join auth.users au on lower(au.email) = lower(u.email)
    left join (
      select email, count(*) as attempts, round(avg(percentage)) as average
      from public.results group by email
    ) r on lower(r.email) = lower(u.email)
    left join (
      select email, count(*) as submissions
      from public.assignment_submissions group by email
    ) s on lower(s.email) = lower(u.email)
  ) d;

  return v_rows;
end;
$$;

-- --- one student's full record ---------------------------------------------

create or replace function public.admin_user_records(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email));
begin
  perform public.require_admin();

  return jsonb_build_object(
    'results', coalesce((
      select jsonb_agg(jsonb_build_object(
        'test_id', r.test_id,
        'title', t.title,
        'subject', t.subject,
        'score', r.score,
        'total', r.total,
        'percentage', r.percentage,
        'attempted_at', r.attempted_at,
        'adjusted_by', r.adjusted_by,
        'adjusted_at', r.adjusted_at,
        'adjustment_note', r.adjustment_note
      ) order by r.attempted_at desc)
      from public.results r
      left join public.tests t on t.id = r.test_id
      where lower(r.email) = v_email
    ), '[]'::jsonb),

    -- An attempt with no matching result is someone who opened the paper and
    -- never submitted -- the exact case a teacher needs to find and reset.
    'attempts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'test_id', a.test_id,
        'title', t.title,
        'started_at', a.started_at,
        'submitted_at', a.submitted_at
      ) order by a.started_at desc)
      from public.exam_attempts a
      left join public.tests t on t.id = a.test_id
      where lower(a.email) = v_email
    ), '[]'::jsonb),

    'submissions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'assignment_id', s.assignment_id,
        'title', g.title,
        'link_url', s.link_url,
        'note', s.note,
        'submitted_at', s.submitted_at,
        'updated_at', s.updated_at
      ) order by s.updated_at desc)
      from public.assignment_submissions s
      left join public.assignments g on g.id = s.assignment_id
      where lower(s.email) = v_email
    ), '[]'::jsonb)
  );
end;
$$;

-- --- setting a mark by hand ------------------------------------------------

create or replace function public.admin_set_result(
  p_test_id uuid,
  p_email   text,
  p_score   numeric,
  p_total   numeric,
  p_note    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_pct   numeric;
begin
  perform public.require_admin();

  if v_email = '' then
    raise exception 'A student email address is required.';
  end if;
  if p_total is null or p_total <= 0 then
    raise exception 'Total marks must be greater than zero.';
  end if;
  if p_score is null or p_score < 0 or p_score > p_total then
    raise exception 'The score must be between 0 and the total.';
  end if;
  if not exists (select 1 from public.tests where id = p_test_id) then
    raise exception 'That test no longer exists.';
  end if;

  v_pct := round((p_score / p_total) * 100);

  insert into public.results (
    test_id, email, score, total, percentage, attempted_at, detail,
    adjusted_by, adjusted_at, adjustment_note
  )
  values (
    p_test_id, v_email, p_score, p_total, v_pct, now(), '[]'::jsonb,
    auth.jwt() ->> 'email', now(), nullif(btrim(coalesce(p_note, '')), '')
  )
  on conflict (test_id, email) do update set
    score           = excluded.score,
    total           = excluded.total,
    percentage      = excluded.percentage,
    adjusted_by     = excluded.adjusted_by,
    adjusted_at     = excluded.adjusted_at,
    adjustment_note = excluded.adjustment_note;
  -- attempted_at and detail are deliberately NOT overwritten. The per-question
  -- record is what the student actually answered, and question analysis should
  -- keep reflecting that even when a teacher overrides the total.

  return jsonb_build_object('email', v_email, 'score', p_score,
                            'total', p_total, 'percentage', v_pct);
end;
$$;

-- --- removing a mark -------------------------------------------------------

create or replace function public.admin_delete_result(p_test_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_admin();

  delete from public.results
  where test_id = p_test_id and lower(email) = lower(btrim(p_email));
end;
$$;

-- --- letting a student sit a test again ------------------------------------

-- The attempt row is what holds the clock, and the result row is what blocks a
-- second go. A machine that died mid-exam leaves both behind, and clearing
-- them is the only way back in -- so both go together.
create or replace function public.admin_reset_attempt(p_test_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email));
begin
  perform public.require_admin();

  delete from public.results where test_id = p_test_id and lower(email) = v_email;
  delete from public.exam_attempts where test_id = p_test_id and lower(email) = v_email;
end;
$$;

-- --- roles -----------------------------------------------------------------

-- NOTE: ADMIN_EMAILS in .env stays authoritative. `npm run admin:promote`
-- demotes anybody not listed there, so a promotion made here is undone by the
-- next sync unless .env is updated to match. The admin page says so too.
create or replace function public.admin_set_role(p_email text, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email));
begin
  perform public.require_admin();

  if p_role not in ('student', 'admin') then
    raise exception 'Role must be student or admin.';
  end if;

  -- Removing your own admin rights locks you out of this page with no way
  -- back short of the service-role script.
  if v_email = lower(auth.jwt() ->> 'email') and p_role <> 'admin' then
    raise exception 'You cannot remove your own teacher access.';
  end if;

  update public.users set role = p_role where lower(email) = v_email;

  if not found then
    raise exception 'No user with that address has signed up yet.';
  end if;
end;
$$;

-- --- clearing a student's records ------------------------------------------

-- Deletes what this portal holds. It cannot delete the login itself: that
-- lives in auth.users and needs the service role, so it is done from the
-- Supabase dashboard or `npm run user:purge`.
create or replace function public.admin_purge_user(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := lower(btrim(p_email));
  v_results integer;
  v_att     integer;
  v_subs    integer;
begin
  perform public.require_admin();

  if v_email = lower(auth.jwt() ->> 'email') then
    raise exception 'You cannot clear your own records from here.';
  end if;

  delete from public.results where lower(email) = v_email;
  get diagnostics v_results = row_count;

  delete from public.exam_attempts where lower(email) = v_email;
  get diagnostics v_att = row_count;

  delete from public.assignment_submissions where lower(email) = v_email;
  get diagnostics v_subs = row_count;

  return jsonb_build_object('results', v_results, 'attempts', v_att, 'submissions', v_subs);
end;
$$;

-- --- grants ----------------------------------------------------------------

-- Each function checks is_admin() itself, so `authenticated` is the right
-- grant: a student calling one gets a permission error from inside it.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.require_admin()',
    'public.admin_user_directory()',
    'public.admin_user_records(text)',
    'public.admin_set_result(uuid, text, numeric, numeric, text)',
    'public.admin_delete_result(uuid, text)',
    'public.admin_reset_attempt(uuid, text)',
    'public.admin_set_role(text, text)',
    'public.admin_purge_user(text)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;
