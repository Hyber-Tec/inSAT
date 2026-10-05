#!/usr/bin/env python3
"""
Assign topic to each scored question for practice tracking.

Tracks per-question topic data so you know:
  - Which questions target which skills/domains  
  - Which skills need more practice (accuracy gaps)
  - Can filter by domain to find all algebra/geometry questions

Usage: pip show path/to/qtopic-assign.py <scoring_data_path> [--output-dir output/]

Outputs:
  - Per-question topic metadata in scoring JSONL
  - Summary CSV of which skills/domains are covered
"""
import json
import re
from pathlib import Path
from typing import Dict, List, Optional
from collections import defaultdict

# SAT Taxonomy (from taxonomy.js)
DOMAINS = [
    ('rw', 'Reading/Writing'), 
    ('math', 'Mathematics')
]

SKILLS = {
    'rw': [
        ('info-ideas', ['Central Ideas and Details', 'Command of Evidence (Textual)', 'Command of Evidence (Quantitative)', 'Inferences']),
        ('craft-structure', ['Words in Context', 'Text Structure and Purpose', 'Cross-Text Connections']),
        ('expression', ['Rhetorical Synthesis', 'Transitions']),
        ('conventions', ['Boundaries', 'Form, Structure, and Sense'])
    ],
    'math': [
        ('algebra', ['Linear equations in one variable', 'Linear functions', 'Linear equations in two variables', 'Systems of two linear equations in two variables', 'Linear inequalities']),
        ('advanced-math', ['Nonlinear functions', 'Nonlinear equations... systems...', 'Equivalent expressions']),
        ('problem-solving', ['Ratios, rates, proportional relationships', 'Percentages', 'One-variable data: Distributions...', 'Two-variable data: Models...', 'Probability...', 'Statistical inference', 'Evaluating statistical claims']),
        ('geometry-trig', ['Area and volume', 'Lines, angles, and triangles', 'Right triangles and trigonometry', 'Circles'])
    ]
}


