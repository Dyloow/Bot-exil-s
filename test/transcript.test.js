import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage, buildTranscript, fitToBudget } from '../src/modules/summary/transcript.js';

const names = { 111: 'Jean', 222: 'Marie' };
const channels = { 555: 'general' };
const resolveName = (id, type) => {
  if (type === 'channel') return channels[id];
  if (type === 'role') return undefined;
  return names[id];
};

function fakeMessage(overrides = {}) {
  return {
    id: 'm0',
    author: { id: '111', username: 'jean', globalName: 'Jean', bot: false },
    member: null,
    content: '',
    createdAt: new Date('2026-10-23T10:00:00Z'),
    attachments: [],
    embeds: [],
    stickers: [],
    reactions: [],
    ...overrides
  };
}

test('normalizeMessage resolves mentions, reply, attachments and embeds', () => {
  const msg = fakeMessage({
    id: 'a1',
    content: 'Salut <@111> et <@!222>, regarde <#555> <@&999> <:kekw:123>',
    reference: { messageId: 'parent1' },
    attachments: [{ url: 'https://cdn.example/x.png', name: 'x.png', contentType: 'image/png' }],
    embeds: [{ type: 'link', url: 'https://example.com/post', title: 'Un post' }]
  });

  const normalized = normalizeMessage(msg, resolveName);

  assert.equal(normalized.authorName, 'Jean');
  assert.equal(normalized.content, 'Salut @Jean et @Marie, regarde #general @999 :kekw:');
  assert.equal(normalized.replyToId, 'parent1');
  assert.deepEqual(normalized.attachments, [{ url: 'https://cdn.example/x.png', name: 'x.png', contentType: 'image/png' }]);
  assert.equal(normalized.embeds[0].title, 'Un post');
  assert.equal(normalized.isBot, false);
});

test('normalizeMessage uses member displayName over globalName/username', () => {
  const msg = fakeMessage({
    member: { displayName: 'Jeannot' },
    author: { id: '111', username: 'jean', globalName: 'Jean', bot: false }
  });
  assert.equal(normalizeMessage(msg, resolveName).authorName, 'Jeannot');
});

test('buildTranscript shows day headers and local HH:mm per line across 2 days', () => {
  const day1 = normalizeMessage(
    fakeMessage({ id: 'd1', content: 'Hello', createdAt: new Date('2026-10-22T20:00:00Z') }),
    resolveName
  );
  const day2 = normalizeMessage(
    fakeMessage({
      id: 'd2',
      author: { id: '222', username: 'marie', globalName: 'Marie', bot: false },
      content: 'Coucou',
      createdAt: new Date('2026-10-23T08:00:00Z')
    }),
    resolveName
  );

  const { lines } = buildTranscript([day1, day2], { byId: new Map() });

  assert.equal(lines.length, 4);
  assert.match(lines[0], /^--- .*22\/10 ---$/);
  assert.equal(lines[1], '[22:00] Jean: Hello');
  assert.match(lines[2], /^--- .*23\/10 ---$/);
  assert.equal(lines[3], '[10:00] Marie: Coucou');
});

test('buildTranscript formats a reply with the parent author and a short quote', () => {
  const parent = normalizeMessage(
    fakeMessage({ id: 'p1', content: 'On fait quoi ce soir ?' }),
    resolveName
  );
  const reply = normalizeMessage(
    fakeMessage({
      id: 'r1',
      author: { id: '222', username: 'marie', globalName: 'Marie', bot: false },
      content: 'Ciné',
      createdAt: new Date('2026-10-23T10:05:00Z'),
      reference: { messageId: 'p1' }
    }),
    resolveName
  );

  const byId = new Map([[parent.id, parent], [reply.id, reply]]);
  const { lines } = buildTranscript([parent, reply], { byId });

  assert.equal(lines[1], '[12:00] Jean: On fait quoi ce soir ?');
  assert.equal(lines[2], '[12:05] Marie ↪ à Jean « On fait quoi ce soir ? »: Ciné');
});

test('buildTranscript falls back to a generic marker when the replied-to parent is unknown', () => {
  const reply = normalizeMessage(
    fakeMessage({ id: 'r2', content: 'Oui carrément', reference: { messageId: 'unknown' } }),
    resolveName
  );
  const { lines } = buildTranscript([reply], { byId: new Map() });
  assert.equal(lines[1], '[12:00] Jean ↪ (réponse à un message plus ancien): Oui carrément');
});

