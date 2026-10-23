/**
 * Analyse pure des arguments de `!résumé` : par nombre de messages ou par durée.
 */

const COUNT_RE = /^(\d+)$/;
const DURATION_RE = /^(\d+)(m|h|j|d)$/i;

/**
 * Borne une valeur entre min et max.
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Formate une durée en heures vers un libellé court (`30m`, `2h`, `2j`).
 */
function formatHoursLabel(hours) {
  if (hours < 1) {
    return `${Math.round(hours * 60)}m`;
  }
  if (hours >= 24 && Number.isInteger(hours / 24)) {
    return `${hours / 24}j`;
  }
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

/**
 * Message d'usage renvoyé quand l'argument n'est ni un nombre ni une durée valide.
 */
function usageError(maxCount, maxHours) {
  return {
    error:
      'Utilisation : `!résumé`, `!résumé 150` (10 à ' +
      maxCount +
      ' messages), `!résumé 2h` ou `!résumé 1j` (jusqu\'à ' +
      maxHours +
      'h).'
  };
}

/**
 * Transforme les arguments de la commande en plage à résumer : par nombre ou depuis une date.
 * Renvoie `{ mode: 'count', count }`, `{ mode: 'since', since, label }` ou `{ error }`.
 */
export function parseRange(args, { defaultCount = 100, maxCount = 1000, maxHours = 48, now = new Date() } = {}) {
  const arg = args?.[0];

  if (!arg) {
    return { mode: 'count', count: defaultCount };
  }

  const countMatch = arg.match(COUNT_RE);
  if (countMatch) {
    const count = clamp(parseInt(countMatch[1], 10), 10, maxCount);
    return { mode: 'count', count };
  }

  const durationMatch = arg.match(DURATION_RE);
  if (durationMatch) {
    const value = parseInt(durationMatch[1], 10);
    const unit = durationMatch[2].toLowerCase();

    let hours;
    if (unit === 'm') hours = value / 60;
    else if (unit === 'h') hours = value;
    else hours = value * 24; // j ou d

    const clampedHours = clamp(hours, 0, maxHours);
    const since = new Date(now.getTime() - clampedHours * 60 * 60 * 1000);
    return { mode: 'since', since, label: formatHoursLabel(clampedHours) };
  }

  return usageError(maxCount, maxHours);
}
