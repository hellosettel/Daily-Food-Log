-- ============================================================
-- migration-v6-consolidate-household.sql
-- ============================================================
-- Symptom: foods are correctly stored in household 3edc8b0e but the
-- app shows an empty library after sync.
--
-- Cause: while v3 RLS was recursive (returning HTTP 500), the
-- client's _checkAndCreateHousehold() misread { data: null,
-- error: present } as "no household exists" and called
-- _createSoloHousehold() on every login.  Over multiple login
-- attempts this accumulated several household_members rows for the
-- same user.  After v4 fixed RLS, pullHousehold's .maybeSingle()
-- now errors out on the multi-row result, leaves _currentHousehold
-- null, and pullFoods falls through to the system-only branch.
--
-- This script:
--   1. Ensures the canonical household (3edc8b0e) exists.
--   2. Ensures the user is a member of it (as owner).
--   3. Removes the user's memberships in every other household.
--   4. Deletes any household that becomes empty as a result.
--   5. Prints a before/after diagnostic.
--
-- Run this once in the Supabase SQL editor.
-- ============================================================

do $$
declare
  uid              uuid := 'f8910935-4761-4b31-879b-0ba700fb42f2';
  canonical_hid    uuid := '3edc8b0e-3d88-4ca1-84c0-1d06aecf32fe';
  other_hid        uuid;
  membership_count int;
begin
  select count(*) into membership_count
  from public.household_members where user_id = uid;
  raise notice 'before: user has % household membership(s)', membership_count;

  -- 1. Ensure the canonical household row exists
  insert into public.households (id, name, created_by)
  select canonical_hid, 'Household', uid
  where not exists (select 1 from public.households where id = canonical_hid);

  -- 2. Ensure the user is a member of the canonical household as owner.
  -- Delete-then-insert to avoid depending on a specific constraint name.
  delete from public.household_members
    where user_id = uid and household_id = canonical_hid;
  insert into public.household_members (household_id, user_id, role)
    values (canonical_hid, uid, 'owner');

  -- 3 + 4. Remove all other memberships; delete now-empty households.
  for other_hid in
    select household_id from public.household_members
    where user_id = uid and household_id <> canonical_hid
  loop
    delete from public.household_members
      where user_id = uid and household_id = other_hid;

    if not exists (
      select 1 from public.household_members where household_id = other_hid
    ) then
      delete from public.households where id = other_hid;
    end if;
  end loop;

  select count(*) into membership_count
  from public.household_members where user_id = uid;
  raise notice 'after:  user has % household membership(s)', membership_count;
end$$;

-- Final verification — these row counts should be:
--   foods_in_canonical: >0 (your backfilled foods)
--   foods_orphaned:     0
--   user_memberships:   1
select 'foods_in_canonical' as label, count(*) as n
from public.foods
where household_id = '3edc8b0e-3d88-4ca1-84c0-1d06aecf32fe'
union all
select 'foods_orphaned', count(*)
from public.foods
where household_id is null and (kind is null or kind <> 'system')
union all
select 'user_memberships', count(*)
from public.household_members
where user_id = 'f8910935-4761-4b31-879b-0ba700fb42f2';
