/**
 * JSONL parser for ClassMarker exports - each line is complete JSON
 */
import fs from 'fs';

export function loadJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }
  
  const lines = fs.readFileSync(filePath).toString().trim().split('\n');
  
  // Each line in ClassMarker JSONL is complete JSON - parse directly
  return lines
    .map(line => {
      if (!line.trim()) return null;
      try {
        return JSON.parse(line);
      } catch (err) {
        console.warn(`Skipping parse error: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

export default loadJsonlFile;
