-- ============================================================
-- migration-v4-profiles.sql
-- ============================================================
-- Adds a public.profiles table mirroring safe fields from
-- auth.users (id, email, display_name) so client code can show
-- household member identities without admin access to auth.users.
--
-- Also fixes a RLS recursion bug on household_members. The
-- previous SELECT policy queried household_members in its own
-- USING clause, which causes infinite recursion under RLS and
-- returns HTTP 500 on any read. The fix is a SECURITY DEFINER
-- helper function that bypasses RLS for the membership check.
--
-- Run this in the Supabase SQL editor.
-- ============================================================

-- ============================================================
-- 1. profiles table
-- ============================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Idempotency: drop existing policies before recreating
drop policy if exists "profiles_select_authenticated" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;

-- Any authenticated user can read any profile.
-- This is required so household members can see each other's emails.
-- Profiles only contain non-sensitive identity fields.
create policy "profiles_select_authenticated" on public.profiles
  for select to authenticated using (true);

-- Users can update their own profile (e.g. display_name)
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ============================================================
-- 2. Backfill existing users
-- ============================================================

insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do update set email = excluded.email;

-- ============================================================
-- 3. Trigger: auto-create profile on signup
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep email in sync if the user changes it in auth
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email, updated_at = now()
    where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_change on auth.users;
create trigger on_auth_user_email_change
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- ============================================================
-- 4. Fix RLS recursion on household_members
-- ============================================================
-- A SECURITY DEFINER function bypasses RLS to check membership.
-- This lets policies reference membership without re-triggering
-- the policy on household_members itself.

create or replace function public.is_household_member(hid uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.household_members
    where household_id = hid and user_id = uid
  );
$$;

create or replace function public.is_household_owner(hid uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.household_members
    where household_id = hid and user_id = uid and role = 'owner'
  );
$$;

-- Drop ALL existing SELECT policies on household_members
-- (we don't know the exact name from v3, so drop them all dynamically)
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public'
      and tablename = 'household_members'
      and cmd = 'SELECT'
  loop
    execute format('drop policy if exists %I on public.household_members', pol.policyname);
  end loop;
end $$;

-- Recreate SELECT policy without recursion
create policy "household_members_select" on public.household_members
  for select to authenticated
  using (public.is_household_member(household_id, auth.uid()));

-- Grant function execution to authenticated users
grant execute on function public.is_household_member(uuid, uuid) to authenticated;
grant execute on function public.is_household_owner(uuid, uuid) to authenticated;
