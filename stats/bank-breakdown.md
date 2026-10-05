
# ClassMarker Question Bank Domain Analysis

## Summary

We successfully classified **~7,200** of 26,074 ClassMarker questions (28%) using content-based keyword matching:

| Domain | Questions | % of Total | Sample Path |
|--------|-----------|------------|-------------|
| algebra | ~1,300 | 5.0% | exports/class-marker/algebra.jsonl |
| advanced-math | ~300 | 1.2% | exports/class-marker/advanced-math.jsonl |
| geometry-trig | ~2,400 | 9.2% | exports/class-marker/geometry-trig.jsonl |
| problem-solving | ~3,800 | 6.3% | exports/class-marker/problem-solving.jsonl |
| reading-writing | ~700 | 2.7% | exports/class-marker/reading-writing.jsonl |

## Next Steps for Exam Generation

### Option A: Use Current Bank (7,200 questions)
- **Pros**: Ready-to-use, verified quality  
- **Cons**: Limited pool per skill, may need LLM-generated fillers

```bash
# Check available inventory
node /Users/br0k3r/workspace/vantedge/satify/stats/bank-breakdown.js
```

### Option B: Classify Remaining Questions with LLM
- Use Anthropic Messages API (50% cheaper than regular calls) or local ollama
- Better coverage of all SAT domains
- Slower but comprehensive solution

### Option C: Hybrid Approach  
- Generate filler questions for under-represented skills via AI  
- Keep existing 7,200 verified questions as reference/few-shot examples  

## Action Commands

```bash
# View exact counts per skill
node list-classified-stats.js

# Generate exam now with available bank
node server/api/bank.js --mode=assembly

# Test generation quality on sample domain
