import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSummary, groupEmbeds, EMBEDS_PER_MESSAGE_MAX } from '../src/modules/summary/render.js';

const baseMeta = {
  channelName: 'general',
  label: '100 messages',
  messageCount: 42,
  periodStart: new Date('2026-10-23T08:00:00Z'),
  periodEnd: new Date('2026-10-23T12:32:00Z'),
  timeZone: 'Europe/Paris'
};

test('renderSummary builds one embed with the TL;DR, the vibe and one field per topic', () => {
  const json = {
    tldr: 'Grosse discussion sur le futur du serveur.',
    vibe: 'Ambiance potes, pas mal de vannes.',
    topics: [
      { title: 'Nouveau channel', emoji: '📢', people: ['Jean', 'Marie'], summary: 'Jean propose un channel memes, Marie valide.' },
      { title: 'Soirée ciné', emoji: '🎬', people: ['Paul'], summary: 'Paul veut organiser une sortie ciné vendredi.' }
    ]
  };

  const embeds = renderSummary(json, baseMeta);

  assert.equal(embeds.length, 1);
  const embed = embeds[0];
  assert.equal(embed.title, 'Résumé #general · 100 messages');
  assert.match(embed.description, /\*\*TL;DR\*\*/);
  assert.match(embed.description, /Grosse discussion/);
  assert.match(embed.description, /Ambiance potes/);
  assert.equal(embed.fields.length, 2);
  assert.equal(embed.fields[0].name, '📢 Nouveau channel');
  assert.match(embed.fields[0].value, /Jean propose un channel memes/);
  assert.match(embed.fields[0].value, /— Jean, Marie/);
  assert.deepEqual(embed.footer, { text: '42 messages · 10:00 → 14:32' });

  for (const e of embeds) {
    assert.ok(e.description === undefined || e.description.length <= 4096);
    assert.ok(e.fields.length <= 25);
    for (const f of e.fields) {
      assert.ok(f.name.length <= 256);
      assert.ok(f.value.length <= 1024);
    }
  }
});

test('renderSummary splits many topics across several embeds without dropping any', () => {
  const topics = Array.from({ length: 30 }, (_, i) => ({
    title: `Sujet ${i + 1}`,
    emoji: '💬',
    people: ['X'],
    summary: `Résumé du sujet numéro ${i + 1}.`
  }));

  const embeds = renderSummary({ tldr: 'Beaucoup de sujets.', topics, vibe: 'Calme' }, baseMeta);

  assert.ok(embeds.length > 1, 'expected more than one embed for 30 topics');

  const allFieldNames = embeds.flatMap((e) => e.fields.map((f) => f.name));
  for (let i = 1; i <= 30; i++) {
    assert.ok(allFieldNames.some((name) => name.includes(`Sujet ${i}`)), `missing Sujet ${i}`);
  }

  for (const e of embeds) {
    assert.ok(e.fields.length <= 25);
    const total =
      (e.title?.length ?? 0) +
      (e.description?.length ?? 0) +
      (e.footer?.text?.length ?? 0) +
      e.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    assert.ok(total <= 6000, `embed total length ${total} exceeds 6000`);
  }

  assert.match(embeds[1].title, /\(suite\)/);
});

test('renderSummary splits an over-long topic summary into continuation fields instead of cutting it', () => {
  const longSummary = 'x'.repeat(1500) + ' fin-du-texte';
  const embeds = renderSummary({ tldr: 't', vibe: 'v', topics: [{ title: 'Long', summary: longSummary }] }, baseMeta);

  const fields = embeds.flatMap((e) => e.fields);
  assert.ok(fields.length >= 2);
  for (const f of fields) {
    assert.ok(f.value.length <= 1024);
  }
  assert.ok(fields.some((f) => f.value.includes('fin-du-texte')), 'the tail of the summary must not be lost');
  assert.match(fields[1].name, /\(suite\)/);
});

test('renderSummary falls back to plain description chunks when the model output is not JSON', () => {
  const rawText = 'Ceci est un résumé texte brut, pas du JSON.';
  const embeds = renderSummary(rawText, baseMeta);

  assert.equal(embeds.length, 1);
  assert.equal(embeds[0].fields.length, 0);
  assert.equal(embeds[0].description, rawText);
  assert.equal(embeds[0].title, 'Résumé #general · 100 messages');
});

test('renderSummary fallback splits very long plain text across embeds under the description limit', () => {
  const rawText = Array.from({ length: 10 }, (_, i) => `Paragraphe ${i} ${'y'.repeat(500)}`).join('\n');
  const embeds = renderSummary(rawText, baseMeta);

  assert.ok(embeds.length > 1);
  for (const e of embeds) {
    assert.ok(e.description.length <= 4096);
  }
  const rebuilt = embeds.map((e) => e.description).join('\n');
  for (let i = 0; i < 10; i++) {
    assert.ok(rebuilt.includes(`Paragraphe ${i}`));
  }
});

test('groupEmbeds packs embeds into messages of at most 10', () => {
  const embeds = Array.from({ length: 23 }, (_, i) => ({ title: `e${i}` }));
  const messages = groupEmbeds(embeds);

  assert.equal(messages.length, 3);
  assert.equal(messages[0].length, EMBEDS_PER_MESSAGE_MAX);
  assert.equal(messages[1].length, EMBEDS_PER_MESSAGE_MAX);
  assert.equal(messages[2].length, 3);
});

test('groupEmbeds returns a single empty message for an empty embed list', () => {
  assert.deepEqual(groupEmbeds([]), [[]]);
});
