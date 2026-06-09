-- Migration v8: add sodium tracking to foods and meals
-- Safe to run multiple times (additive only, uses if-not-exists guards)

alter table public.foods
  add column if not exists sodium_mg numeric;

alter table public.meals
  add column if not exists sodium_mg numeric;

-- No index needed; sodium isn't queried by, just summed.
-- No RLS changes needed; existing policies cover these new columns automatically.
