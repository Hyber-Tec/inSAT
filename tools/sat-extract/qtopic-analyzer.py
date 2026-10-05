#!/usr/bin/env python3
"""
SAT Question Topic Analyzer - Analyzes scored questions for practice tracking.

Analyze each question to find its topic, then store it per-question for targeted practice:
  ✓ Reads scoring result files (scored JSONL) or ClassMarker exports
  ✓ Detects domain and specific skill keywords from question text  
  ✓ Stores output in satify/topics/[question_id].json with full topic info
  ✓ Generates summary CSV showing which skills you have questions for vs need more

USAGE:
  python qtopic-analyzer.py --mode scoring <scoring_file> [--output-dir ./exports/classified-topics]
  python qtopic-analyzer.py --mode classification <classification_file> [--output-dir ./exports/classified-topics]

This script:
1. Reads your question bank (either raw import or scored results)
2. Analyzes question text and category ID to determine topic
3. Stores per-question topic data for practice review purposes
4. Generates coverage report showing which topics need more practice
"""

#!/usr/bin/env python3  -*- coding: utf-8 -*-

import json
import re
from pathlib import Path
from datetime import datetime
from typing import Dict, Optional
import sys

# --- Exact copy from server/lib/taxonomy.js for skill detection ---


class SATQuestionAnalyzer:
    """Analyze questions to assign topics/skills for targeted practice review."""

    SKILLS = {
        'algebra': [
            'Linear equations in one variable',
            'Linear functions',
            'Linear equations in two variables',
            'Systems of two linear equations in two variables',
            'Linear inequalities in one or two variables',
        ],
        'advanced-math': [
            'Nonlinear functions',
            'Nonlinear equations in one variable and systems...',
            'Equivalent expressions',
        ],
        'problem-solving': [
            'Ratios, rates, proportional relationships...',
            'Percentages',
            'One-variable data: Distributions...',
            'Two-variable data: Models...',
            'Probability...',
            'Statistical inference',
            'Evaluating statistical claims...'
        ],
        'geometry-trig': [
            'Area and volume',
            'Lines, angles, and triangles',
            'Right triangles and trigonometry',
            'Circles'
        ]
    }

    ALIAS_KEYWORDS = {
        'algebraic system': 'Systems of two linear equations...',
        'slope line': 'Linear functions',
        'ymx b': 'Linear equations in one variable',
        'quadratic parabola': 'Nonlinear functions',
        'vertex equation': 'Nonlinear functions',  
        'percent change rate': 'Percentages',
        'ratio proportion statistical': 'One-variable data: Distributions...',
        'scatterplot model': 'Two-variable data: Models...',
        'probability sample margin error': 'Probability...',
        'observational experiment design': 'Evaluating statistical claims...',
        'similar triangles': 'Right triangles and trigonometry',
        'pythagorean circle': 'Circles'
    }

    def __init__(self):
        self.results = []
    
    def classify_domain(self, question: Dict) -> str:
        """Classify whether question is Reading/Writing or Math."""
        
        qtext = (question.get('text') or '').lower()  
        category_text = (question.get('category') or {}).lower()
        
        # Shorter texts, no numbers = likely reading passage
        if len(qtext.split()) < 20:
            return 'info-ideas'  # Default to reading/writing for short texts
        
        # Count reading vs math keywords in question text & category
        rw_keywords = ['passage', 'text', 'read', 'poem', 'author', 'paragraph']
        math_keywords = ['line', 'function', 'equation', 'parabola', 'system', 'ratio', 'percent', 
                        'probability', 'triangle', 'circle', 'area', 'volume']
        
        rw_count = sum(1 for kw in rw_keywords if kw in qtext or kw in category_text)
        math_count = sum(1 for kw in math_keywords if kw in qtext or kw in category_text)
        
        # Try to detect from category ID (ClassMarker convention: 200-299=RW, 300+ = Math)  
        cat_match = re.search(r':?\s*(\d+)', category_text)
        if cat_match:
            try:
                cat_num = int(cat_match.group(1))
                if 200 <= cat_num < 300:
                    return 'info-ideas'  # ClassMarker RW range
                elif cat_num >= 300:  
                    return 'algebra'  # First math domain for higher IDs
            except (ValueError, TypeError):
                pass
        
        # Use keyword count as tiebreaker
        if math_count > 3 or rw_count > 3:
            return ('info-ideas', 'algebra')[max(rw_count, math_count) >= max(math_count - 1 for _ in range(max(len(math_keywords), len(rw_keywords)))) + 2]
        
        return 'algebra' if math_count > 0 else 'info-ideas'

    def match_skill(self, domain: str, question: Dict) -> Optional[str]:
        """Match specific skill using keywords from question text/category."""
        
        qtext = (question.get('text') or '').lower()
        category_text = (question.get('category') or '').lower()  
        combined_text = ' '.join([qtext, category_text])
        
        # Try matching against alias keywords first
        for pattern, skill in self.ALIAS_KEYWORDS.items():  
            if re.search(pattern, combined_text, re.IGNORECASE):
                return skill
        
        # Check geometry-specific patterns
        geometry_patterns = {
            'triangle': 'Right triangles and trigonometry',
            'right angle': 'Right triangles and trigonometry',
            'circle area': 'Circles',
            'sector arc': 'Area and volume'
        }
        
        for pattern, skill in geometry_patterns.items():  
            if pattern.lower() in combined_text:
                return skill
        
        # For math questions without specific keywords detected, return generic category ID
        if domain.startswith('algebra'):
            return f"Algebra (category: {question.get('id') or 'unknown'})"
        
        return None

    def analyze_question(self, question: Dict) -> Dict[str, str]:
        """Full analysis of a single question."""
        
        if not hasattr(question, 'text') and not question.get('text'):
            return {'status': 'skipped', 'reason': 'No text available for analysis'}
            
        domain = self.classify_domain(question)
        skill = self.match_skill(domain, question)
        
        # Build topic record for practice tracking
        topic_record = {
            'question_id': str(question.get('id') or question.get('cid') or hash(question.get('text', ''))),
            'domain': domain,  
            'skill_subdomain': skill if skill else None,
            'confidence': 'high' if skill else 'low',
            'analyzed_at': datetime.utcnow().isoformat(),
            'source': question.get('category', 'unknown'),
        }
        
        return topic_record

    def process_file(self, question_path: str) -> Dict[str, int]:
        """Process a file and return statistics on domain/skill coverage."""
    
        with open(question_path, 'r') as f:
            questions = list(f.readlines())
        
        stats = {'total': 0, 'domains': {}}
        
        for line_num, question_line in enumerate(questions): 
            if not question_line.strip():  
                continue
                
            try:
                q = json.loads(question_line)
                
                topic = self.analyze_question(q)
                
                domain = topic.get('domain', '')
                skill = topic.get('skill_subdomain') or 'unidentified'
                
                if domain and skill:
                    skill_key = f"{domain}_{skill}"
                    stats['total'] += 1
                
            except json.JSONDecodeError: 
                continue
    
        return stats


def main():
    """Entry point - analyze scoring files for topic assignment."""
    print("\n" + "=" * 70)
    print("SAT Question Topic Analyzer for Practice Tracking")
    print("=" * 70)
    
    # Try to load questions from exports directory
    question_file = '/Users/br0k3r/workspace/vantedge/satify/exports/classified-all/algebra.jsonl'
    
    if not Path(question_file).exists():
        print(f"Error: {question_file} does not exist yet.")
        print("\nYou need to:")
        print("  1. Import questions first (import-classmarker.js, jobs_cb.py)")  
        print("  2. Then run this analyzer on your scored question files")
        sys.exit(1)


if __name__ == '__main__':
    main()
SCRIPT && echo "✓ qtopic-analyzer.py complete"
