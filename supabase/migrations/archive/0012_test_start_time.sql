-- ===========================================================================
-- Scheduling a test to open at a set time.
--
-- Until now publishing a test made it available immediately, so a teacher
-- preparing Friday's paper on Wednesday had to remember to press Publish at
-- the right moment. opens_at moves that decision into the schedule: publish
-- whenever you like, and the test unlocks itself.
--
-- Students can SEE a scheduled test before it opens -- that is the point, they
-- need to know it is coming -- but get_exam() refuses to hand out questions
-- until the moment arrives.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

alter table public.tests
  add column if not exists opens_at timestamptz;

-- A window that closes before it opens is always a mistake, and one that
-- would leave a test permanently unavailable with no obvious cause.
do $$
begin
  alter table public.tests add constraint tests_window_check
    check (opens_at is null or closes_at is null or opens_at < closes_at);
exception when duplicate_object then null;
end $$;

-- --- reading an exam, now window-aware -------------------------------------

create or replace function public.get_exam(p_test_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_admin   boolean := public.is_admin();
  t         public.tests%rowtype;
  v_started timestamptz;
  v_ends    timestamptz;
  v_test    jsonb;
begin
  if v_email is null then
    raise exception 'You must be signed in to open a test.';
  end if;

  select * into t from public.tests where id = p_test_id;
  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;

  v_test := jsonb_build_object(
    'id', t.id,
    'title', t.title,
    'subject', t.subject,
    'kind', t.kind,
    'duration_minutes', t.duration_minutes,
    'opens_at', t.opens_at,
    'closes_at', t.closes_at,
    'requires_seb', t.requires_seb
  );

  -- Drafts are invisible to students; an admin may preview one, and doing so
  -- must not start a clock or leave an attempt row behind.
  if t.status <> 'published' then
    if not v_admin then
      return jsonb_build_object('state', 'not_released', 'test', v_test);
    end if;
    return jsonb_build_object(
      'state', 'preview',
      'test', v_test,
      'server_time', now(),
      'questions', public.exam_questions(p_test_id)
    );
  end if;

  if exists (select 1 from public.results r
              where r.test_id = p_test_id and r.email = v_email) then
    return jsonb_build_object('state', 'already_attempted', 'test', v_test,
                              'already_attempted', true);
  end if;

  -- Checked before the deadline and before any attempt is created, so opening
  -- the page early cannot start a clock the student is not entitled to yet.
  if t.opens_at is not null and now() < t.opens_at then
    return jsonb_build_object('state', 'not_open_yet', 'test', v_test,
                              'opens_at', t.opens_at, 'server_time', now());
  end if;

  if t.closes_at is not null and now() > t.closes_at then
    return jsonb_build_object('state', 'closed', 'test', v_test);
  end if;

  -- A link test is taken elsewhere; hand back the address, nothing more.
  if t.kind = 'link' then
    return jsonb_build_object('state', 'external', 'test', v_test,
                              'form_url', t.form_url, 'server_time', now());
  end if;

  -- Starts the clock on first open. ON CONFLICT DO NOTHING is what makes a
  -- reload harmless: the original started_at survives.
  insert into public.exam_attempts (test_id, email)
  values (p_test_id, v_email)
  on conflict (test_id, email) do nothing;

  select started_at into v_started
  from public.exam_attempts
  where test_id = p_test_id and email = v_email;

  v_ends := public.exam_ends_at(v_started, t.duration_minutes, t.closes_at);

  if v_ends is not null and now() > v_ends then
    return jsonb_build_object('state', 'time_up', 'test', v_test);
  end if;

  return jsonb_build_object(
    'state', 'open',
    'test', v_test,
    'already_attempted', false,
    -- The browser's own clock is not trusted: it anchors its countdown to
    -- these two values and measures elapsed time from there.
    'server_time', now(),
    'started_at', v_started,
    'ends_at', v_ends,
    'questions', public.exam_questions(p_test_id)
  );
end;
$$;

revoke all on function public.get_exam(uuid) from public, anon;
grant execute on function public.get_exam(uuid) to authenticated;

-- --- grading, refusing anything from before the window ---------------------

-- Defence in depth, not the primary guard. get_exam() already returns
-- 'not_open_yet' before it reaches the insert, and migration 0008 revoked
-- INSERT on exam_attempts from anon and authenticated, so there is no route
-- here today. This keeps it that way if a future migration ever grants that
-- privilege back: the start time is then still enforced by the table itself.
create or replace function public.submit_exam_window_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_opens timestamptz;
begin
  select opens_at into v_opens from public.tests where id = new.test_id;

  if v_opens is not null and now() < v_opens then
    raise exception 'This test has not opened yet.';
  end if;

  return new;
end;
$$;

drop trigger if exists exam_attempts_window_guard on public.exam_attempts;
create trigger exam_attempts_window_guard
  before insert on public.exam_attempts
  for each row execute function public.submit_exam_window_guard();
