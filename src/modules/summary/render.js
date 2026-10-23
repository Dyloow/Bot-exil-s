/**
 * Rendu pur : transforme la réponse JSON du modèle en embeds Discord, sans import discord.js.
 * Respecte les limites officielles des embeds (description, fields, total, nombre par message).
 */

const FIELD_VALUE_MAX = 1024;
const FIELD_NAME_MAX = 256;
const DESCRIPTION_MAX = 4096;
const FIELDS_MAX = 25;
const EMBED_TOTAL_MAX = 6000;
export const EMBEDS_PER_MESSAGE_MAX = 10;
const COLOR = 0x5865f2;

/**
 * Coupe un texte à `max` caractères en ajoutant « … » si besoin.
 */
function truncate(text, max) {
  if (!text) return text;
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Découpe un texte en morceaux de `max` caractères, en coupant sur un saut de ligne si possible.
 */
function chunkText(text, max) {
  const chunks = [];
  let rest = (text ?? '').trim();

  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);

  return chunks;
}

/**
 * Formate une heure locale HH:mm pour le pied de page.
 */
function formatTime(date, timeZone = 'Europe/Paris') {
  return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(
    date
  );
}

/**
 * Construit le titre de l'embed, avec un suffixe « (suite) » pour les embeds suivants.
 */
function buildTitle(meta, suffix) {
  const base = `Résumé #${meta.channelName ?? 'channel'} · ${meta.label ?? ''}`.trim();
  return suffix ? `${base} ${suffix}` : base;
}

/**
 * Construit le pied de page : nombre de messages et période couverte.
 */
function buildFooter(meta) {
  if (!meta.messageCount) return null;
  const period =
    meta.periodStart && meta.periodEnd
      ? ` · ${formatTime(meta.periodStart, meta.timeZone)} → ${formatTime(meta.periodEnd, meta.timeZone)}`
      : '';
  return { text: `${meta.messageCount} messages${period}` };
}

/**
 * Transforme un sujet du modèle en un ou plusieurs fields, en coupant si la valeur dépasse 1024.
 */
function fieldsForTopic(topic) {
  const emoji = topic.emoji ?? '💬';
  const name = truncate(`${emoji} ${topic.title ?? 'Sujet'}`.trim(), FIELD_NAME_MAX);
  const people = Array.isArray(topic.people) && topic.people.length > 0 ? `\n— ${topic.people.join(', ')}` : '';
  const fullValue = `${topic.summary ?? ''}${people}`.trim() || '—';

  return chunkText(fullValue, FIELD_VALUE_MAX).map((chunk, i) => ({
    name: i === 0 ? name : truncate(`${name} (suite)`, FIELD_NAME_MAX),
    value: chunk,
    inline: false
  }));
}

/**
 * Répartit la description et les fields dans un ou plusieurs embeds sous les limites Discord.
 */
function packIntoEmbeds(description, fields, meta) {
  const embeds = [];
  let current = null;
  let runningLength = 0;

  function newEmbed(withDescription) {
    current = { color: COLOR, title: buildTitle(meta, embeds.length > 0 ? '(suite)' : ''), fields: [] };
    if (withDescription) current.description = description;
    embeds.push(current);
    runningLength = current.title.length + (current.description?.length ?? 0);
  }

  newEmbed(true);

  for (const field of fields) {
    const fieldLength = field.name.length + field.value.length;
    const overflowsFields = current.fields.length >= FIELDS_MAX;
    const overflowsChars = runningLength + fieldLength > EMBED_TOTAL_MAX;

    if (overflowsFields || overflowsChars) {
      newEmbed(false);
    }

    current.fields.push(field);
    runningLength += fieldLength;
  }

  const footer = buildFooter(meta);
  if (footer) embeds[embeds.length - 1].footer = footer;

  return embeds;
}

/**
 * Rendu de secours : le texte brut du modèle (non-JSON) en embeds, découpé sous la limite de description.
 */
function renderFallback(rawText, meta) {
  const text = rawText && rawText.trim().length > 0 ? rawText : 'Résumé indisponible.';
  const chunks = chunkText(text, DESCRIPTION_MAX);
  const footer = buildFooter(meta);

  return chunks.map((chunk, i) => {
    const embed = {
      color: COLOR,
      title: buildTitle(meta, i === 0 ? '' : '(suite)'),
      description: chunk,
      fields: []
    };
    if (footer && i === chunks.length - 1) embed.footer = footer;
    return embed;
  });
}

/**
 * Construit les embeds du résumé à partir du JSON du modèle (ou de son texte brut en secours).
 * `input` est soit l'objet déjà parsé `{ tldr, topics, vibe }`, soit une chaîne (JSON ou texte libre).
 */
export function renderSummary(input, meta = {}) {
  let data = input;

  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      return renderFallback(input, meta);
    }
  }

  if (!data || typeof data !== 'object' || !Array.isArray(data.topics)) {
    return renderFallback(typeof input === 'string' ? input : JSON.stringify(input ?? ''), meta);
  }

  const tldr = data.tldr ? `**TL;DR**\n${data.tldr}` : '';
  const vibe = data.vibe ? `\n\n_${data.vibe}_` : '';
  const description = truncate(`${tldr}${vibe}`.trim() || 'Rien à signaler.', DESCRIPTION_MAX);

  const fields = data.topics.flatMap(fieldsForTopic);

  return packIntoEmbeds(description, fields, meta);
}

/**
 * Regroupe les embeds par paquets de `maxPerMessage` (10 par défaut), pour respecter la limite Discord par message.
 */
export function groupEmbeds(embeds, maxPerMessage = EMBEDS_PER_MESSAGE_MAX) {
  const messages = [];
  for (let i = 0; i < embeds.length; i += maxPerMessage) {
    messages.push(embeds.slice(i, i + maxPerMessage));
  }
  return messages.length > 0 ? messages : [[]];
}
