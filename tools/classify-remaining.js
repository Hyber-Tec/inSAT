#!/usr/bin/env node
/**
   Use functions/lib/batch.js to classify remaining 25,000+ math problems.
   Falls back to synchronous calls if no key available.
*/
import { submitBatch, awaitBatch, fetchBatchResults } from '../functions/lib/batch.js';
import { config } from '../functions/lib/config.js';

// System prompt that tells the AI how to classify each question
const SYSTEM_PROMPT = `
You are an SAT skill classifier. Categorize each math problem into:

- algebra: linear equations, slopes, inequalities, absolute value  
- advanced-math: quadratics, parabolas, polynomials, exponentials/logs  
- geometry-trig: triangles, circles, similarity, congruency, trig ratios  
- problem-solving: probability, scatterplots, statistics, data analysis  

Return ONLY JSON: {"skill":"algebra"} (one per line)
`;

/** Load unanswered/unmatched questions from classifier queue */
let pending = [];

try {
  const bank = JSON.parse(await Deno.readTextFile(
    '/Users/br0k3r/workspace/vantedge/satify/exports/class-marker-llm/pending.json'
  ));
  pending = bank;
} catch (e) {
  console.log('No pending file found. Using test batch...');
  
  // Dummy questions for testing if no pending queue exists
  const dummy = [
    { 
      customId: 'test-1', 
      prompt: 'Solve x + 5 = 10. What is x?',
      category: 'linear equation'
    },
    { 
      customId: 'test-2', 
      prompt: 'If a triangle has sides 3, 4, what is the hypotenuse?',
      category: 'triangle theorem'
    }
  ];
  pending = dummy;
}

/** Create classification requests for each question */
function createClassificationQuestions() {
  return pending.map((q) => ({
    customId: q.customId || `cm:${Math.random().toString(36).slice(2,7)}`,
    system prompt, 
    prompt: (q.question||'') + ' ' + (q.explanation||''), 
    model: config.model || DEFAULT_MODEL || 'claude-3-haiku-20240307', 
    maxTokens: 64, // Just classify skill type
  }));
}


async function processPending() {
  const items = createClassificationQuestions();
  console.log(`Classifying ${items.length} pending questions...\n`);

  if (await batchSupported()) {
    console.log('Using Anthropic Batches API for cost efficiency.\n');
    
    // Submit batch with exponential backoff retry logic built into awaitBatch()  
    const batchId = await submitBatch(items, { creds }); 
    console.log(`Batch submitted: ${batchId}\n`);
    
    // Poll results (takes minutes due to async processing)
    const batchRecord = await awaitBatch(batchId, { 
      creds, 
      pollMs: 15000, 
      timeoutMs: 60 * 60 * 1000, // 1 hour
      onTick: (requestsProcessed) => console.log(`Requests processed: ${JSON.stringify(requestsProcessed)})`),
    });

    // Fetch results from finished batch
    const results = await fetchBatchResults(batchRecord); 
    
    // Write classified questions to output directory  
    for (const [customId, result] of results.entries()) { 
      if (result.error) { 
        console.log(`  ✗ ${customId}: ${result.error}`);
        continue; 
      }
