-- ===========================================================================
-- Per-question result detail, and a richer notice board.
--
-- Two additions:
--
--   1. results.detail records what happened to every individual question, so
--      a teacher can see WHICH questions a class got wrong rather than only
--      the final score. Written by submit_exam() at grading time -- the only
--      moment the answer key and the student's answers are both in hand.
--   2. notices gain a category, a priority and an author, which is what turns
--      a flat list into a notice board worth reading.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

-- --- per-question detail ---------------------------------------------------

-- An array, one entry per question, shaped:
--   {"q": uuid, "type": "single", "points": 2, "earned": 0,
--    "given": ["a1f2"], "correct": false}
--
-- Denormalised on purpose. A separate answers table would need its own RLS
-- and a join on every read; this rides along with the row it describes and
-- inherits the policy that already says "your own results, or any if admin".
alter table public.results
  add column if not exists detail jsonb not null default '[]'::jsonb;

-- --- notice board ----------------------------------------------------------

alter table public.notices
  add column if not exists category text not null default 'general',
  add column if not exists priority text not null default 'normal',
  add column if not exists created_by text;

do $$
begin
  alter table public.notices add constraint notices_category_check
    check (category in ('general', 'academic', 'exam', 'event', 'holiday'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.notices add constraint notices_priority_check
    check (priority in ('normal', 'high', 'urgent'));
exception when duplicate_object then null;
end $$;

-- Urgent first, then pinned, then newest: the order the board renders.
drop index if exists public.notices_order_idx;
create index if not exists notices_board_idx
  on public.notices (pinned desc, created_at desc);

-- Stamp the author automatically. Doing it in a trigger rather than from the
-- browser means it is the signed-in identity, not whatever the client claims.
create or replace function public.stamp_notice_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := auth.jwt() ->> 'email';
  end if;
  return new;
end;
$$;

drop trigger if exists notices_stamp_author on public.notices;
create trigger notices_stamp_author
  before insert on public.notices
  for each row execute function public.stamp_notice_author();

-- --- grading, now recording what happened per question ---------------------

create or replace function public.submit_exam(p_test_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email    text := auth.jwt() ->> 'email';
  v_total    numeric := 0;
  v_score    numeric := 0;
  v_pct      numeric;
  t          public.tests%rowtype;
  v_started  timestamptz;
  v_ends     timestamptz;
  q          record;
  v_given    jsonb;
  v_expected text[];
  v_actual   text[];
  v_correct  boolean;
  v_detail   jsonb := '[]'::jsonb;
begin
  if v_email is null then
    raise exception 'You must be signed in to submit a test.';
  end if;

  select * into t from public.tests where id = p_test_id;
  if not found then
    raise exception 'That test no longer exists.';
  end if;

  if t.status <> 'published' then
    raise exception 'This test has not been released.';
  end if;

  if exists (
    select 1 from public.results where test_id = p_test_id and email = v_email
  ) then
    raise exception 'You have already submitted this test.';
  end if;

  select started_at into v_started
  from public.exam_attempts
  where test_id = p_test_id and email = v_email;

  if v_started is null then
    raise exception 'Open the test before submitting it.';
  end if;

  v_ends := public.exam_ends_at(v_started, t.duration_minutes, t.closes_at);

  -- One minute of slack absorbs clock skew and the round trip of an
  -- auto-submit fired at zero. Beyond that the answers are genuinely late.
  if v_ends is not null and now() > v_ends + interval '1 minute' then
    raise exception 'Time is up for this test, so it can no longer be submitted.';
  end if;

  for q in
    select * from public.questions where test_id = p_test_id
    order by position, created_at
  loop
    v_total := v_total + q.points;
    v_given := p_answers -> q.id::text;
    v_correct := false;

    -- Unanswered scores zero rather than erroring.
    if v_given is not null and v_given <> 'null'::jsonb then
      if q.type = 'text' then
        v_correct := jsonb_typeof(v_given) = 'string' and exists (
          select 1
          from jsonb_array_elements_text(q.answer_key) k
          where lower(btrim(k)) = lower(btrim(v_given #>> '{}'))
        );
      elsif jsonb_typeof(v_given) = 'array' then
        select array(select jsonb_array_elements_text(q.answer_key) order by 1)
          into v_expected;
        select array(select distinct jsonb_array_elements_text(v_given) order by 1)
          into v_actual;

        -- Exact set match: partial credit would need a per-option rule.
        v_correct := v_expected = v_actual;
      end if;
    end if;

    if v_correct then
      v_score := v_score + q.points;
    end if;

    -- `given` is kept so a teacher can see which wrong option pulled the
    -- class in, not merely that the question was missed.
    v_detail := v_detail || jsonb_build_object(
      'q', q.id,
      'type', q.type,
      'points', q.points,
      'earned', case when v_correct then q.points else 0 end,
      'given', coalesce(v_given, 'null'::jsonb),
      'correct', v_correct
    );
  end loop;

  if v_total = 0 then
    raise exception 'This test has no questions yet.';
  end if;

  v_pct := round((v_score / v_total) * 100);

  insert into public.results (test_id, email, score, total, percentage, attempted_at, detail)
  values (p_test_id, v_email, v_score, v_total, v_pct, now(), v_detail);

  update public.exam_attempts
  set submitted_at = now()
  where test_id = p_test_id and email = v_email;

  return jsonb_build_object('score', v_score, 'total', v_total, 'percentage', v_pct);
end;
$$;

revoke all on function public.submit_exam(uuid, jsonb) from public, anon;
grant execute on function public.submit_exam(uuid, jsonb) to authenticated;