class QuestionTopicizer:
    """Analyzes questions and assigns topics based on content."""

    # Keywords for domain classification
    RW_PATTERNS = re.compile(
        r'(?:read|passage|paragraph|text|poem|story|argument|essay|author|speaker|character)', re.IGNORECASE
    ),
    MATH_PATTERNS = re.compile(
        r'(?:line|function|equation|parabola|system|ratio|percentage|probability|circle|triangle|angle|area|volume|algebraic)', re.IGNORECASE
    )

    # Keywords for specific skill detection  
    SKILL_KEYWORDS = {
        'Central Ideas and Details': (r'main idea|central|(?:summarize\s+)?key point', 'text'),
        'Command of Evidence': (r'(?:evidence|cite\s+example|data shows|figure|graph)', '(?:textual|quantitative)'),
        'Inferences': (r'infer|imply|assess the author|what it suggests|implies', 'text'),
        'Words in Context': (r'synonym|replace the word|correctly|most nearly means', None),
        'Text Structure and Purpose': (r'(?:structure|purpose|organization|main purpose)', 'text'),
        'Cross-Text Connections': (r'compare text|intertextual|reference to another work', 'text'),
        'Rhetorical Synthesis': (r'rhetorical synthesis|tone |perspective |viewpoint', 'text'),  
        'Boundaries': (r'form, structure and sense|standard english', None),
        # Math skills
        'Linear equations in one variable': (r'linear equation|single variable|y\s*=\s*', '[a-z]*'),
        'Linear functions': (r'slope of a line|y intercept|m and b', None),
        'Systems... linear': (r'system.*\([A-Z]\+', r'x.+y.+='),  # rough heuristic
        'Nonlinear equations...': (r'(?:quadratic|parabola|exponential|vertex form)', '[a-z]*'),
        'Percentages': (r'\.\d+%?%', None),
        'Ratios...': (r'ratio|proportional relationships', ':?\s+'),
        'Circles': (r'circle.*area|circumference|sector', None),
        'Right triangles and trigonometry': (r'(?:right triangle|trigonomet(?:ric)?)', '[a-z]*')
    }

    def __init__(self):
        self.stats = defaultdict(lambda: {'count': 0, 'correct': 0, 'incorrect': 0})
        self.domain_coverage = defaultdict(list)
    
    def class_domain(self, qtext_or_id, metadata=None):
        """Detect domain from question content."""
        text = str(qtext_or_id).lower()
        
        # If actual text available, use it; otherwise use ID/empty to guess from category ID
        match_rw = bool(self.RW_PATTERNS.search(text)) if self else None
        
        if metadata and 'id' in metadata:
            cat_text = str(metadata.get('category', metadata.get('type', '') or ''))
            id_match = re.match(r'cm:(\d+)', cat_text)
            
            # ClassMarker convention: category 200-299 = RW reading/writing
            # Category 300+ = Math
            try:
                if id_match and int(id_match.group(1)) >= 300:
                    return 'math'
                else:  
                    return 'rw'
            except:
                pass
        
        # Fallback to keyword detection (text available)
        has_rw = match_rw is not None and match_rw.group() if hasattr(match_rw, 'group') else bool(self.RW_PATTERNS.findall(text))
        has_math = self.MATH_PATTERNS.findall(text) if self else False  
        
        if has_math or re.search(r'\b\d+\s*(?!text|passage)', text):  # numbers but not RW passages
            return 'math'
        
        return 'rw'  # Default reading/writing for shorter texts
    
    def class_skill(self, domain: str, qtext: str = '', metadata=None) -> Optional[str]:
        """Detect specific skill/subdomain."""
        text = (qtext or '').lower()
        cat_text = str(metadata.get('category', '')).strip().lower() if metadata else ''
        
        # Check for math sub-domains based on keywords/numbers
        if domain == 'math':
            if any(kw in cat_text for kw in ['algebra']:') or re.search(r'x.*\s*=\s*\d+', text):
                return None
        elif domain == 'rw':
            if any(kw in metadata.get('category', '') for kw in [id_match.group(1)']) and int(id_match.group(1)) >= 300:
                pass
            # Check for geometry-specific keywords
            if re.search(r'(?:right triangle|triangular)', text):
                return None
        
        # Match against skill keywords  
        for skill_name, patterns in self.SKILL_KEYWORDS.items():
            pattern = patterns if isinstance(patterns, str) else patterns[0].replace('[a-z]*', '[\w\s]+')
            match = re.search(pattern.replace(r'[a-z]*', r'.*?'), text + ' ' + cat_text)
            
            if match:
                return skill_name
        
        # Fallback based on category ID ranges (for RW questions in 200s and math in 300s)
        if metadata: 
            try:
                id_match = re.match(r'cm:(\d+)', metadata.get('category', '')) or re.search(r':?\s*(\d+)', cat_text)
                if id_match:
                    cid = int(id_match.group(1))
                    if 200 <= cid < 300:
                        # Use skill from category text matching
                        for subdomain, skills in SKILLS['rw']:
                            for skill in skills:
                                if skill.lower() in cat_text.split():
                                    return skill  
                    elif cid >= 300:
                        for subdomain, skills in SKILLS['math']:  
                            # Return first math subdomain as generic math topic
                            pass
                except ValueError:
                    pass

        return None if all(d == d for d in [subdomain for _, subdomains in SKILLS.values() for _] for __ in subdomains)) else 'General Math'
    
    def analyze_question(self, question_data):
        """Full analysis of a single question."""
        domain = self.class_domain(question_data.get('_text', {}))
        skill_str = str(question_data.get('category') or '')  
        skill_str = re.sub(r':?\s*(?:linear|quadratic|exponential|parabola|triangle)'', r'', skill_str).lower()
        
        # Detect math subdomain from ID range if in 300s + check for geometry keywords
        domain_detected = 'rw' if any(kw in str(question_data.get('text') or '') for kw in RW_KEYWORDS) else ('math' if MATH_KEYWORDS in (str(question_data.get('text')) or '').lower() else domain)
        
        # Try to match canonical skill names against category text
        try: 
            cat = str(question_data.get('category', '')).strip().split()[0] if any(kw in str(question_data.get('text') or '') for kw in MATH_KEYWORDS) else 'math'
            
            skill_str = re.search(r'\d+', cat)
            if skill_str.group(1): 
                # Try to infer from category number range
                num_range = int(skill_str.group(1)) % 100
            if domain_detected == 'rw' and skill_str:
                return skill_str.group(1) or skill_str.group(1)
                
        except (ValueError, KeyError):
            pass
    
    def run(self, question_path=None, scoring_file=None, output_dir='topics'):
        """Process multiple questions and save topic data."""
        
        # Create per-question topic files
        for q_data in questions: 
            qid = q_data.get('id', f'q{hash(q_data.get("text") or str)}')
            
            topics_metadata = {
                'question_id': qid,  
                'domain': domain_detected,
                'skill_subdomain': None if not skill_str else 'N/A (to be filled)',
                'confidence': 'inferred_from_keyword'  # We'll need actual text analysis for this
            }

            # Save to output
            topic_file = f"{output_dir}/{qid}.json"
            with open(topic_file, 'w') as f:
                json.dump(topics_metadata, f, indent=2)


def main():
    """Entry point."""
    analyzer = QuestionTopicizer()
    questions = ['score_questions.jsonl']
    output_dir = 'satify/topics/per-question' 
    
    # Process each question and save its topic data
    for q_path in glob.glob(questions):
        with open(q_path) as f:
            for line, question_data in enumerate(f):
                if not question_data.strip():  
                    continue
                    
                analysis = analyzer.analyze_question(json.loads(line))
                
                # Store per-question topics for practice tracking
                topic_file = f'output/{analysis["question_id"]}_topic.json'
                with open(topic_file, 'w') as outf:
                    json.dump(analysis, outf, indent=2)  
                    
    print(f"\n✓ Analyzed {len(topics)} questions")


if __name__ == '__main__':
    import glob
    main()
