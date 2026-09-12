/** OVOS-INTENT-2 distance policy, using langcodes 3.5.1 CLDR tables.
 * The tuple distance algorithm is adapted from langcodes (MIT; LICENSE-langcodes).
 */
import { matchingData as data } from './language-matching-data.js';
type Tag = {language: string; script?: string; region?: string; bare: boolean};
const get = <T>(map: Record<string,T>, key: string): T | undefined => Object.hasOwn(map,key) ? map[key] : undefined;
const title = (text: string): string => text[0].toUpperCase()+text.slice(1).toLowerCase();
function parse(value: string, aliases = true): Tag {
  value = value.trim().replaceAll('_','-').toLowerCase();
  if (aliases) value = get(data.languages,value)?.toLowerCase() ?? value;
  const tokens = value.split('-');
  const primary = tokens.shift() || 'und';
  const base = aliases && get(data.languages,primary) ? parse(get(data.languages,primary)!,false) : {language:primary,bare:true} as Tag;
  for (const token of tokens) {
    if (token.length === 1) break;
    if (/^[a-z]{4}$/.test(token)) base.script = get(data.scripts,token) ?? title(token);
    else if (/^(?:[a-z]{2}|[0-9]{3})$/.test(token)) base.region = get(data.territories,token) ?? token.toUpperCase();
  }
  // Canonical tags omit the default script. OVOS gives bare Portuguese its
  // norm region PT rather than CLDR's population-default BR.
  if (base.script === get(data.default_scripts,base.language)) base.script = undefined;
  base.bare = !base.script && !base.region && tokens.every(token => /^[a-z]{4}$/.test(token));
  if (base.language === 'pt' && base.bare) base.region = 'PT';
  return base;
}
function maximize(value: Tag): Required<Pick<Tag,'language'|'script'|'region'>> {
  if (value.language === 'und' && !value.script && !value.region) return {language:'und',script:'Zzzz',region:'ZZ'};
  value = {...value,language:get(data.macrolanguages,value.language) ?? value.language};
  const macro = get(data.macrolanguages,value.language);
  const languages = [value.language,...(macro ? [macro] : [])];
  const probes: string[] = [];
  for (const fields of [[true,true],[false,true],[true,false],[false,false]]) {
    for (const language of languages) probes.push([language,fields[0] ? value.script : undefined,fields[1] ? value.region : undefined].filter(Boolean).join('-'));
  }
  if (value.script) probes.push('und-'+value.script);
  probes.push('und');
  const found = probes.map(tag => get(data.likely,tag)).find(Boolean)!;
  const [language,script,region] = found.split('-');
  return {language:value.language === 'und' ? language : value.language,script:value.script ?? script,region:value.region ?? region};
}
function distance(wanted: string, candidate: string): number {
  const a=maximize(parse(wanted)), b=maximize(parse(candidate));
  const languageDistance = a.language === b.language ? 0 : get(get(data.distances,a.language) ?? {},b.language) ?? 80;
  const pairA=a.language+'_'+a.script, pairB=b.language+'_'+b.script;
  const scriptDistance = a.script === b.script ? 0 : get(get(data.distances,pairA) ?? {},pairB) ?? 50;
  if (a.region === b.region) return languageDistance+scriptDistance;
  let regionDistance=4;
  const inRegion = (group:string,region:string): boolean => data.regions[group].includes(region);
  if (pairA === pairB) {
    if (a.language === 'ar') {
      if (inRegion('MAGHREB',a.region) !== inRegion('MAGHREB',b.region)) regionDistance=5;
    } else if (a.language === 'en') {
      if ((a.region === 'GB' && !inRegion('US',b.region)) || (!inRegion('US',a.region) && b.region === 'GB')) regionDistance=3;
      else if (inRegion('US',a.region) !== inRegion('US',b.region)) regionDistance=5;
    } else if (inRegion('LATIN_AMERICA',a.region) && b.region === '419') regionDistance=1;
    else if (a.language === 'es' || a.language === 'pt') {
      if (inRegion('AMERICAS',a.region) !== inRegion('AMERICAS',b.region)) regionDistance=5;
    } else if (pairA === 'zh_Hant' && inRegion('CNSAR',a.region) !== inRegion('CNSAR',b.region)) regionDistance=5;
  }
  return languageDistance+scriptDistance+regionDistance;
}
/** Nearest OVOS-compatible language, with a maximum distance of ten.
 * Equal distances preserve registration order, including zero-distance ties.
 */
export function closestLanguage(target: string, available: readonly string[]): string | undefined {
  let best: string | undefined, minimum=Infinity;
  for (const candidate of available) {
    const value=distance(target,candidate);
    if (value < minimum) { best=candidate; minimum=value; }
  }
  return minimum <= 10 ? best : undefined;
}
