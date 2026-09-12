import assert from 'node:assert/strict';
import test from 'node:test';
import { asSentence, closestLanguage, HubIntent, ListingRules, speakable } from '../src/index.js';

test('regional registrations and omitted language keep the selected locale', () => {
  const intent = new HubIntent({skillId:'s',name:'n',engine:'padatious',phrases:{'fr-FR':['volume {level} pour cent'],'en-US':['volume {level} percent']}});
  assert.deepEqual(intent.phrasesFor('fr_CA'), ['volume {level} pour cent']);
  assert.deepEqual(intent.phrasesFor('de'), []);
  assert.deepEqual(intent.examples(undefined,2,{speakable:true}), ['volume cinquante pour cent']);
  assert.deepEqual(intent.examples(undefined,2,{sentence:true}), ['Volume cinquante pour cent.']);
  assert.deepEqual(intent.examples('en-GB',2,{sentence:true}), ['Volume fifty percent.']);
});

test('slot defaults are locale data and caller overrides win', () => {
  assert.equal(speakable('volume [to] {level} percent',{},'en-US'), 'volume fifty percent');
  assert.equal(speakable('weather in {location}',{location:'Sherbrooke'},'en'), 'weather in Sherbrooke');
  assert.equal(speakable('weather in {location}',{},'tlh'), 'weather in location');
  assert.equal(speakable('set the {gadget_name} going',{},'en'), 'set the gadget name going');
});

test('canonical language rules distinguish questions, commands and prefixes', () => {
  for (const phrase of ['quelle heure est-il','y a t il de la neige','ai je besoin d une veste',"qu'est-ce que tu sais faire",'il est quelle heure','on est quel mois','combien de jours avant noel','quand est la fete du Canada']) {
    assert.ok(asSentence(phrase,'fr-FR').endsWith('?'),phrase);
  }
  for (const phrase of ['prends rendez-vous avec le docteur',"oublie ce que j'ai dit",'coupe le son']) assert.ok(asSentence(phrase,'fr').endsWith('.'),phrase);
  assert.equal(asSentence('what did i ask you to do','en-US'), 'What did I ask you to do?');
  assert.equal(asSentence('forget what i said','en-US'), 'Forget what I said.');
  assert.equal(asSentence('tell me what happened','en-US'), 'Tell me what happened.');
  assert.equal(asSentence('quand est la fete du Canada','fr'), 'Quand est la fete du Canada?');
  assert.equal(asSentence('weather in Toronto','en'), 'Weather in Toronto.');
  assert.equal(asSentence('nuqneH','tlh'), 'NuqneH');
  assert.equal(asSentence('what time is it'), 'What time is it');
  assert.equal(asSentence('current conditions in','en'), 'Current conditions in');
  assert.equal(asSentence('quelles sont les conditions actuelles a','fr'), 'Quelles sont les conditions actuelles a');
  assert.equal(asSentence(asSentence('quelle heure est-il','fr'),'fr'), 'Quelle heure est-il?');
  assert.equal(asSentence('','fr'), '');
});

test('rank originals, retain complete phrases and count rendered unique results', () => {
  const listing = new ListingRules();
  const ranked = listing.rank(['aqi','air quality','weather in','what is the weather in {location}','what is the air quality like today'],'en-US');
  assert.deepEqual(ranked, ['what is the air quality like today','air quality','aqi','what is the weather in {location}','weather in']);
  const intent = new HubIntent({skillId:'s',name:'n',engine:'padatious',phrases:{'en-us':['[please]','(repeat|say) that (again|)','[please] repeat that','volume [to] {level} percent']}});
  assert.deepEqual(intent.examples('en-US',2,{speakable:true}), ['repeat that','volume fifty percent']);
  assert.deepEqual(intent.examples('en-US',2,{sentence:true}), ['Repeat that.','Volume fifty percent.']);
  assert.deepEqual(intent.examples('en-US',0,{sentence:true}), ['Repeat that.','Volume fifty percent.']);
  assert.deepEqual(intent.examples('fr',1,{sentence:true}), []);
  assert.deepEqual(intent.examples('en-US',0),intent.phrasesFor('en-US'));
});

