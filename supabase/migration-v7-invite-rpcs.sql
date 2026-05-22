-- ============================================================
-- migration-v7-invite-rpcs.sql
-- ============================================================
-- Invite redemption fails with RLS errors because the joining
-- user cannot read the target household or insert into
-- household_members before being a member.
--
-- Fix: two SECURITY DEFINER functions that run as the DB owner
-- and bypass RLS. The client calls these via supabase.rpc()
-- instead of doing multi-step cross-table operations directly.
--
-- preview_household_invite  — validate code + return name/count
-- redeem_household_invite   — atomically migrate user + consume code
--
-- Run once in the Supabase SQL editor.
-- ============================================================

-- ------------------------------------------------------------
-- preview_household_invite
-- Returns one row with the household name and member count, or
-- an error_code string if the code is invalid/expired/consumed.
-- Never raises an exception — the client maps error_code to a
-- user-friendly message.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_household_invite(invite_code text)
RETURNS TABLE(
  household_name  text,
  member_count    bigint,
  error_code      text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invite  RECORD;
  v_hh_name text;
  v_count   bigint;
BEGIN
  SELECT * INTO v_invite
  FROM public.household_invites
  WHERE code = invite_code;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, 0::bigint, 'invalid'::text;
    RETURN;
  END IF;

  IF v_invite.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::text, 0::bigint, 'consumed'::text;
    RETURN;
  END IF;

  IF v_invite.expires_at < now() THEN
    RETURN QUERY SELECT NULL::text, 0::bigint, 'expired'::text;
    RETURN;
  END IF;

  SELECT h.name INTO v_hh_name
  FROM public.households h
  WHERE h.id = v_invite.household_id;

  SELECT count(*) INTO v_count
  FROM public.household_members hm
  WHERE hm.household_id = v_invite.household_id;

  RETURN QUERY SELECT v_hh_name, v_count, NULL::text;
END;
$$;

-- ------------------------------------------------------------
-- redeem_household_invite
-- Atomically:
--   1. Validates the invite (invalid / consumed / expired).
--   2. Removes auth.uid() from their current household (promotes
--      next-senior member to owner if needed; deletes household
--      if it becomes empty).
--   3. Adds auth.uid() to the target household as 'member'.
--   4. Marks the invite consumed.
--
-- user_id is always auth.uid() — no caller-supplied uid param,
-- so the code cannot be redeemed on behalf of another user.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_household_invite(invite_code text)
RETURNS TABLE(
  household_name  text,
  error_code      text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          uuid;
  v_invite       RECORD;
  v_hh_name      text;
  v_old_hh_id    uuid;
  v_other_count  bigint;
BEGIN
  v_uid := auth.uid();

  IF v_uid IS NULL THEN
    RETURN QUERY SELECT NULL::text, 'unauthenticated'::text;
    RETURN;
  END IF;

  SELECT * INTO v_invite
  FROM public.household_invites
  WHERE code = invite_code;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, 'invalid'::text;
    RETURN;
  END IF;

  IF v_invite.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::text, 'consumed'::text;
    RETURN;
  END IF;

  IF v_invite.expires_at < now() THEN
    RETURN QUERY SELECT NULL::text, 'expired'::text;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.household_members
    WHERE household_id = v_invite.household_id AND user_id = v_uid
  ) THEN
    RETURN QUERY SELECT NULL::text, 'already_member'::text;
    RETURN;
  END IF;

  SELECT h.name INTO v_hh_name
  FROM public.households h
  WHERE h.id = v_invite.household_id;

  -- Remove user from their current household, if any
  SELECT household_id INTO v_old_hh_id
  FROM public.household_members
  WHERE user_id = v_uid
  LIMIT 1;

  IF v_old_hh_id IS NOT NULL THEN
    -- If leaving user is the owner and others remain, promote next senior member
    IF EXISTS (
      SELECT 1 FROM public.household_members
      WHERE household_id = v_old_hh_id AND user_id = v_uid AND role = 'owner'
    ) THEN
      SELECT count(*) INTO v_other_count
      FROM public.household_members
      WHERE household_id = v_old_hh_id AND user_id <> v_uid;

      IF v_other_count > 0 THEN
        UPDATE public.household_members
        SET role = 'owner'
        WHERE household_id = v_old_hh_id
          AND user_id = (
            SELECT user_id
            FROM public.household_members
            WHERE household_id = v_old_hh_id AND user_id <> v_uid
            ORDER BY joined_at ASC
            LIMIT 1
          );
      END IF;
    END IF;

    DELETE FROM public.household_members
    WHERE user_id = v_uid AND household_id = v_old_hh_id;

    IF NOT EXISTS (
      SELECT 1 FROM public.household_members WHERE household_id = v_old_hh_id
    ) THEN
      DELETE FROM public.households WHERE id = v_old_hh_id;
    END IF;
  END IF;

  -- Join the new household
  INSERT INTO public.household_members (household_id, user_id, role)
  VALUES (v_invite.household_id, v_uid, 'member')
  ON CONFLICT (household_id, user_id) DO NOTHING;

  -- Consume the invite
  UPDATE public.household_invites
  SET consumed_at = now()
  WHERE code = invite_code;

  RETURN QUERY SELECT v_hh_name, NULL::text;
END;
$$;

-- Restrict to signed-in users only
REVOKE EXECUTE ON FUNCTION public.preview_household_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_household_invite(text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.redeem_household_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_household_invite(text) TO authenticated;
