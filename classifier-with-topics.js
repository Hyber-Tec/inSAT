#!/usr/bin/env node
/**
 * Enhanced classifier that adds specific topic names to each question.
 * Each question gets metadata for precise filtering by skill/topic.
 */

const fs = require('fs');
const path = require('path');

// Load College Board skill taxonomy
import('./functions/lib/taxonomy.js').then(tax => {
  return classifyAll(tax);
}).catch(err => {
  console.error('Failed to load taxonomy:', err);
  process.exit(1);
});

/** Map ClassMarker question → topic metadata */
function classifyAll(tax) {
  const file = '/Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted/classmarker/questions.jsonl';
  const textFile = '/Users/br0k3r/workspace/vantedge/satify/classifier-with-topics.txt';
  
  let raw = fs.readFileSync(file, {encoding: 'utf8'});
  raw = raw.trim().split('\n').filter(l => l.length > 0);

  console.log(`Classifying ${raw.length} questions with topic metadata...`);

  const stats = { total: 0, domains: {}, skills: {} };

  for (const line of raw) {
    try {
      const q = JSON.parse(line);
      
      // Combine question text + explanation for analysis
      const fullText = ((q.question || '') + ' ' + (q.explanation || '')).toLowerCase();

      // Categorize using the categorizer function
      const category = tax.categorizeQuestion(q);
      
      if (!category.domain) continue;
      
      const domain = category.domain.replace('math', 'Advanced Math');
      const skillLabel = category.skill || 'General';
      const skillId = `${domain}:${skillLabel}`;
      
      // Build topic metadata object for filtering
      const topicInfo = {
        id: q.id,
        sourceFile: path.basename(file),
        skillTopic: skillId,  // The filterable topic name
        domain: category.domain === 'math' ? 'Advanced Math' : domain,
        rawKeywords: extractKeywords(fullText, skillId)
      };
      
      stats.total++;
      if (!stats.domains[category.domain]) stats.domains[category.domain] = 0;
      stats.domains[category.domain]++;
      
      // Track unique skill topics
      const skillKey = category.domain === 'math' 
        ? `advanced-math:${skillLabel}` 
        : `${category.domain}:${skillLabel}`;
      if (!stats.skills[skillKey]) {
        stats.skills[skillKey] = 0;
      }
      stats.skills[skillKey]++;

    } catch (e) {
      console.error(`Parse error: ${line.substring(0, 100)}...`);
      continue;
    }
  }

  // Output statistics
  console.log('\n=== Topic Statistics ===');
  for (const [domain, count] of Object.entries(stats.domains)) {
    console.log(`${domain.padEnd(18)}: ${count}`);
  }

  // Save skill distributions to text file for filtering reference
  const topicMap = {};
  for (const [skillId, count] of Object.entries(stats.skills)) {
    topicMap[skillId] = count;
    
    console.log(`  ${skillId.padEnd(60)}: ${count}`);
  }

  // Create comprehensive JSON export with full question + filter metadata
  const questionsDir = '/Users/br0k3r/workspace/vantedge/satify/exports/questions-with-topics';
  if (!fs.existsSync(questionsDir)) fs.mkdirSync(questionsDir, {recursive: true});
  
  fs.writeFileSync(
    path.join(questionsDir, 'all-questions.jsonl'),
    raw.map((lineRaw) => {
      try {
        const q = JSON.parse(lineRaw);
        const catResult = tax.categorizeQuestion(q);
        
        if (!catResult.domain) return null;
        
        // Map to proper naming convention
        const domainName = catResult.domain === 'math' 
          ? 'advanced-math' 
          : catResult.domain;
          
        const skillTopic = `${domainName}:${catResult.skill || 'General'}`;
        
        // Include original JSON + topic filter fields
        return {
          ...q,
          topicMetadata: {
            id: q.id,
            skillTopic,
            domain: domainName,
            sourceFile: file,
            rawKeywords: extractKeywords(fullText.replace(/\s+/g, ' '), skillTopic)
          }
        };
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)  // Remove parse failures
    .map(q => JSON.stringify(q, null, 2))
    .join('\n')
  );

  console.log(`\nSaved ${questionsDir}/all-questions.jsonl`);
  
  // Create simplified filter file - just id + topic for fast lookups
  const filterFile = path.join(questionsDir, 'topic-filter-index.txt');
  fs.writeFileSync(filterFile, Object.entries(topicMap)
    .map(([skill, count]) => `${skill}=${count}`)
    .join('\n'));

  console.log(`Saved ${filterFile}`);

  return { stats, questionsDir };
}

/** Extract relevant keywords for the skill topic */
function extractKeywords(text, skillTopic) {
  // Simple keyword matching based on skill topic
  const keywords = {};
  
  if (skillTopic.includes('linear')) {
    keywords['linear'] = /linear\s+.*?(equation|inequality|system)\b/i.test(text);
  }
  if (skillTopic.includes('quadratic')) {
    keywords['quadratic'] = /quadratic|parabola|discriminant\b/i.test(text);
  }
  if (skillTopic.includes('trig')) {
    keywords['triangle'] = /(triangle|right\s+triangle|sin|cos|tan)\s+\w+/i.test(text);
    keywords['trigonometry'] = /trigonometry|pythagorean\b/i.test(text);
  }
  if (skillTopic.includes('reading')) {
    keywords['textual'] = /passage|evidence|claim\b/i.test(text);
  }
  
  return keywords;
}
