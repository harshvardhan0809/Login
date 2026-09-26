-- ===========================================================================
-- 0018: deleting marks whose test has been deleted
--
-- Run after 0017. Safe to run more than once.
--
-- Deleting a test keeps its results (results.test_id is ON DELETE SET NULL,
-- from 0002) so a student's history is not silently rewritten. But the admin
-- page deleted a mark by (test_id, email), and `test_id = null` matches
-- nothing in SQL -- so a mark from a deleted test could never be removed, and
-- the page reported success anyway.
--
-- Marks are now deleted by their own id, and deleting one that is not there
-- is an error rather than a silent no-op.
-- ===========================================================================

create or replace function public.admin_delete_result_by_id(p_result_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_admin();

  -- result_details goes with it (on delete cascade, from 0016).
  delete from public.results where id = p_result_id;

  if not found then
    raise exception 'That mark no longer exists. Refresh the page.';
  end if;
end;
$$;

revoke all on function public.admin_delete_result_by_id(uuid) from public, anon;
grant execute on function public.admin_delete_result_by_id(uuid) to authenticated;

-- Unchanged from 0016 except that each result now carries its id, which the
-- page needs to delete it.
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
        'id', r.id,
        'test_id', r.test_id,
        'title', t.title,
        'subject', t.subject,
        'requires_seb', t.requires_seb,
        'score', r.score,
        'total', r.total,
        'percentage', r.percentage,
        'attempted_at', r.attempted_at,
        'via_seb', r.via_seb,
        'seb_api', r.seb_api,
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

revoke all on function public.admin_user_records(text) from public, anon;
grant execute on function public.admin_user_records(text) to authenticated;

notify pgrst, 'reload schema';
