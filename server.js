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
      "ingredients": [{ "name": "string", "quantity": "string", "estimated_cost": number }],
      "steps": ["string"],
      "estimated_cost": number,
      "macros": { "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number }
    }
  ]
}

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mealzy backend running on ${PORT}`));


