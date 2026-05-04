-- ============================================================
-- Daily Log — Supabase schema
-- ============================================================
-- How to run:
--   1. Go to your Supabase project's "SQL Editor"
--   2. Paste this entire file
--   3. Click "Run"
--
-- This creates 5 tables and Row Level Security policies that
-- ensure each user can only see/modify their own data — except
-- for `foods`, which is shared across all users (the household
-- food library).
-- ============================================================

-- Drop existing tables if you're starting over (uncomment if needed)
-- drop table if exists public.meals cascade;
-- drop table if exists public.weights cascade;
-- drop table if exists public.targets cascade;
-- drop table if exists public.notes cascade;
-- drop table if exists public.foods cascade;

-- ============================================================
-- foods — shared catalog (no user_id, both users can read/write)
-- ============================================================
create table if not exists public.foods (
  id uuid primary key,
  name text not null,
  serving_desc text,
  calories numeric not null default 0,
  protein_g numeric not null default 0,
  carbs_g numeric not null default 0,
  fat_g numeric not null default 0,
  sugar_g numeric,                        -- nullable: blank = unknown
  updated_at timestamptz not null default now()
);

create index if not exists foods_name_idx on public.foods (name);

alter table public.foods enable row level security;

-- Anyone signed in can read and write the shared food library
drop policy if exists "foods_read_authenticated" on public.foods;
create policy "foods_read_authenticated" on public.foods
  for select using (auth.role() = 'authenticated');

drop policy if exists "foods_insert_authenticated" on public.foods;
create policy "foods_insert_authenticated" on public.foods
  for insert with check (auth.role() = 'authenticated');

drop policy if exists "foods_update_authenticated" on public.foods;
create policy "foods_update_authenticated" on public.foods
  for update using (auth.role() = 'authenticated');

drop policy if exists "foods_delete_authenticated" on public.foods;
create policy "foods_delete_authenticated" on public.foods
  for delete using (auth.role() = 'authenticated');


-- ============================================================
-- meals — per-user log entries
-- ============================================================
create table if not exists public.meals (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  meal_type text not null check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  food_id uuid,                           -- nullable: custom one-off items have no food_id
  food_name text not null,
  servings numeric not null default 1,
  calories numeric not null default 0,
  protein_g numeric not null default 0,
  carbs_g numeric not null default 0,
  fat_g numeric not null default 0,
  sugar_g numeric,                        -- nullable: blank = unknown
  updated_at timestamptz not null default now()
);

create index if not exists meals_user_date_idx on public.meals (user_id, date);

alter table public.meals enable row level security;

drop policy if exists "meals_select_own" on public.meals;
create policy "meals_select_own" on public.meals
  for select using (auth.uid() = user_id);

drop policy if exists "meals_insert_own" on public.meals;
create policy "meals_insert_own" on public.meals
  for insert with check (auth.uid() = user_id);

drop policy if exists "meals_update_own" on public.meals;
create policy "meals_update_own" on public.meals
  for update using (auth.uid() = user_id);

drop policy if exists "meals_delete_own" on public.meals;
create policy "meals_delete_own" on public.meals
  for delete using (auth.uid() = user_id);


-- ============================================================
-- weights — per-user weight log
-- ============================================================
create table if not exists public.weights (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  weight_lbs numeric not null,
  updated_at timestamptz not null default now()
);

create index if not exists weights_user_date_idx on public.weights (user_id, date);

alter table public.weights enable row level security;

drop policy if exists "weights_select_own" on public.weights;
create policy "weights_select_own" on public.weights
  for select using (auth.uid() = user_id);

drop policy if exists "weights_insert_own" on public.weights;
create policy "weights_insert_own" on public.weights
  for insert with check (auth.uid() = user_id);

drop policy if exists "weights_update_own" on public.weights;
create policy "weights_update_own" on public.weights
  for update using (auth.uid() = user_id);

drop policy if exists "weights_delete_own" on public.weights;
create policy "weights_delete_own" on public.weights
  for delete using (auth.uid() = user_id);


-- ============================================================
-- targets — one row per user
-- ============================================================
create table if not exists public.targets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  protein_g numeric not null default 180,
  calories numeric not null default 2200,
  updated_at timestamptz not null default now()
);

alter table public.targets enable row level security;

drop policy if exists "targets_select_own" on public.targets;
create policy "targets_select_own" on public.targets
  for select using (auth.uid() = user_id);

drop policy if exists "targets_insert_own" on public.targets;
create policy "targets_insert_own" on public.targets
  for insert with check (auth.uid() = user_id);

drop policy if exists "targets_update_own" on public.targets;
create policy "targets_update_own" on public.targets
  for update using (auth.uid() = user_id);


-- ============================================================
-- notes — one note per user per day
-- ============================================================
create table if not exists public.notes (
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  text text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

alter table public.notes enable row level security;

drop policy if exists "notes_select_own" on public.notes;
create policy "notes_select_own" on public.notes
  for select using (auth.uid() = user_id);

drop policy if exists "notes_insert_own" on public.notes;
create policy "notes_insert_own" on public.notes
  for insert with check (auth.uid() = user_id);

drop policy if exists "notes_update_own" on public.notes;
create policy "notes_update_own" on public.notes
  for update using (auth.uid() = user_id);

drop policy if exists "notes_delete_own" on public.notes;
create policy "notes_delete_own" on public.notes
  for delete using (auth.uid() = user_id);


-- ============================================================
-- Done. The food library will seed itself on first sign-in.
-- ============================================================