test('custom data is a complete snapshot, supports optional rules and independent flags', () => {
  const data = {sentence_ends:'.!?',languages:{xq:{question_patterns:['(?i)^is it','(?m)^can it'],written_forms:{o:'O'},slot_examples:{thing:'the widget'}}}};
  const listing = new ListingRules(data);
  data.languages.xq.question_patterns[0]='never';
  data.languages.xq.slot_examples.thing='changed';
  assert.equal(listing.asSentence('is it ready','xq'),'Is it ready?');
  assert.equal(listing.asSentence('can it work','xq'),'Can it work?');
  assert.equal(listing.asSentence('go home','xq'),'Go home.');
  assert.equal(listing.asSentence('what time is it','en-US'),'What time is it');
  assert.equal(speakable('open {thing}',{},'xq-ZZ',listing),'open the widget');
  const returned = listing.languageData('xq');
  (returned.question_patterns as string[])[0]='broken';
  assert.equal(listing.asks('IS IT ready','xq'),true);
  const anywhere = new ListingRules({sentence_ends:'.!?',languages:{xq:{question_words_anywhere:['plim']}}});
  assert.equal(anywhere.asSentence('go plim now','xq'),'Go plim now?');
  assert.equal(anywhere.asSentence('go home','xq'),'Go home.');
});

test('no data keeps bare lines and slot names', () => {
  const listing = new ListingRules(null);
  assert.equal(listing.available,false);
  assert.equal(listing.asSentence('do i need a jacket','en-US'),'Do i need a jacket');
  assert.equal(listing.asSentence('quelle heure est-il?','fr'),'Quelle heure est-il?');
  assert.equal(speakable('volume [to] {level} percent',{},'en-US',listing),'volume level percent');
  assert.deepEqual(listing.rank(['weather in','what is the weather'],'en'),['what is the weather','weather in']);
});

test('matches the published Python 0.6.8 golden listing cases in every shipped locale', async () => {
  const { readFile } = await import('node:fs/promises');
  const vectors = JSON.parse(await readFile(new URL('../../test/listing-vectors.json', import.meta.url), 'utf8'));
  const listing = new ListingRules();
  for (const row of vectors.cases) {
    const lang = row.lang ?? undefined;
    const actual = row.kind === 'sentence' ? asSentence(row.text,lang) : row.kind === 'speakable' ? speakable(row.text,{},lang) : listing.rank(row.phrases,lang);
    assert.deepEqual(actual,row.expected,JSON.stringify(row));
  }
});


test('language selection matches 990 OVOS cases including regional ties and scripts', async () => {
  const { readFile } = await import('node:fs/promises');
  const vectors = JSON.parse(await readFile(new URL('../../test/language-matching-vectors.json', import.meta.url), 'utf8'));
  for (const row of vectors.cases) assert.equal(closestLanguage(row.target,row.available) ?? null,row.expected,JSON.stringify(row));
});

test('custom regex rules preserve escaped literals and multiple global flags', () => {
  const listing = new ListingRules({sentence_ends:'.!?',languages:{xq:{question_patterns:['(?i)(?m)^can it',String.raw`\\b`,String.raw`\bété\b`]}}});
  assert.equal(listing.asks('CAN IT work','xq'),true);
  assert.equal(listing.asks(String.raw`write \b here`,'xq'),true);
  assert.equal(listing.asks('été','xq'),true);
  assert.equal(listing.asks('just a word','xq'),false);
});


test('punctuation-heavy runtime phrases are trimmed in linear time', () => {
  const listing = new ListingRules();
  const marks = '!'.repeat(1024*1024);
  assert.equal(listing.asks('word'+marks+'word','en'),false);
  assert.equal(listing.asks(marks+'what'+marks+' time is it','en'),true);
});


test('custom non-boundaries use Unicode letters and preserve Python reference empty-input behavior', () => {
  const rules = new ListingRules({sentence_ends:'.!?',languages:{xq:{question_patterns:[String.raw`\Bété\B`]}}});
  assert.equal(rules.asks('été','xq'),false);
  assert.equal(rules.asks('pétéx','xq'),true);
  const empty = new ListingRules({sentence_ends:'.!?',languages:{xq:{question_patterns:[String.raw`\B`]}}});
  assert.equal(empty.asks('','xq'),false);
});
