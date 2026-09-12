"""Regenerate OVOS-compatible CLDR matching tables: pip install langcodes==3.5.1.
Data/code upstream: https://github.com/rspeer/langcodes/tree/v3.5.1 (MIT).
"""
import json
from importlib.metadata import distribution, version
from pathlib import Path
import langcodes.data_dicts as data
import langcodes.language_distance as distance

assert version('langcodes') == '3.5.1', 'Use langcodes==3.5.1'
result = {
    'likely': data.LIKELY_SUBTAGS, 'languages': data.LANGUAGE_REPLACEMENTS,
    'scripts': data.SCRIPT_REPLACEMENTS, 'territories': data.TERRITORY_REPLACEMENTS,
    'default_scripts': data.DEFAULT_SCRIPTS, 'macrolanguages': data.NORMALIZED_MACROLANGUAGES,
    'distances': distance.LANGUAGE_DISTANCES,
    'regions': {key: sorted(getattr(distance, key)) for key in ['US', 'AMERICAS', 'LATIN_AMERICA', 'MAGHREB', 'CNSAR']},
}
Path('src/language-matching-data.ts').write_text(
    '// Generated from langcodes 3.5.1 by scripts/sync-language-matching.py.\n'
    '// MIT; see LICENSE-langcodes. Do not hand-edit CLDR tables.\n'
    'export const matchingData: {likely: Record<string,string>; languages: Record<string,string>; scripts: Record<string,string>; territories: Record<string,string>; default_scripts: Record<string,string>; macrolanguages: Record<string,string>; distances: Record<string,Record<string,number>>; regions: Record<string,string[]>} = '
    + json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + ';\n', encoding='utf-8')
Path('LICENSE-langcodes').write_text(distribution('langcodes').read_text('licenses/LICENSE.txt'), encoding='utf-8')
