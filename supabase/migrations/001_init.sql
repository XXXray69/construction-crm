-- Run in Supabase SQL Editor as a database administrator.
create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('manager', 'worker'))
);
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  address text not null default '',
  created_at timestamptz not null default now()
);
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  description text not null default '',
  assignee_id uuid not null references public.profiles(id),
  created_by uuid not null references public.profiles(id),
  status text not null default 'new' check (status in ('new','in_progress','review','accepted','revision')),
  created_at timestamptz not null default now()
);
create table public.task_history (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.tasks(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),
  from_status text not null,
  to_status text not null,
  comment text,
  changed_at timestamptz not null default now()
);
create index tasks_assignee_idx on public.tasks(assignee_id);
create index tasks_project_idx on public.tasks(project_id);
create index history_task_idx on public.task_history(task_id, changed_at);

create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'manager');
$$;
create or replace function public.is_worker() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'worker');
$$;

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_history enable row level security;

create policy profiles_read on public.profiles for select to authenticated
using (id = (select auth.uid()) or (select public.is_manager()));
-- Profiles are provisioned by an administrator only. No client write policies.
create policy projects_read on public.projects for select to authenticated
using ((select public.is_manager()) or exists (
 select 1 from public.tasks t where t.project_id = projects.id and t.assignee_id = (select auth.uid())
));
create policy projects_insert on public.projects for insert to authenticated
with check ((select public.is_manager()));
create policy projects_update on public.projects for update to authenticated
using ((select public.is_manager())) with check ((select public.is_manager()));
create policy projects_delete on public.projects for delete to authenticated
using ((select public.is_manager()));
create policy tasks_read on public.tasks for select to authenticated
using ((select public.is_manager()) or assignee_id = (select auth.uid()));
create policy tasks_insert on public.tasks for insert to authenticated
with check ((select public.is_manager()) and created_by = (select auth.uid()) and status = 'new');
create policy tasks_update on public.tasks for update to authenticated
using ((select public.is_manager()) or assignee_id = (select auth.uid()))
with check ((select public.is_manager()) or assignee_id = (select auth.uid()));
create policy tasks_delete on public.tasks for delete to authenticated
using ((select public.is_manager()));
create policy history_read on public.task_history for select to authenticated
using ((select public.is_manager()) or exists (
 select 1 from public.tasks t where t.id = task_history.task_id and t.assignee_id = (select auth.uid())
));

-- Prevent a client from ever editing history or profiles. Trigger-generated audit only.
revoke all on public.profiles, public.projects, public.tasks, public.task_history from anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.projects, public.tasks to authenticated;
grant select on public.task_history to authenticated;

create or replace function public.guard_task_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  manager boolean;
  permitted boolean := false;
  comment_text text;
begin
  manager := public.is_manager();
  if actor is null then raise exception 'Authentication required'; end if;
  if tg_op = 'INSERT' then
    if not manager or new.created_by is distinct from actor or new.status <> 'new' then
      raise exception 'Only a manager can create a new task';
    end if;
    if not exists (select 1 from public.profiles p where p.id = new.assignee_id and p.role = 'worker') then
      raise exception 'Assignee must be a worker';
    end if;
    return new;
  end if;
  if not manager then
    if old.assignee_id is distinct from actor or not public.is_worker() then
      raise exception 'Not your task';
    end if;
    if (new.id, new.project_id, new.title, new.description, new.assignee_id,
        new.created_by, new.created_at) is distinct from
       (old.id, old.project_id, old.title, old.description, old.assignee_id,
        old.created_by, old.created_at) then
      raise exception 'Workers can only change task status';
    end if;
  else
    if new.id is distinct from old.id or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'Immutable task fields';
    end if;
    if not exists (select 1 from public.profiles p where p.id = new.assignee_id and p.role = 'worker') then
      raise exception 'Assignee must be a worker';
    end if;
  end if;
  if new.status is distinct from old.status then
    permitted :=
      (not manager and old.status = 'new' and new.status = 'in_progress') or
      (not manager and old.status = 'in_progress' and new.status = 'review') or
      (not manager and old.status = 'revision' and new.status = 'in_progress') or
      (manager and old.status = 'review' and new.status = 'accepted') or
      (manager and old.status = 'review' and new.status = 'revision');
    if not permitted then raise exception 'Forbidden status transition: % -> %', old.status, new.status; end if;
    comment_text := nullif(btrim(current_setting('app.task_comment', true)), '');
    if new.status = 'revision' and (
      comment_text is null or current_setting('app.task_id', true) is distinct from old.id::text
    ) then
      raise exception 'A comment is required for revision; use change_task_status()';
    end if;
  end if;
  return new;
end;
$$;
create trigger tasks_guard before insert or update on public.tasks
for each row execute function public.guard_task_write();

create or replace function public.record_task_history() returns trigger
language plpgsql security definer set search_path = '' as $$
declare note text;
begin
  if new.status is distinct from old.status then
    note := case when current_setting('app.task_id', true) = old.id::text
      then nullif(btrim(current_setting('app.task_comment', true)), '') else null end;
    insert into public.task_history(task_id, actor_id, from_status, to_status, comment)
    values(old.id, auth.uid(), old.status, new.status, note);
  end if;
  return null;
end;
$$;
create trigger tasks_history after update on public.tasks
for each row execute function public.record_task_history();

create or replace function public.change_task_status(p_task_id uuid, p_to_status text, p_comment text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare current_task public.tasks%rowtype;
begin
  select * into current_task from public.tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found'; end if;
  if not (public.is_manager() or (public.is_worker() and current_task.assignee_id = auth.uid())) then
    raise exception 'Access denied';
  end if;
  if p_to_status = 'revision' and nullif(btrim(coalesce(p_comment,'')), '') is null then
    raise exception 'Revision comment is required';
  end if;
  perform set_config('app.task_id', p_task_id::text, true);
  perform set_config('app.task_comment', coalesce(p_comment, ''), true);
  update public.tasks set status = p_to_status where id = p_task_id;
end;
$$;
revoke all on function public.change_task_status(uuid,text,text) from public, anon;
grant execute on function public.change_task_status(uuid,text,text) to authenticated;
revoke all on function public.is_manager(), public.is_worker() from anon;
grant execute on function public.is_manager(), public.is_worker() to authenticated;

-- IMPORTANT: In Supabase Authentication > Providers > Email, turn OFF 'Allow new users to sign up'.
-- Create users in Authentication > Users > Add user, then insert profiles as admin:
-- insert into public.profiles(id, full_name, role) values
-- ('<manager-auth-uuid>', 'Руководитель', 'manager'),
-- ('<worker1-auth-uuid>', 'Исполнитель 1', 'worker'),
-- ('<worker2-auth-uuid>', 'Исполнитель 2', 'worker');
