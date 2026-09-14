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

const PERSONA_RULES = `This user is a broke young adult or student on a tight food budget - they are NOT looking for fine dining or premium ingredients. Favor cheap, filling staple ingredients: rice, pasta, beans, eggs, chicken thighs, ground beef, frozen vegetables, canned goods, oats, bread. Avoid expensive proteins (steak, lobster, tuna steaks, salmon fillets used repeatedly), avoid alcohol entirely, avoid restaurant-style desserts (tiramisu, creme brulee, cheesecake) - simple, cheap treats are fine occasionally (cookies, fruit) but should not be a recurring pattern across the week. Repetition of cheap core ingredients across multiple meals is GOOD, not a flaw - it is how real budget cooking works.

All prices are in USD, reflecting typical US grocery store costs. All ingredient quantities use US customary units - cups, tsp, tbsp, lbs for solid weight, oz for smaller solid weight amounts, fl oz for liquids - never metric.

grocery_section must be one of: Produce, Dairy & Eggs, Meat & Seafood, Bakery, Pantry, Frozen, Other.`;

app.get('/health', async (req, res) => {
  const { error } = await supabase.from('_health_check').select('*').limit(1);
  const tableNotFound = error && (error.code === '42P01' || error.code === 'PGRST205');
  res.json({ status: 'ok', supabase_reachable: !error || tableNotFound });
});

async function generateMealPlan({ weeklyBudget, dietaryRestrictions, householdSize, cookingSkill }) {
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

${PERSONA_RULES}

Generate exactly 21 meals: 7 days (Monday through Sunday), each with breakfast, lunch, and dinner. All estimated_cost values must sum to approximately the weekly budget given. Keep recipes realistic for the stated cooking skill level.`;

  const userPrompt = `Weekly budget: ${weeklyBudget}. Household size: ${householdSize}. Dietary restrictions: ${dietaryRestrictions?.join(', ') || 'none'}. Cooking skill: ${cookingSkill}.`;

  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-5',
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

async function generateReplacementMeal({ dayOfWeek, mealType, targetCost, dietaryRestrictions, cookingSkill }) {
  const systemPrompt = `You are a meal planning API. Output ONLY valid JSON for a single meal, no markdown code fences, no prose.

Schema:
{
  "name": "string",
  "ingredients": [{ "name": "string", "quantity": "string", "estimated_cost": number, "grocery_section": "string" }],
  "steps": ["string"],
  "estimated_cost": number,
  "macros": { "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number }
}

${PERSONA_RULES}

Generate one ${mealType} for ${dayOfWeek}, targeting approximately ${targetCost} in estimated_cost. Keep it realistic for the stated cooking skill level.`;

  const userPrompt = `Dietary restrictions: ${dietaryRestrictions?.join(', ') || 'none'}. Cooking skill: ${cookingSkill}.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
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

app.post('/api/plans', async (req, res) => {
  const { userId, weeklyBudget, dietaryRestrictions, householdSize, cookingSkill } = req.body;

  if (!userId || !weeklyBudget) {
    return res.status(400).json({ error: 'userId and weeklyBudget are required' });
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
    const generated = await generateMealPlan({ weeklyBudget, dietaryRestrictions, householdSize, cookingSkill });

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

    await supabase.from('plans').update({ status: 'ready' }).eq('id', plan.id);

    res.json({ plan: { ...plan, status: 'ready' }, meals });
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
    .select('is_pro, dietary_restrictions, cooking_skill')
    .eq('id', userId)
    .single();

  if (profileError || !profile) {
    console.log('SWAP - PROFILE FETCH ERROR:', profileError);
    return res.status(403).json({ error: 'No profile found - Pro status required for swap' });
  }

  if (!profile.is_pro) {
    return res.status(403).json({ error: 'Meal swap is a Pro feature' });
  }

  const { data: claimed, error: claimError } = await supabase
    .from('meals')
    .update({ is_swapped: true, swap_used_at: new Date().toISOString() })
    .eq('id', mealId)
    .eq('is_swapped', false)
    .select();

  if (claimError) {
    console.log('SWAP - CLAIM ERROR:', claimError);
    return res.status(500).json({ error: 'Failed to claim swap' });
  }

  if (!claimed || claimed.length === 0) {
    return res.status(409).json({ error: 'This meal has already been swapped this week' });
  }

  try {
    const replacement = await generateReplacementMeal({
      dayOfWeek: meal.day_of_week,
      mealType: meal.meal_type,
      targetCost: meal.estimated_cost,
      dietaryRestrictions: profile.dietary_restrictions,
      cookingSkill: profile.cooking_skill
    });

    const { data: updated, error: updateError } = await supabase
      .from('meals')
      .update({
        name: replacement.name,
        ingredients: replacement.ingredients,
        steps: replacement.steps,
        estimated_cost: replacement.estimated_cost,
        macros: replacement.macros
      })
      .eq('id', mealId)
      .select()
      .single();

    if (updateError) {
      console.log('SWAP - UPDATE ERROR:', updateError);
      return res.status(500).json({ error: 'Swap claimed but failed to save replacement meal' });
    }

    res.json({ meal: updated });
  } catch (err) {
    console.log('SWAP - GENERATION ERROR:', err);
    res.status(500).json({ error: 'Swap claimed but failed to generate replacement - meal is now marked swapped with no new content, needs manual fix' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mealzy backend running on ${PORT}`));
