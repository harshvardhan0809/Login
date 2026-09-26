-- ===========================================================================
-- Built-in exams: questions, server-side grading, instant results.
--
-- Replaces the Google Form link. Two things matter here:
--
--   1. Students never receive the correct answers. The questions table is
--      admin-only; students read the exam through get_exam(), which omits the
--      answer key.
--   2. Students never write their own score. submit_exam() grades on the
--      server and writes the result itself; direct inserts into results are
--      revoked, so a student cannot POST themselves 100%.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

-- A test is now built in the portal, so the external link is optional.
alter table public.tests alter column form_url drop not null;

-- --- questions ------------------------------------------------------------

create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests (id) on delete cascade,
  position integer not null default 0,
  prompt text not null,
  -- single: one correct option. multiple: several. text: free text answer.
  type text not null default 'single' check (type in ('single', 'multiple', 'text')),
  options jsonb not null default '[]'::jsonb,
  answer_key jsonb not null default '[]'::jsonb,
  points numeric not null default 1 check (points > 0),
  created_at timestamptz not null default now()
);

create index if not exists questions_test_idx on public.questions (test_id, position);

alter table public.questions enable row level security;

-- Admins only. Students must never select this table: it holds the answers.
drop policy if exists "questions: admins manage" on public.questions;
create policy "questions: admins manage"
  on public.questions for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --- one attempt per student per test --------------------------------------

delete from public.results a
using public.results b
where a.ctid < b.ctid and a.test_id = b.test_id and a.email = b.email;

create unique index if not exists results_test_email_idx
  on public.results (test_id, email);

-- Scores are written by submit_exam() alone.
--
-- Both lines matter. Dropping the policy is not enough on its own: re-running
-- an older migration could recreate it. Revoking the privilege is stronger,
-- because a policy can never grant access the role does not hold. submit_exam
-- is SECURITY DEFINER, so it still writes as the table owner.
drop policy if exists "results: insert own" on public.results;
revoke insert, update, delete on public.results from anon, authenticated;

-- --- reading an exam -------------------------------------------------------

create or replace function public.get_exam(p_test_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'test', (
      select jsonb_build_object('id', t.id, 'title', t.title, 'subject', t.subject)
      from public.tests t where t.id = p_test_id
    ),
    'already_attempted', exists (
      select 1 from public.results r
      where r.test_id = p_test_id and r.email = auth.jwt() ->> 'email'
    ),
    -- answer_key is deliberately absent from this projection.
    'questions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', q.id,
          'position', q.position,
          'prompt', q.prompt,
          'type', q.type,
          'options', q.options,
          'points', q.points
        ) order by q.position, q.created_at
      )
      from public.questions q where q.test_id = p_test_id
    ), '[]'::jsonb)
  );
$$;

-- --- grading ---------------------------------------------------------------

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
  q          record;
  v_given    jsonb;
  v_expected text[];
  v_actual   text[];
begin
  if v_email is null then
    raise exception 'You must be signed in to submit a test.';
  end if;

  if exists (
    select 1 from public.results
    where test_id = p_test_id and email = v_email
  ) then
    raise exception 'You have already submitted this test.';
  end if;

  for q in
    select * from public.questions where test_id = p_test_id
  loop
    v_total := v_total + q.points;
    v_given := p_answers -> q.id::text;

    -- Unanswered scores zero rather than erroring.
    if v_given is null or v_given = 'null'::jsonb then
      continue;
    end if;

    if q.type = 'text' then
      if jsonb_typeof(v_given) = 'string' and exists (
        select 1
        from jsonb_array_elements_text(q.answer_key) k
        where lower(btrim(k)) = lower(btrim(v_given #>> '{}'))
      ) then
        v_score := v_score + q.points;
      end if;
    else
      if jsonb_typeof(v_given) = 'array' then
        select array(select jsonb_array_elements_text(q.answer_key) order by 1)
          into v_expected;
        select array(select distinct jsonb_array_elements_text(v_given) order by 1)
          into v_actual;

        -- Exact set match: partial credit would need a per-option rule.
        if v_expected = v_actual then
          v_score := v_score + q.points;
        end if;
      end if;
    end if;
  end loop;

  if v_total = 0 then
    raise exception 'This test has no questions yet.';
  end if;

  v_pct := round((v_score / v_total) * 100);

  insert into public.results (test_id, email, score, total, percentage, attempted_at)
  values (p_test_id, v_email, v_score, v_total, v_pct, now());

  return jsonb_build_object('score', v_score, 'total', v_total, 'percentage', v_pct);
end;
$$;

revoke all on function public.get_exam(uuid) from public, anon;
revoke all on function public.submit_exam(uuid, jsonb) from public, anon;
grant execute on function public.get_exam(uuid) to authenticated;
grant execute on function public.submit_exam(uuid, jsonb) to authenticated;
