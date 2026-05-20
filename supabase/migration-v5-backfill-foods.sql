-- ============================================================
-- migration-v5-backfill-foods.sql
-- ============================================================
-- Pre-refactor foods rows have kind = NULL and household_id = NULL
-- because the column didn't exist before v3. These rows are invisible
-- to the new pullFoods() query which filters on kind and household_id.
--
-- This backfill assigns orphaned foods to the household belonging
-- to the original admin user (f8910935-4761-4b31-879b-0ba700fb42f2).
-- All NULL-kind rows are treated as household foods, not system foods.
--
-- Run this once in the Supabase SQL editor after migration-v3 and v4.
-- ============================================================

update public.foods
set
  kind         = 'household',
  household_id = (
    select household_id
    from   public.household_members
    where  user_id = 'f8910935-4761-4b31-879b-0ba700fb42f2'
    limit  1
  )
where
  -- Rows with no kind set (pre-refactor)
  kind is null
  -- Rows explicitly typed household but never assigned to a household
  or (kind = 'household' and household_id is null);
