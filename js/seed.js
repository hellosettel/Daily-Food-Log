/* ============================================================
   seed.js — default food library
   ============================================================
   These foods get inserted into Supabase once (the first time
   any user signs in and finds the foods table empty). After
   that, the catalog is whatever you and your wife make of it.

   Sugar values: best-effort estimates per common serving.
   "null" means unknown — the app shows the asterisk on the
   day total when any unknown-sugar item is logged.
   ============================================================ */

window.SEED_FOODS = [
  // ----- Proteins -----
  { name: 'Grilled chicken breast',     serving_desc: '6 oz cooked',    calories: 280, protein_g: 53, carbs_g: 0,  fat_g: 6,  sugar_g: 0 },
  { name: '88/12 ground beef',          serving_desc: '4 oz cooked',    calories: 240, protein_g: 24, carbs_g: 0,  fat_g: 16, sugar_g: 0 },
  { name: 'Ground turkey 93/7',         serving_desc: '4 oz cooked',    calories: 170, protein_g: 22, carbs_g: 0,  fat_g: 9,  sugar_g: 0 },
  { name: 'Eggs',                       serving_desc: '2 large',        calories: 140, protein_g: 12, carbs_g: 1,  fat_g: 10, sugar_g: 1 },
  { name: 'Bacon',                      serving_desc: '3 strips',       calories: 130, protein_g: 9,  carbs_g: 0,  fat_g: 10, sugar_g: 0 },
  { name: 'Pork chop',                  serving_desc: '6 oz cooked',    calories: 320, protein_g: 42, carbs_g: 0,  fat_g: 16, sugar_g: 0 },
  { name: 'Salmon',                     serving_desc: '6 oz cooked',    calories: 350, protein_g: 38, carbs_g: 0,  fat_g: 21, sugar_g: 0 },
  { name: 'Greek yogurt (plain)',       serving_desc: '1 cup',          calories: 130, protein_g: 22, carbs_g: 9,  fat_g: 0,  sugar_g: 9 },
  { name: 'Cottage cheese',             serving_desc: '1 cup',          calories: 200, protein_g: 24, carbs_g: 8,  fat_g: 8,  sugar_g: 8 },
  { name: 'Protein shake (whey)',       serving_desc: '1 scoop in water', calories: 130, protein_g: 25, carbs_g: 3,  fat_g: 2,  sugar_g: 2 },

  // ----- Carbs / starches -----
  { name: 'White rice',                 serving_desc: '1 cup cooked',   calories: 205, protein_g: 4,  carbs_g: 45, fat_g: 0,  sugar_g: 0 },
  { name: 'Brown rice',                 serving_desc: '1 cup cooked',   calories: 215, protein_g: 5,  carbs_g: 45, fat_g: 2,  sugar_g: 0 },
  { name: 'Flour tortilla (8")',        serving_desc: '1 tortilla',     calories: 140, protein_g: 4,  carbs_g: 24, fat_g: 3,  sugar_g: 1 },
  { name: 'Corn tortilla',              serving_desc: '2 tortillas',    calories: 100, protein_g: 3,  carbs_g: 22, fat_g: 1,  sugar_g: 0 },
  { name: 'Sourdough bread',            serving_desc: '1 slice',        calories: 100, protein_g: 4,  carbs_g: 19, fat_g: 1,  sugar_g: 1 },
  { name: 'Yukon gold potato',          serving_desc: '1 medium',       calories: 110, protein_g: 3,  carbs_g: 26, fat_g: 0,  sugar_g: 1 },
  { name: 'Sweet potato',               serving_desc: '1 medium',       calories: 100, protein_g: 2,  carbs_g: 23, fat_g: 0,  sugar_g: 7 },
  { name: 'Oatmeal',                    serving_desc: '1/2 cup dry',    calories: 150, protein_g: 5,  carbs_g: 27, fat_g: 3,  sugar_g: 1 },
  { name: 'Pasta (cooked)',             serving_desc: '1 cup',          calories: 220, protein_g: 8,  carbs_g: 43, fat_g: 1,  sugar_g: 1 },

  // ----- Veg / produce -----
  { name: 'Broccoli',                   serving_desc: '1 cup cooked',   calories: 55,  protein_g: 4,  carbs_g: 11, fat_g: 1,  sugar_g: 3 },
  { name: 'Spinach',                    serving_desc: '2 cups raw',     calories: 15,  protein_g: 2,  carbs_g: 2,  fat_g: 0,  sugar_g: 0 },
  { name: 'Mixed greens salad',         serving_desc: '2 cups',         calories: 20,  protein_g: 1,  carbs_g: 4,  fat_g: 0,  sugar_g: 2 },
  { name: 'Tomato',                     serving_desc: '1 medium',       calories: 22,  protein_g: 1,  carbs_g: 5,  fat_g: 0,  sugar_g: 3 },
  { name: 'Avocado',                    serving_desc: '1/2 medium',     calories: 120, protein_g: 1,  carbs_g: 6,  fat_g: 11, sugar_g: 0 },
  { name: 'Banana',                     serving_desc: '1 medium',       calories: 105, protein_g: 1,  carbs_g: 27, fat_g: 0,  sugar_g: 14 },
  { name: 'Apple',                      serving_desc: '1 medium',       calories: 95,  protein_g: 0,  carbs_g: 25, fat_g: 0,  sugar_g: 19 },
  { name: 'Berries (mixed)',            serving_desc: '1 cup',          calories: 65,  protein_g: 1,  carbs_g: 16, fat_g: 0,  sugar_g: 11 },

  // ----- Fats / dairy / extras -----
  { name: 'Butter',                     serving_desc: '1 tbsp',         calories: 100, protein_g: 0,  carbs_g: 0,  fat_g: 11, sugar_g: 0 },
  { name: 'Olive oil',                  serving_desc: '1 tbsp',         calories: 120, protein_g: 0,  carbs_g: 0,  fat_g: 14, sugar_g: 0 },
  { name: 'Cheddar cheese',             serving_desc: '1 oz',           calories: 115, protein_g: 7,  carbs_g: 0,  fat_g: 9,  sugar_g: 0 },
  { name: 'Whole milk',                 serving_desc: '1 cup',          calories: 150, protein_g: 8,  carbs_g: 12, fat_g: 8,  sugar_g: 12 },
  { name: 'Black coffee',               serving_desc: '1 cup',          calories: 5,   protein_g: 0,  carbs_g: 0,  fat_g: 0,  sugar_g: 0 },
  { name: 'Coffee with cream + sugar',  serving_desc: '12 oz',          calories: 60,  protein_g: 1,  carbs_g: 9,  fat_g: 3,  sugar_g: 9 },

  // ----- Common drinks / sweets (track these!) -----
  { name: 'Soda (regular)',             serving_desc: '12 oz can',      calories: 140, protein_g: 0,  carbs_g: 39, fat_g: 0,  sugar_g: 39 },
  { name: 'Beer',                       serving_desc: '12 oz',          calories: 150, protein_g: 1,  carbs_g: 13, fat_g: 0,  sugar_g: 0 },
  { name: 'Wine (red)',                 serving_desc: '5 oz glass',     calories: 125, protein_g: 0,  carbs_g: 4,  fat_g: 0,  sugar_g: 1 },
  { name: 'Ice cream',                  serving_desc: '1/2 cup',        calories: 140, protein_g: 2,  carbs_g: 17, fat_g: 7,  sugar_g: 14 },
  { name: 'Chocolate (dark)',           serving_desc: '1 oz',           calories: 170, protein_g: 2,  carbs_g: 13, fat_g: 12, sugar_g: 7 }
];
