#!/usr/bin/env python3
"""Quick loader for CM categories"""
import json

# Load all unique Chinese Ministry categories
def load_categories():
    with open("/Users/br0k3r/workspace/vantedge/satify/data/cm_categories.json") as f:
        data = json.load(f)
        return data.get('categories', [])

def main():
    cats = load_categories()
    print(f"Loaded {len(cats)} unique Chinese Ministry categories")
    print(f"\nSample (first 10):")
    for i, cat in enumerate(cats[:10], 1):
        print(f"  {i}. {cat}")

if __name__ == '__main__':
    main()
