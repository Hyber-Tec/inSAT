#!/usr/bin/env node
const fs = require('fs'), path = require('path');

console.log('SAT Topic Enhancement Script\n\n');

import('./server/lib/taxonomy.js').then(tax => {
  const domains = [
    '/Users/br0k3r/workspace/vantedge/satify/exports/classified-all/algebra.jsonl',
    '/Users/br0k3r/workspace/vantedge/satify/exports/classified-all/geometry-trig.jsonl',
    '/Users/br0k3r/workspace/vantedge/satify/exports/classified-all/problem-solving.jsonl',
    '/Users/br0k3r/workspace/vantedge/satify/exports/classified-all/advanced-math.jsonl',
    '/Users/br0k3r/workspace/vantedge/satify/exports/classified-all/reading-writing.jsonl'
  ];

  const OUTPUT_DIR = '/Users/br0k3r/workspace/vantedge/satify/exports/enhanced-topics';
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, {recursive: true});

  for (const domainFile of domains) {
    console.log('Processing:', path.basename(domainFile));
    
    const inputLines = fs.readFileSync(domainFile, 'utf8').trim().split('\n').filter(l => l.length > 0);
    const enhancedLines = [];

    for (const line of inputLines) {
      try {
        const q = JSON.parse(line);
        const qId = q.id || `unknown`;
        
        if (!q.question && !q.explanation) {
          enhancedLines.push(line); // Keep simple records
          continue;
        }

        let subTopic = '';
        const fullText = (q.question || '') + ' ' + (q.explanation || '').toLowerCase();

        if ('algebra' === domainFile) {
          if (/linear\s+.*?(equation|inequality)\b/i.test(fullText)) subTopic = 'Linear Equations';
          else if (/x^2|quadratic\b/i.test(fullText)) subTopic = 'Quadratic Functions';
        }

        enhancedLines.push(JSON.stringify({
          ...q,
          id: qId,
          skill: subTopic || domainFile.split('/').pop().replace('.jsonl', ''),
          topicFilter: subTopic || 'general-' + domainFile.split('/').pop().replace('.jsonl', '')
        }));

      } catch (e) { enhancedLines.push(line); }
    }

    const outPath = OUTPUT_DIR + '/' + path.basename(domainFile).replace('.jsonl', '');
    fs.writeFileSync(outPath, enhancedLines.join('\n') + '\n');
  }

  // Combine into master file
  const MASTER = OUTPUT_DIR + '/master.jsonl';
  for (const domainFile of domains) {
    try {
      const content = fs.readFileSync(domainFile, 'utf8').trim().split('\n').filter(l => l);
      const enhancedLines = content.map(line => {
        const q = JSON.parse(line);
        if (!q.question && !q.explanation) return line;
        
        let subTopic = '';
        const fullText = (q.question || '') + ' ' + (q.explanation || '').toLowerCase();

        if (/algebra$/.test(path.basename(domainFile))) {
          if (/linear\s+.*?(equation|inequality)\b/i.test(fullText)) subTopic = 'Linear Equations';
          else if (/x^2|quadratic\b/i.test(fullText)) subTopic = 'Quadratic Functions';
        }

        return JSON.stringify({
          ...q,
          id: q.id || `unknown`,
          skill: subTopic || (domainFile.split('/').pop().replace('.jsonl', '') + '-general'),
          topicFilter: domainFile.split('/').pop()
        });
      });
      fs.appendFileSync(MASTER, enhancedLines.join('\n') + '\n');
    } catch(e) {}
  }

  console.log('\nEnhanced output saved to:', OUTPUT_DIR);
  console.log('Master file:', MASTER);

}).catch(err => {
  console.error('Taxonomy load failed:', err.message);
});