test('buildTranscript tags an image attachment and collects it for vision', () => {
  const msg = normalizeMessage(
    fakeMessage({
      content: 'Regarde ça',
      attachments: [{ url: 'https://cdn.example/photo.png', name: 'photo.png', contentType: 'image/png' }]
    }),
    resolveName
  );

  const { lines, images } = buildTranscript([msg], { byId: new Map(), maxImages: 5 });

  assert.equal(lines[1], '[12:00] Jean: Regarde ça [photo img 1]');
  assert.deepEqual(images, [{ url: 'https://cdn.example/photo.png', ref: 'img 1' }]);
});

test('buildTranscript caps collected images at maxImages, tagging extras as plain [photo]', () => {
  const msgs = ['a', 'b', 'c'].map((letter, i) =>
    normalizeMessage(
      fakeMessage({
        id: `img-${letter}`,
        content: letter,
        createdAt: new Date(Date.UTC(2026, 9, 23, 10, i * 5)),
        attachments: [{ url: `https://cdn.example/${letter}.png`, name: `${letter}.png`, contentType: 'image/png' }]
      }),
      resolveName
    )
  );

  const { lines, images } = buildTranscript(msgs, { byId: new Map(), maxImages: 2 });

  assert.equal(images.length, 2);
  assert.match(lines[1], /\[photo img 1\]/);
  assert.match(lines[2], /\[photo img 2\]/);
  assert.match(lines[3], /\[photo\]$/);
});

test('buildTranscript tags a tenor GIF link with words from the slug', () => {
  const msg = normalizeMessage(
    fakeMessage({
      content: 'mdr',
      embeds: [{ type: 'gifv', url: 'https://tenor.com/view/cat-vibing-funny-gif-25820203' }]
    }),
    resolveName
  );
  const { lines } = buildTranscript([msg], { byId: new Map() });
  assert.equal(lines[1], '[12:00] Jean: mdr [GIF: cat vibing funny]');
});

test('buildTranscript tags a link embed with its title and domain', () => {
  const msg = normalizeMessage(
    fakeMessage({
      content: 'tiens',
      embeds: [{ type: 'link', url: 'https://www.example.com/article', title: 'Un super article' }]
    }),
    resolveName
  );
  const { lines } = buildTranscript([msg], { byId: new Map() });
  assert.equal(lines[1], '[12:00] Jean: tiens [lien example.com: Un super article]');
});

test('buildTranscript shows reactions and edited markers', () => {
  const msg = normalizeMessage(
    fakeMessage({
      content: 'oups',
      reactions: [{ emoji: '😂', count: 3 }, { emoji: '💀', count: 2 }],
      editedAt: new Date('2026-10-23T10:01:00Z')
    }),
    resolveName
  );
  const { lines } = buildTranscript([msg], { byId: new Map() });
  assert.equal(lines[1], '[12:00] Jean: oups (réactions: 😂x3 💀x2) (modifié)');
});

test('buildTranscript merges consecutive same-author messages under 2 minutes apart', () => {
  const m1 = normalizeMessage(fakeMessage({ id: 'c1', content: 'un' }), resolveName);
  const m2 = normalizeMessage(
    fakeMessage({ id: 'c2', content: 'deux', createdAt: new Date('2026-10-23T10:01:00Z') }),
    resolveName
  );
  const { lines } = buildTranscript([m1, m2], { byId: new Map() });
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '[12:00] Jean: un / deux');
});

test('buildTranscript keeps a message with only an attachment and empty content', () => {
  const msg = normalizeMessage(
    fakeMessage({
      content: '',
      stickers: ['PogChamp']
    }),
    resolveName
  );
  const { lines } = buildTranscript([msg], { byId: new Map() });
  assert.equal(lines[1], '[12:00] Jean: [sticker: PogChamp]');
});

test('fitToBudget drops the oldest lines first and always keeps the last message', () => {
  const lines = ['--- lundi 20/10 ---', 'ligne 1', 'ligne 2', 'ligne 3 la plus récente'];
  const fitted = fitToBudget(lines, 25);

  assert.match(fitted[0], /^\[\.\.\. \d+ messages plus anciens omis \.\.\.\]$/);
  assert.equal(fitted.at(-1), 'ligne 3 la plus récente');
});

test('fitToBudget returns the lines unchanged when already within budget', () => {
  const lines = ['ligne 1', 'ligne 2'];
  const fitted = fitToBudget(lines, 1000);
  assert.deepEqual(fitted, lines);
});
