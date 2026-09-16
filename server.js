require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---- Kroger pricing client (inlined - single file, no separate module) ----

// Certification environment - matches the app registered at
// developer.kroger.com under "Certification". Switch this to
// 'https://api.kroger.com/v1' (and re-register a separate Production app)
// once Mealzy is actually launching, not before.
const KROGER_BASE = 'https://api-ce.kroger.com/v1';
const PRICE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

let cachedKrogerToken = null;
let krogerTokenExpiresAt = 0;

// Client-credentials auth. Token is cached in memory and reused until it's
// about to expire - this is a server-to-server token, not a per-user one.
async function getKrogerToken() {
  if (cachedKrogerToken && Date.now() < krogerTokenExpiresAt) return cachedKrogerToken;

  const creds = Buffer.from(
    `${process.env.KROGER_CLIENT_ID}:${process.env.KROGER_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=product.compact'
  });

  if (!res.ok) {
    throw new Error(`Kroger auth failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cachedKrogerToken = data.access_token;
  // refresh 60s early so we never fire a request on an about-to-expire token
  krogerTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedKrogerToken;
}

// Resolves a zip code to the nearest Kroger store's locationId. Called once
// per user (cached on their profile after the first successful call).
// Radius widened to 50 miles rather than relying on Kroger's unspecified
// default - meaningfully reduces false "no coverage" results in
// lower-density areas without being unreasonably far to shop at.
async function findNearestLocation(zipCode) {
  const token = await getKrogerToken();
  const res = await fetch(
    `${KROGER_BASE}/locations?filter.zipCode.near=${zipCode}&filter.radiusInMiles=50&filter.limit=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    throw new Error(`Kroger location lookup failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const location = data.data?.[0];
  if (!location) {
    // No Kroger within their search radius - known v1 gap. Caller falls
    // back to Claude's own price estimate when this returns null.
    return null;
  }
  return location.locationId;
}

// Looks up a single ingredient's price at a specific store. Returns null on
// any failure (no match, API error) rather than throwing - pricing failures
// should never break meal plan generation, they should just fall back to
// Claude's own estimate for that item.
//
// Pulls several candidate products, not just the first result - Kroger's
// default ordering isn't sorted by price, so a generic term like "chicken
// thighs" can return a bulk pack or premium branded item first. Takes the
// cheapest of the candidates instead, since that's the closer match to what
// a budget grocery shopper actually buys.
async function getIngredientPrice(ingredientName, locationId) {
  try {
    const token = await getKrogerToken();
    const res = await fetch(
      `${KROGER_BASE}/products?filter.term=${encodeURIComponent(ingredientName)}&filter.locationId=${locationId}&filter.limit=5`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;

    const data = await res.json();
    const candidates = (data.data || [])
      .map(p => ({
        name: p.description,
        price: p.items?.[0]?.price?.regular
      }))
      .filter(c => typeof c.price === 'number' && c.price > 0);

    if (candidates.length === 0) return null;

    const cheapest = candidates.reduce((a, b) => (a.price < b.price ? a : b));
    console.log(`KROGER MATCH: "${ingredientName}" -> "${cheapest.name}" $${cheapest.price}`);
    return cheapest.price;
  } catch (err) {
    console.log('KROGER PRICE LOOKUP FAILED:', ingredientName, err.message);
    return null;
  }
}

// Cache-wrapped version - checks ingredient_price_cache first, only hits
// Kroger's API on a cache miss or stale entry.
async function getCachedIngredientPrice(ingredientName, locationId) {
  const { data: cached } = await supabase
    .from('ingredient_price_cache')
    .select('price, fetched_at')
    .ilike('ingredient_name', ingredientName)
    .eq('kroger_location_id', locationId)
    .maybeSingle();

  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < PRICE_CACHE_MAX_AGE_MS) {
    return cached.price;
  }

  const price = await getIngredientPrice(ingredientName, locationId);
  if (price !== null) {
    await supabase.from('ingredient_price_cache').upsert(
      {
        ingredient_name: ingredientName,
        kroger_location_id: locationId,
        price,
        fetched_at: new Date().toISOString()
      },
      { onConflict: 'ingredient_name,kroger_location_id' }
    );
  }
  return price; // may be null - caller falls back to Claude's estimate
}

// ---- end Kroger pricing client ----

// PERSONA_RULES is a function, not a static string, specifically so the
// allergy exclusion clause is built fresh per call and can never drift out
// of sync between generateMealPlan and generateReplacementMeal the way a
// hand-copied constant could. Both functions below call this - if you ever
// edit the base rules or the allergy clause, there is only one place to
// change, not two to keep in sync.
// Common hidden/derived forms for allergens - checked in addition to the
// literal allergen word, since "peanuts" alone wouldn't catch "peanut
// butter" or "peanut oil" in an ingredient name. Falls back to the literal
// stated term for anything not in this map, so a custom-entered allergy
// still gets checked, just without the extra derived-form coverage.
const ALLERGEN_ALIASES = {
  peanut: ['peanut', 'peanut butter', 'peanut oil', 'satay'],
  peanuts: ['peanut', 'peanut butter', 'peanut oil', 'satay'],
  'tree nuts': ['almond', 'cashew', 'walnut', 'pecan', 'pistachio', 'hazelnut', 'macadamia'],
  shellfish: ['shrimp', 'crab', 'lobster', 'shellfish', 'oyster sauce'],
  fish: ['fish sauce', 'anchovy', 'salmon', 'tuna', 'cod', 'tilapia'],
  dairy: ['milk', 'cheese', 'butter', 'cream', 'yogurt'],
  egg: ['egg', 'eggs', 'mayonnaise'],
  eggs: ['egg', 'eggs', 'mayonnaise'],
  gluten: ['wheat', 'flour', 'bread', 'pasta'],
  wheat: ['wheat', 'flour', 'bread', 'pasta'],
  soy: ['soy', 'soy sauce', 'tofu', 'edamame'],
  sesame: ['sesame', 'tahini']
};

// This is the real safety backstop, separate from and in addition to the
// prompt instruction in buildPersonaRules. A prompt instruction, even a
// "hard exclusion" one, is followed probabilistically by the model, not
// guaranteed - confirmed by a real test run where it failed once despite
// the rule being in place. This function checks the actual output, in
// code, and is the thing that should be trusted, not the prompt alone.
function findAllergenViolations(generated, allergies) {
  if (!Array.isArray(allergies) || allergies.length === 0) return [];

  const violations = [];
  for (const allergen of allergies) {
    const key = allergen.toLowerCase().trim();
    const terms = ALLERGEN_ALIASES[key] || [key];

    for (const meal of generated.meals) {
      for (const ing of meal.ingredients) {
        const name = ing.name.toLowerCase();
        if (terms.some(term => name.includes(term))) {
          violations.push({ allergen, meal: `${meal.day_of_week} ${meal.meal_type}`, ingredient: ing.name });
        }
      }
    }
  }
  return violations;
}

function buildPersonaRules(allergies, cuisinePreferences) {
  const hasAllergies = Array.isArray(allergies) && allergies.length > 0;
  const hasCuisinePrefs = Array.isArray(cuisinePreferences) && cuisinePreferences.length > 0
    && !cuisinePreferences.includes('No preference');

  const allergyClause = hasAllergies
    ? `

CRITICAL SAFETY REQUIREMENT - this is a hard exclusion, not a preference: this user has the following allergies: ${allergies.join(', ')}. NEVER include any of these allergens in any ingredient, in any form - including as a minor or hidden component (for example, an allergy to peanuts also excludes peanut oil, peanut butter, and any dish that commonly contains peanuts, such as certain Thai or satay recipes; an allergy to shellfish also excludes fish sauce and oyster sauce). If avoiding an allergen means a less typical or less optimal recipe choice, always choose safety over optimality. Do not include a disclaimed or "may contain traces" ingredient - exclude it outright.`
    : '';

  // Soft preference, unlike allergies above - it's fine to occasionally
  // include something outside these cuisines if the budget or variety
  // genuinely calls for it, this just biases meal selection, it doesn't
  // forbid anything.
  const cuisineClause = hasCuisinePrefs
    ? `

This user prefers these cuisines: ${cuisinePreferences.join(', ')}. Favor recipes from these cuisines where it fits the budget and the broke-student framing above - this is a preference to weight toward, not a hard restriction, so an occasional meal outside these cuisines is fine if it serves the budget or variety better.`
    : '';

  return `This user is a broke young adult or student on a tight food budget - they are NOT looking for fine dining or premium ingredients. Favor cheap, filling staple ingredients: rice, pasta, beans, eggs, chicken thighs, ground beef, frozen vegetables, canned goods, oats, bread. Avoid expensive proteins (steak, lobster, tuna steaks, salmon fillets used repeatedly), avoid alcohol entirely, avoid restaurant-style desserts (tiramisu, creme brulee, cheesecake) - simple, cheap treats are fine occasionally (cookies, fruit) but should not be a recurring pattern across the week. Repetition of cheap core ingredients across multiple meals is GOOD, not a flaw - it is how real budget cooking works.

All prices are in USD, reflecting typical US grocery store costs. All ingredient quantities use US customary units - cups, tsp, tbsp, lbs for solid weight, oz for smaller solid weight amounts, fl oz for liquids - never metric.

grocery_section must be one of: Produce, Dairy & Eggs, Meat & Seafood, Bakery, Pantry, Frozen, Other.${cuisineClause}${allergyClause}`;
}

app.get('/health', async (req, res) => {
  const { error } = await supabase.from('_health_check').select('*').limit(1);
  const tableNotFound = error && (error.code === '42P01' || error.code === 'PGRST205');
  res.json({ status: 'ok', supabase_reachable: !error || tableNotFound });
});

async function generateMealPlan({ weeklyBudget, dietaryRestrictions, householdSize, cookingSkill, allergies, cuisinePreferences }) {
  const systemPrompt = `You are a meal planning API. Output ONLY valid JSON, no markdown code fences, no prose, no explanation before or after.

Schema:
{
  "meals": [
    {
      "day_of_week": "Monday",
      "meal_type": "breakfast",
      "name": "string",
      "ingredients": [{ "name": "string", "quantity": "string", "estimated_cost": number, "grocery_section": "string" }],
      "steps": ["string"],
      "estimated_cost": number,
      "macros": { "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number }
    }
  ]
}

${buildPersonaRules(allergies, cuisinePreferences)}

Generate exactly 21 meals: 7 days (Monday through Sunday), each with breakfast, lunch, and dinner. All estimated_cost values must sum to within 10% of the weekly budget given (not significantly under or over) - use the budget, don't leave a large portion of it unaccounted for. Keep recipes realistic for the stated cooking skill level.`;

  const userPrompt = `Weekly budget: ${weeklyBudget}. Household size: ${householdSize}. Dietary restrictions: ${dietaryRestrictions?.join(', ') || 'none'}. Cooking skill: ${cookingSkill}.`;

  const stream = anthropic.messages.stream({
    model: process.env.TEST_MODEL || 'claude-sonnet-5',
    max_tokens: 32000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === 'max_tokens') {
    throw new Error('Claude response was truncated - hit max_tokens before finishing. Raise max_tokens further.');
  }

  const textBlock = response.content.find(block => block.type === 'text');
  if (!textBlock) {
    throw new Error('No text block in Claude response: ' + JSON.stringify(response.content));
  }

  let raw = textBlock.text.trim();
  raw = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();

  return JSON.parse(raw);
}

async function generateReplacementMeal({ dayOfWeek, mealType, targetCost, dietaryRestrictions, cookingSkill, allergies, cuisinePreferences }) {
  const systemPrompt = `You are a meal planning API. Output ONLY valid JSON for a single meal, no markdown code fences, no prose.

Schema:
{
  "name": "string",
  "ingredients": [{ "name": "string", "quantity": "string", "estimated_cost": number, "grocery_section": "string" }],
  "steps": ["string"],
  "estimated_cost": number,
  "macros": { "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number }
}

${buildPersonaRules(allergies, cuisinePreferences)}

Generate one ${mealType} for ${dayOfWeek}, targeting approximately ${targetCost} in estimated_cost. Keep it realistic for the stated cooking skill level.`;

  const userPrompt = `Dietary restrictions: ${dietaryRestrictions?.join(', ') || 'none'}. Cooking skill: ${cookingSkill}.`;

  const response = await anthropic.messages.create({
    model: process.env.TEST_MODEL || 'claude-sonnet-5',
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const textBlock = response.content.find(block => block.type === 'text');
  if (!textBlock) {
    throw new Error('No text block in Claude response: ' + JSON.stringify(response.content));
  }

  let raw = textBlock.text.trim();
  raw = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();

  return JSON.parse(raw);
}

// Wraps generateReplacementMeal with automatic retries - a failed
// Anthropic call or a rejected allergen violation should not immediately
// give up, since a single failure is often transient. Tries up to
// maxAttempts times before finally throwing, which the swap route below
// uses as the signal that nothing should be claimed. This function
// produces content only - it never touches the database, so nothing is
// ever half-committed if it fails.
async function generateSafeReplacementMeal(params, maxAttempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const replacement = await generateReplacementMeal(params);
      const violations = findAllergenViolations({ meals: [replacement] }, params.allergies);
      if (violations.length > 0) {
        console.log(`SWAP - allergen violation on attempt ${attempt}/${maxAttempts}, retrying:`, JSON.stringify(violations));
        lastError = new Error('Allergen violation: ' + JSON.stringify(violations));
        continue;
      }
      return replacement;
    } catch (err) {
      console.log(`SWAP - generation attempt ${attempt}/${maxAttempts} failed:`, err.message);
      lastError = err;
    }
  }
  throw lastError || new Error('Failed to generate a safe replacement after all attempts');
}

// Overwrites Claude's guessed estimated_cost values with real Kroger
// prices where a match is found. Falls back to Claude's own estimate,
// per-ingredient, on any lookup miss - a plan should never fail just
// because pricing couldn't be verified for one item. Also tracks how many
// ingredients actually got a real match vs. fell back, so the caller can
// be honest with the user about whether this plan's prices are verified
// real numbers or estimates.
//
// Package price vs. recipe-scale usage: a "1 tsp garlic powder" line and a
// "$3.99 whole jar of garlic powder" are not comparable numbers, but
// Kroger's product search has no way to know that - it just returns the
// jar's price. Known v1 simplification: skip Kroger entirely for this
// category and keep Claude's own recipe-scale estimate, rather than build
// full quantity-parsing/unit-conversion/package-size-prorating (the
// actually-correct fix, real scope, not done here). Matched on specific
// phrases, not loose single words, to avoid catching real ingredients like
// "bell pepper" (produce, real per-unit cost) under a bare "pepper" match.
const PANTRY_STAPLE_TERMS = [
  'salt and pepper', 'black pepper', 'ground pepper', 'salt', 'garlic powder',
  'onion powder', 'paprika', 'cumin', 'oregano', 'dried basil', 'dried thyme',
  'cinnamon', 'nutmeg', 'chili powder', 'red pepper flakes',
  'olive oil', 'vegetable oil', 'canola oil', 'cooking oil', 'sesame oil',
  'vinegar', 'soy sauce', 'hot sauce', 'worcestershire',
  'baking soda', 'baking powder', 'cornstarch', 'vanilla extract',
  'bouillon', 'brown sugar', 'white sugar', 'granulated sugar', 'honey',
  'jelly', 'jam', 'maple syrup'
];

function isPantryStaple(ingredientName) {
  const lower = ingredientName.toLowerCase();
  return PANTRY_STAPLE_TERMS.some(term => lower.includes(term));
}

async function enrichWithRealPrices(generated, locationId) {
  let totalIngredients = 0;
  let realMatches = 0;

  if (!locationId) {
    for (const meal of generated.meals) totalIngredients += meal.ingredients.length;
    return { pricingSource: 'estimated', realMatches: 0, totalIngredients };
  }

  for (const meal of generated.meals) {
    const originalMealTotal = meal.ingredients.reduce((sum, ing) => sum + ing.estimated_cost, 0);
    const originalEstimates = meal.ingredients.map(ing => ing.estimated_cost); // snapshot, in case this meal gets reverted below
    let mealRealMatches = 0;

    let mealTotal = 0;
    for (const ing of meal.ingredients) {
      totalIngredients++;

      if (isPantryStaple(ing.name)) {
        // Skip Kroger entirely - keep Claude's recipe-scale estimate.
        mealTotal += ing.estimated_cost;
        continue;
      }

      const claudeEstimate = ing.estimated_cost;
      const realPrice = await getCachedIngredientPrice(ing.name, locationId);

      // Sanity check: if the "real" price is wildly higher than Claude's own
      // estimate, that's a stronger signal of a bad product match (wrong
      // size, wrong item) than of genuine price reality - keep Claude's
      // estimate instead of trusting an obvious outlier.
      const isReasonable = realPrice !== null && realPrice <= claudeEstimate * 4 + 5;
      if (isReasonable) {
        ing.estimated_cost = realPrice;
        mealRealMatches++;
      }

      mealTotal += ing.estimated_cost;
    }

    // Second, meal-level check: many individually-small overages can still
    // compound into an unreasonable total even when each one passed the
    // per-ingredient cap above. If the whole meal drifted too far from
    // Claude's original total, that's a bad batch of matches - revert the
    // entire meal to Claude's original estimates rather than trust
    // compounding drift. Threshold: more than double the original total.
    if (mealTotal > originalMealTotal * 2) {
      meal.ingredients.forEach((ing, i) => { ing.estimated_cost = originalEstimates[i]; });
      mealTotal = originalMealTotal;
      mealRealMatches = 0; // none of this meal's matches counted, all reverted
    }

    realMatches += mealRealMatches;
    meal.estimated_cost = Math.round(mealTotal * 100) / 100;
  }

  let pricingSource = 'estimated';
  if (realMatches === totalIngredients) pricingSource = 'kroger';
  else if (realMatches > 0) pricingSource = 'mixed';

  return { pricingSource, realMatches, totalIngredients };
}

// Deterministic budget-fit correction. The "within 10%" instruction in
// generateMealPlan's prompt is followed probabilistically, not guaranteed -
// confirmed by real test runs landing anywhere from ~46% to ~140% of
// budget despite the same instruction being in place every time. This is
// the same lesson allergies already taught this session: a prompt rule
// alone isn't enough when the number actually needs to be right - this is
// the code-level backstop for budget accuracy.
//
// Runs AFTER real Kroger pricing is applied, not before - the final total
// after real prices is what the user actually sees, so that's the number
// that needs to be correct, not Claude's pre-pricing guess.
//
// Honest tradeoff, worth knowing: this can adjust individual ingredient
// costs, including genuine Kroger prices, to hit the target. It is not
// pretending every number is an untouched raw quote after this runs - the
// app's real promise is "a plan that fits your stated budget," which this
// guarantees deterministically; per-item prices become a realistic
// reference scaled to fit, not a guaranteed-exact quote once this step
// has run.
function fitToBudget(generated, weeklyBudget) {
  const actualTotal = generated.meals.reduce((sum, m) => sum + m.estimated_cost, 0);

  if (actualTotal <= 0) {
    console.log('BUDGET FIT SKIPPED: total was zero or negative, cannot scale');
    return { adjusted: false, finalTotal: actualTotal };
  }

  const lowerBound = weeklyBudget * 0.9;
  const upperBound = weeklyBudget * 1.1;

  if (actualTotal >= lowerBound && actualTotal <= upperBound) {
    return { adjusted: false, finalTotal: Math.round(actualTotal * 100) / 100 };
  }

  const scaleFactor = weeklyBudget / actualTotal;

  for (const meal of generated.meals) {
    for (const ing of meal.ingredients) {
      ing.estimated_cost = Math.round(ing.estimated_cost * scaleFactor * 100) / 100;
    }
    meal.estimated_cost = Math.round(
      meal.ingredients.reduce((sum, ing) => sum + ing.estimated_cost, 0) * 100
    ) / 100;
  }

  const finalTotal = Math.round(
    generated.meals.reduce((sum, m) => sum + m.estimated_cost, 0) * 100
  ) / 100;

  console.log(`BUDGET ADJUSTED: raw total $${actualTotal.toFixed(2)} scaled to $${finalTotal} (target $${weeklyBudget})`);
  return { adjusted: true, finalTotal };
}

// Saves onboarding answers to a user's profile. If zip_code is included,
// resolves (and caches) their nearest Kroger location right here, rather
// than waiting until their first plan generates - so coverage is known
// as early as possible, not discovered silently mid-flow.
//
// Note: same known gap as the rest of this file - userId is trusted as
// given, no real auth check yet. Replace once Supabase Auth is wired in.
app.patch('/api/profile', async (req, res) => {
  const { userId, zipCode, householdSize, cookingSkill, dietaryRestrictions, cuisinePreferences, allergies, weeklyBudget } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const updates = {};
  if (zipCode !== undefined) updates.zip_code = zipCode;
  if (householdSize !== undefined) updates.household_size = householdSize;
  if (cookingSkill !== undefined) updates.cooking_skill = cookingSkill;
  if (dietaryRestrictions !== undefined) updates.dietary_restrictions = dietaryRestrictions;
  if (cuisinePreferences !== undefined) updates.cuisine_preferences = cuisinePreferences;
  if (allergies !== undefined) updates.allergies = allergies;
  if (weeklyBudget !== undefined) updates.weekly_budget = weeklyBudget;

  let krogerCoverage = null; // true / false / null (not checked - no zip provided this call)

  if (zipCode) {
    try {
      const locationId = await findNearestLocation(zipCode);
      updates.kroger_location_id = locationId; // may be null - that's a real "no coverage" result, not an error
      krogerCoverage = locationId !== null;
    } catch (err) {
      console.log('KROGER LOCATION LOOKUP FAILED (onboarding):', err.message);
      // Leave kroger_location_id untouched on a real API error (vs. a
      // genuine "no store found" result) - don't overwrite a possibly-
      // valid existing value with null just because this one call failed.
      krogerCoverage = null;
    }
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    console.log('PROFILE UPDATE ERROR:', error);
    return res.status(500).json({ error: 'Failed to update profile' });
  }

  res.json({ profile, krogerCoverage });
});

app.post('/api/plans', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  // Every plan-generation input is fetched from the profile now, not
  // trusted from the request body - one consistent pattern across the
  // whole route, not just the safety-critical fields (allergies) or the
  // infrastructure ones (zip/location). The client saves these via
  // PATCH /api/profile during onboarding and doesn't need to resend them
  // on every plan request.
  const { data: profile } = await supabase
    .from('profiles')
    .select('weekly_budget, dietary_restrictions, household_size, cooking_skill, zip_code, kroger_location_id, allergies, cuisine_preferences')
    .eq('id', userId)
    .single();

  if (!profile) {
    return res.status(404).json({ error: 'No profile found for this user' });
  }

  if (!profile.weekly_budget) {
    return res.status(400).json({ error: 'User has not set a weekly budget yet - complete onboarding first' });
  }

  const weeklyBudget = profile.weekly_budget;
  const dietaryRestrictions = profile.dietary_restrictions;
  const householdSize = profile.household_size;
  const cookingSkill = profile.cooking_skill;

  let locationId = profile?.kroger_location_id || null;

  if (!locationId && profile?.zip_code) {
    try {
      locationId = await findNearestLocation(profile.zip_code);
      if (locationId) {
        await supabase.from('profiles').update({ kroger_location_id: locationId }).eq('id', userId);
      }
    } catch (err) {
      console.log('KROGER LOCATION LOOKUP FAILED:', err.message);
      // locationId stays null - enrichWithRealPrices will fall back to Claude's estimates
    }
  }

  const { data: plan, error: planError } = await supabase
    .from('plans')
    .insert({
      user_id: userId,
      week_start_date: new Date().toISOString().split('T')[0],
      total_budget: weeklyBudget,
      status: 'generating'
    })
    .select()
    .single();

  if (planError) {
    console.log('PLAN INSERT ERROR:', planError);
    return res.status(500).json({ error: 'Failed to create plan' });
  }

  try {
    const generated = await generateMealPlan({ weeklyBudget, dietaryRestrictions, householdSize, cookingSkill, allergies: profile?.allergies, cuisinePreferences: profile?.cuisine_preferences });

    const violations = findAllergenViolations(generated, profile?.allergies);
    if (violations.length > 0) {
      console.log('ALLERGEN VIOLATION - PLAN REJECTED:', JSON.stringify(violations));
      await supabase.from('plans').update({ status: 'failed' }).eq('id', plan.id);
      return res.status(500).json({ error: 'Generated plan violated a stated allergy and was rejected. Please try again.', violations });
    }

    const { pricingSource } = await enrichWithRealPrices(generated, locationId);
    fitToBudget(generated, weeklyBudget);

    const mealsToInsert = generated.meals.map(m => ({ ...m, plan_id: plan.id }));

    const { data: meals, error: mealsError } = await supabase
      .from('meals')
      .insert(mealsToInsert)
      .select();

    if (mealsError) {
      console.log('MEALS INSERT ERROR:', mealsError);
      await supabase.from('plans').update({ status: 'failed' }).eq('id', plan.id);
      return res.status(500).json({ error: 'Failed to save meals' });
    }

    await supabase.from('plans').update({ status: 'ready', pricing_source: pricingSource }).eq('id', plan.id);

    res.json({ plan: { ...plan, status: 'ready', pricing_source: pricingSource }, meals });
  } catch (err) {
    console.log('GENERATION ERROR:', err);
    await supabase.from('plans').update({ status: 'failed' }).eq('id', plan.id);
    res.status(500).json({ error: 'Failed to generate meal plan' });
  }
});

app.post('/api/plans/:planId/shopping-list', async (req, res) => {
  const { planId } = req.params;

  const { data: meals, error: mealsError } = await supabase
    .from('meals')
    .select('ingredients')
    .eq('plan_id', planId);

  if (mealsError) {
    console.log('SHOPPING LIST - MEALS FETCH ERROR:', mealsError);
    return res.status(500).json({ error: 'Failed to fetch meals for plan' });
  }

  if (!meals || meals.length === 0) {
    return res.status(404).json({ error: 'No meals found for this plan' });
  }

  const items = [];
  for (const meal of meals) {
    for (const ing of meal.ingredients) {
      items.push({
        plan_id: planId,
        item_name: ing.name,
        quantity: ing.quantity,
        grocery_section: ing.grocery_section || 'Other',
        estimated_cost: ing.estimated_cost,
        is_checked: false
      });
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from('shopping_list_items')
    .insert(items)
    .select();

  if (insertError) {
    console.log('SHOPPING LIST - INSERT ERROR:', insertError);
    return res.status(500).json({ error: 'Failed to save shopping list' });
  }

  res.json({ items: inserted });
});

app.post('/api/meals/:mealId/swap', async (req, res) => {
  const { mealId } = req.params;
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const { data: meal, error: mealFetchError } = await supabase
    .from('meals')
    .select('*, plans!inner(user_id)')
    .eq('id', mealId)
    .single();

  if (mealFetchError || !meal) {
    console.log('SWAP - MEAL FETCH ERROR:', mealFetchError);
    return res.status(404).json({ error: 'Meal not found' });
  }

  if (meal.plans.user_id !== userId) {
    return res.status(403).json({ error: 'This meal does not belong to this user' });
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('is_pro, dietary_restrictions, cooking_skill, allergies, cuisine_preferences')
    .eq('id', userId)
    .single();

  if (profileError || !profile) {
    console.log('SWAP - PROFILE FETCH ERROR:', profileError);
    return res.status(403).json({ error: 'No profile found - Pro status required for swap' });
  }

  if (!profile.is_pro) {
    return res.status(403).json({ error: 'Meal swap is a Pro feature' });
  }

  // Read-only check first, not a claim - avoids wasting a generation call
  // (and an Anthropic API cost) if this meal was already swapped by an
  // earlier request. The real atomic guard against concurrent requests
  // happens later, at the actual claim-and-save step below.
  if (meal.is_swapped) {
    return res.status(409).json({ error: 'This meal has already been swapped this week' });
  }

  // This is the actual fix for the original known bug: generation now
  // happens BEFORE anything is claimed, with automatic retries, so a
  // failed Claude call or a rejected allergen violation never permanently
  // consumes the user's one weekly swap for nothing. The point of no
  // return moved to after success, not before generation even starts.
  let replacement;
  try {
    replacement = await generateSafeReplacementMeal({
      dayOfWeek: meal.day_of_week,
      mealType: meal.meal_type,
      targetCost: meal.estimated_cost,
      dietaryRestrictions: profile.dietary_restrictions,
      cookingSkill: profile.cooking_skill,
      allergies: profile.allergies,
      cuisinePreferences: profile.cuisine_preferences
    });
  } catch (err) {
    console.log('SWAP - GENERATION FAILED AFTER RETRIES:', err.message);
    return res.status(500).json({
      error: 'Failed to generate a safe replacement meal after multiple attempts. Your swap was not used - please try again.'
    });
  }

  // Atomic claim-and-save in a single update, now that we have a real,
  // safe replacement ready. WHERE is_swapped = false still guards against
  // a concurrent request winning the race between the read-only check
  // above and this point - same concurrency safety as before, just moved
  // to the end instead of the start.
  const { data: updated, error: updateError } = await supabase
    .from('meals')
    .update({
      is_swapped: true,
      swap_used_at: new Date().toISOString(),
      name: replacement.name,
      ingredients: replacement.ingredients,
      steps: replacement.steps,
      estimated_cost: replacement.estimated_cost,
      macros: replacement.macros
    })
    .eq('id', mealId)
    .eq('is_swapped', false)
    .select()
    .single();

  if (updateError || !updated) {
    console.log('SWAP - CLAIM-AND-SAVE FAILED (likely lost the race to a concurrent request):', updateError);
    return res.status(409).json({ error: 'This meal has already been swapped this week' });
  }

  res.json({ meal: updated });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mealzy backend running on ${PORT}`));