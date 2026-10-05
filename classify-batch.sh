#!/bin/bash
# Classify questions by skill into exports class-marker folder

INPUT="/Users/br0k3r/workspace/vantedge/satify/private-data/SAT/extracted/classmarker/questions.jsonl"
DEST="/Users/br0k3r/workspace/vantedge/satify/exports/class-marker"

mkdir -p "$DEST"

# Read file line by line and classify each question
while IFS= read -r line || [ -n "$line" ]; do
    # Skip empty lines
    [ -z "$(echo "$line" | tr -d '[:space:]')" ] && continue
    
    # Classify using node classification logic inline
    output=$(echo "$line" | node -e "
      const input = Deno.readTextSync(Deno.cwd() + '/dev/stdin');
      try { q = JSON.parse(input) } catch(e) { console.error('Parse error', e.message); process.exit(1) };
      
      let t = (q.question || '') + ' ' + (q.explanation || '').toLowerCase();
      
      if (/interacts.*underlined.*sentence|passage|character/.test(t)) { print('RW'); exit };
      if (/triangle[^s]|volume|congruent|circle|similar/.test(t)) { print('geometry-trig'); exit };
      if (/linear.*equation|inequality|system.*equation|slope/.test(t)) { print('algebra'); exit };
      if (/quadratic|^parabola|discriminant|exponential|logarithm/.test(t)) { print('advanced-math'); exit };
      if (/ratio|percentage|mean|median|probability|scatterplot/.test(t)) { print('problem-solving'); exit };
      print('math');
    ")
    
    # Write to categorized output file 
    echo "$line" >> "$DEST/cm-${output:-unknown}.txt"
done < "$INPUT"

# Show results
echo "Classification complete!"
ls -lh exports/class-marker/
cat exports/class-marker/*.txt | wc -l
