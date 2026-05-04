/* ============================================================
   CONFIG
   ============================================================
   Fill in your Supabase project URL and anon key below.

   How to find them:
   1. Go to https://supabase.com/dashboard
   2. Open your "daily-food-log" project (create one if needed)
   3. Settings → API
   4. Copy the "Project URL" and "anon public" key

   These are SAFE to commit to a public repo. The anon key only
   gives access via Row Level Security policies (which we set up
   in supabase/schema.sql) — it cannot bypass them.
   ============================================================ */

window.APP_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-ID.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-KEY-HERE',

  // Default targets for new users — they can change these in Settings
  DEFAULT_TARGETS: {
    protein_g: 180,
    calories: 2200
  },

  // Protein hit threshold for green calendar days (gives buffer below target)
  PROTEIN_HIT_THRESHOLD: 160,

  // App version (bump this when shipping updates so service worker refreshes)
  VERSION: '1.0.0'
};
