import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage, buildTranscript, fitToBudget, resolveImages } from '../src/modules/summary/transcript.js';

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

/** Raccourci : construit le transcript et renvoie directement le texte des lignes (sans résoudre les images). */
function transcriptTexts(messages, opts) {
  const { lines } = buildTranscript(messages, opts);
  return lines.map((line) => line.text);
}

/** Construit un embed discord.js-like minimal : `.data` seul, sans getter `.type` (comme le vrai `Embed`). */
function fakeDiscordEmbed({ type, url, title = null, description = null, thumbnail = null, video = null, provider = null }) {
  const data = { type, url, title, description, thumbnail, video, provider };
  return {
    data,
    get url() {
      return data.url;
    },
    get title() {
      return data.title;
    },
    get description() {
      return data.description;
    },
    get thumbnail() {
      return data.thumbnail;
    },
    get video() {
      return data.video;
    },
    get provider() {
      return data.provider;
    }
    // Pas de getter `type` : seul `.data.type` le porte, comme le vrai discord.js `Embed`.
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

test('normalizeMessage reads embed.type from `.data.type` when there is no top-level getter (real discord.js Embed)', () => {
  const msg = fakeMessage({
    content: 'regarde',
    embeds: [fakeDiscordEmbed({ type: 'gifv', url: 'https://tenor.com/view/cat-vibing-funny-gif-25820203' })]
  });
  const normalized = normalizeMessage(msg, resolveName);
  assert.equal(normalized.embeds[0].type, 'gifv');

  const lines = transcriptTexts([normalized], { byId: new Map() });
  assert.match(lines[1], /\[GIF: cat vibing funny\]/);
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

  const lines = transcriptTexts([day1, day2], { byId: new Map() });

  assert.equal(lines.length, 4);
  assert.match(lines[0], /^--- .*22\/10 ---$/);
  assert.equal(lines[1], '[22:00] Jean: Hello');
  assert.match(lines[2], /^--- .*23\/10 ---$/);
  assert.equal(lines[3], '[10:00] Marie: Coucou');
});

test('buildTranscript formats a reply with the parent author and a short quote', () => {
  const parent = normalizeMessage(fakeMessage({ id: 'p1', content: 'On fait quoi ce soir ?' }), resolveName);
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
  const lines = transcriptTexts([parent, reply], { byId });

  assert.equal(lines[1], '[12:00] Jean: On fait quoi ce soir ?');
  assert.equal(lines[2], '[12:05] Marie ↪ à Jean « On fait quoi ce soir ? »: Ciné');
});

test('buildTranscript falls back to a generic marker when the replied-to parent is unknown', () => {
  const reply = normalizeMessage(
    fakeMessage({ id: 'r2', content: 'Oui carrément', reference: { messageId: 'unknown' } }),
    resolveName
  );
  const lines = transcriptTexts([reply], { byId: new Map() });
  assert.equal(lines[1], '[12:00] Jean ↪ (réponse à un message plus ancien): Oui carrément');
});

test('buildTranscript keeps the reply prefix even when the reply is merged with a quick follow-up', () => {
  const parent = normalizeMessage(fakeMessage({ id: 'p3', content: 'Ça va ?' }), resolveName);
  const reply = normalizeMessage(
    fakeMessage({
      id: 'r5',
      author: { id: '222', username: 'marie', globalName: 'Marie', bot: false },
      content: 'Ciné',
      createdAt: new Date('2026-10-23T10:05:00Z'),
      reference: { messageId: 'p3' }
    }),
    resolveName
  );
  const followUp = normalizeMessage(
    fakeMessage({
      id: 'r6',
      author: { id: '222', username: 'marie', globalName: 'Marie', bot: false },
      content: 'vers 20h',
      createdAt: new Date('2026-10-23T10:05:30Z')
    }),
    resolveName
  );

  const byId = new Map([[parent.id, parent]]);
  const lines = transcriptTexts([parent, reply, followUp], { byId });

  assert.equal(lines[1], '[12:00] Jean: Ça va ?');
  assert.equal(lines[2], '[12:05] Marie ↪ à Jean « Ça va ? »: Ciné / vers 20h');
});

test('buildTranscript tags an image attachment and resolveImages collects it for vision', () => {
  const msg = normalizeMessage(
    fakeMessage({
      content: 'Regarde ça',
      attachments: [{ url: 'https://cdn.example/photo.png', name: 'photo.png', contentType: 'image/png' }]
    }),
    resolveName
  );

  const { lines, candidates } = buildTranscript([msg], { byId: new Map() });
  const { lines: finalLines, images } = resolveImages(lines, candidates, 5);

  assert.equal(finalLines[1], '[12:00] Jean: Regarde ça [photo img 1]');
  assert.deepEqual(images, [{ url: 'https://cdn.example/photo.png', ref: 'img 1' }]);
});

test('resolveImages keeps the most recent maxImages candidates, not the oldest', () => {
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

  const { lines, candidates } = buildTranscript(msgs, { byId: new Map() });
  const { lines: finalLines, images } = resolveImages(lines, candidates, 2);

  assert.equal(images.length, 2);
  assert.deepEqual(
    images.map((i) => i.url),
    ['https://cdn.example/b.png', 'https://cdn.example/c.png']
  );
  assert.match(finalLines[1], /\[photo\]$/); // "a" : plus l'image la plus ancienne, pas de référence
  assert.match(finalLines[2], /\[photo img 1\]/);
  assert.match(finalLines[3], /\[photo img 2\]/);
});

test('resolveImages drops candidates whose line did not survive fitToBudget (no dangling img N refs)', () => {
  const msgs = ['a', 'b'].map((letter, i) =>
    normalizeMessage(
      fakeMessage({
        id: `imgfit-${letter}`,
        content: `${letter} ${'x'.repeat(80)}`,
        createdAt: new Date(Date.UTC(2026, 9, 23, 10, i * 5)),
        attachments: [{ url: `https://cdn.example/${letter}.png`, name: `${letter}.png`, contentType: 'image/png' }]
      }),
      resolveName
    )
  );

  const { lines, candidates } = buildTranscript(msgs, { byId: new Map() });
  // Budget assez petit pour ne garder que la toute dernière ligne.
  const { lines: fittedLines, omittedMessageCount } = fitToBudget(lines, 40);
  assert.equal(omittedMessageCount, 1);

  const { lines: finalLines, images } = resolveImages(fittedLines, candidates, 5);

  assert.equal(images.length, 1);
  assert.equal(images[0].url, 'https://cdn.example/b.png');
  assert.ok(finalLines.some((line) => line.includes('[photo img 1]')));
  // L'image de la ligne omise ("a") ne doit jamais apparaître.
  assert.ok(!images.some((i) => i.url.includes('/a.png')));
});

test('buildTranscript tags a tenor GIF link with words from the slug', () => {
  const msg = normalizeMessage(
    fakeMessage({
      content: 'mdr',
      embeds: [{ type: 'gifv', url: 'https://tenor.com/view/cat-vibing-funny-gif-25820203' }]
    }),
    resolveName
  );
  const lines = transcriptTexts([msg], { byId: new Map() });
  assert.equal(lines[1], '[12:00] Jean: mdr [GIF: cat vibing funny]');
});

test('buildTranscript converts a .gif attachment to a static image via the Discord media proxy', () => {
  const msg = normalizeMessage(
    fakeMessage({
      content: 'mdr',
      attachments: [{ url: 'https://cdn.discordapp.com/attachments/1/2/cat-dancing.gif', name: 'cat-dancing.gif', contentType: 'image/gif' }]
    }),
    resolveName
  );
  const { lines, candidates } = buildTranscript([msg], { byId: new Map() });
  const { lines: finalLines, images } = resolveImages(lines, candidates, 5);

  assert.match(finalLines[1], /\[GIF img 1: cat dancing\]/);
  assert.equal(images.length, 1);
  assert.equal(images[0].url, 'https://media.discordapp.net/attachments/1/2/cat-dancing.gif?format=png');
});

test('buildTranscript skips vision for a .gif attachment from an unknown host (no safe conversion)', () => {
  const msg = normalizeMessage(
    fakeMessage({
      content: 'mdr',
      attachments: [{ url: 'https://example.com/cat-dancing.gif', name: 'cat-dancing.gif', contentType: 'image/gif' }]
    }),
    resolveName
  );
  const { lines, candidates } = buildTranscript([msg], { byId: new Map() });
  const { lines: finalLines, images } = resolveImages(lines, candidates, 5);

  assert.equal(images.length, 0);
  assert.match(finalLines[1], /\[GIF: cat dancing\]/);
});

test('buildTranscript treats an unsupported image/* attachment (heic/svg) as a file, not a vision image', () => {
  const msg = normalizeMessage(
    fakeMessage({
      content: 'tiens',
      attachments: [{ url: 'https://cdn.example/photo.heic', name: 'photo.heic', contentType: 'image/heic' }]
    }),
    resolveName
  );
  const { lines, candidates } = buildTranscript([msg], { byId: new Map() });
  assert.equal(candidates.length, 0);
  const { images } = resolveImages(lines, candidates, 5);
  assert.equal(images.length, 0);
  assert.equal(lines[1].text, '[12:00] Jean: tiens [fichier: photo.heic]');
});

test('buildTranscript tags a link embed with its title and domain', () => {
  const msg = normalizeMessage(
    fakeMessage({
      content: 'tiens',
      embeds: [{ type: 'link', url: 'https://www.example.com/article', title: 'Un super article' }]
    }),
    resolveName
  );
  const lines = transcriptTexts([msg], { byId: new Map() });
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
  const lines = transcriptTexts([msg], { byId: new Map() });
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
  assert.equal(lines[1].text, '[12:00] Jean: un / deux');
  assert.equal(lines[1].messageCount, 2);
});

test('buildTranscript keeps a message with only an attachment and empty content', () => {
  const msg = normalizeMessage(fakeMessage({ content: '', stickers: ['PogChamp'] }), resolveName);
  const lines = transcriptTexts([msg], { byId: new Map() });
  assert.equal(lines[1], '[12:00] Jean: [sticker: PogChamp]');
});

test('fitToBudget drops the oldest lines first and always keeps the last message', () => {
  const lines = [
    { text: '--- lundi 20/10 ---', messageCount: 0 },
    { text: 'ligne 1', messageCount: 1 },
    { text: 'ligne 2', messageCount: 1 },
    { text: 'ligne 3 la plus récente', messageCount: 1 }
  ];
  const { lines: fitted, omittedMessageCount } = fitToBudget(lines, 25);

  assert.match(fitted[0].text, /^\[\.\.\. \d+ messages plus anciens omis \.\.\.\]$/);
  assert.equal(fitted.at(-1).text, 'ligne 3 la plus récente');
  assert.ok(omittedMessageCount > 0);
});

test('fitToBudget counts source messages, not lines, in the omission marker', () => {
  const lines = [
    { text: 'ligne fusionnée (3 messages)', messageCount: 3 },
    { text: 'ligne 2', messageCount: 1 },
    { text: 'ligne 3 la plus récente', messageCount: 1 }
  ];
  const { lines: fitted, omittedMessageCount } = fitToBudget(lines, 20);

  assert.equal(omittedMessageCount, 4); // 3 (fusionnée) + 1 (ligne 2), pas 2 lignes
  assert.equal(fitted[0].text, '[... 4 messages plus anciens omis ...]');
});

test('fitToBudget returns the lines unchanged when already within budget', () => {
  const lines = [
    { text: 'ligne 1', messageCount: 1 },
    { text: 'ligne 2', messageCount: 1 }
  ];
  const { lines: fitted, omittedMessageCount } = fitToBudget(lines, 1000);
  assert.deepEqual(fitted, lines);
  assert.equal(omittedMessageCount, 0);
});
