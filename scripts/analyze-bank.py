#!/usr/bin/env python3
"""Analyze and categorize the question bank by topic domain."""

import json, glob as globs, sys, math
from pathlib import Path

# SAT Domains and Skills (mirror of server/lib/taxonomy.js)
DOMAINS = {
    'rw': ['info-ideas', 'craft-structure', 'expression', 'conventions'],
    'math': ['algebra', 'advanced-math', 'problem-solving', 'geometry-trig']
}

SKILLS = {
    'algebra': [
        'Linear equations in one variable',
        'Linear functions', 
        'Linear equations in two variables',
        'Systems of two linear equations in two variables',
        'Linear inequalities in one or two variables'
    ],
    'advanced-math': [
        'Nonlinear functions',
        'Nonlinear equations in one variable and systems of equations in two variables',
        'Equivalent expressions'
    ],
    'problem-solving': [
        'Ratios, rates, proportional relationships, and units',
        'Percentages',
        'One-variable data: Distributions and measures of center and spread',
        'Two-variable data: Models and scatterplots',
        'Probability and conditional probability'
    ],
    'geometry-trig': [
        'Area and volume',
        'Lines, angles, and triangles',  
        'Right triangles and trigonometry',
        'Circles'
    ]
}

def map_category_to_domain(cat):
    """Map ClassMarker category ID to SAT domain/skill."""
    cat = str(cat) if cat is not None else ''
    cat_lower = cat.lower()
    
    # Reading/Writing categories (roughly 211-238 range)
    if 'rw' in cat_lower or 'reading' in cat_lower or 'writing' in cat_lower:
        if 'ideas' in cat_lower:
            return 'info-ideas'
        elif 'structure' in cat_lower or 'text' in cat_lower:
            return 'craft-structure'
        elif 'expression' in cat_lower or 'tone' in cat_lower:
            return 'expression'
        elif 'convention' in cat_lower or 'grammar' in cat_lower:
            return 'conventions'
    
    # Math categories by keyword patterns
    if 'algebra' in cat_lower:
        return 'algebra'
    elif 'line' in cat_lower and 'equation' not in cat_lower:
        return 'algebra'  # likely linear equations
    elif 'system' in cat_lower:
        return 'algebra'
    elif 'quadratic' in cat_lower or 'parabola' in cat_lower or 'vertex' in cat_lower:
        return 'advanced-math'
    elif 'nonlinear' in cat_lower or 'exponential' in cat_lower or 'logarithm' in cat_lower:
        return 'advanced-math'
    elif 'equivalent' in cat_lower or 'factor' in cat_lower or 'expand' in cat_lower:
        return 'advanced-math'
    elif 'percent' in cat_lower or 'ratio' in cat_lower or 'proportion' in cat_lower:
        return 'problem-solving'
    elif 'data' in cat_lower or 'distribution' in cat_lower or 'scatterplot' in cat_lower:
        return 'problem-solving'
    elif 'probability' in cat_lower or 'expected' in cat_lower:
        return 'problem-solving'
    elif 'geometry' in cat_lower or 'area' in cat_lower or 'volume' in cat_lower:
        return 'geometry-trig'
    elif 'triangle' in cat_lower or 'sine' in cat_lower or 'cosine' in cat_lower:
        return 'geometry-trig'
    elif 'circle' in cat_lower:
        return 'geometry-trig'
    elif 'arc' in cat_lower or 'sector' in cat_lower:
        return 'geometry-trig'
    
    # If we can't map, try numeric category (ClassMarker uses numbers)
    try:
        num = int(cat.split()[0])
        if 211 <= num < 215:
            return 'info-ideas'
        elif 215 <= num < 220:
            return 'craft-structure'
        elif 220 <= num < 238:
            return 'expression'
        elif 238 <= num < 241:
            return 'conventions'
        elif 226 <= num < 230 or (215 <= num < 225):
            return 'command-of-evidence'
        elif 229 <= num < 231:
            return 'transitions'
        elif 231 <= num <= 238:
            return 'synthesis'
    except ValueError:
        pass
    
    return 'unknown'

def analyze_questions(question_list):
    """Analyze a list of questions and categorize them."""
    stats = {
        'total': len(question_list),
        'domains': {},
        'samples_by_domain': {}
    }
    
    domain_count = 0
    
    for i, q in enumerate(question_list):
        cat = map_category_to_domain(q.get('category', ''))
        
        if cat not in stats['domains']:
            stats['stats'][cat] = {
                'count': 0,
                'samples': []
            }
        
        stats['stats'][cat]['count'] += 1
        
        # Sample up to 5 per domain
        if len(stats['stats'][cat]['samples']) == 0:
            stats['stats'][cat]['samples'].append({
                'question_id': i,
                'category': q.get('category'),
                'type': q.get('type', 'unknown')
            })
    
    return stats

def main():
    print("=" * 60)
    print("SAT Question Bank Analyzer")  
    print("=" * 60)
