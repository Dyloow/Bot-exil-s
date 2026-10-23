# Project Brief

## What it is

- "JR", a Discord bot for a single private server: "La Table des Exilés", a group of friends.
- Gives the group its rituals (votes, roulette, purges) plus AI summaries and AI quips.

## Why it exists

- Keep the server closed to members the group has voted in, with a tone that is trashy on purpose.
- Let someone who missed the conversation catch up with `!résumé`.

## Domain language

| Term | Meaning |
| ---- | ------- |
| Exilé | full member role, the only one that survives the nightly purge |
| Condamné à l'Exil | temporary role a candidate holds during a 24h admission vote |
| Rapatrié | read-only role given after a vote-kick |
| vote-kick | majority vote that demotes a member to Rapatrié, temporarily, or permanently after an `@everyone` |
| roulette russe | `!rr`, 1-in-6 chance of a degrading nickname that is forced for 24h |
| check_hess | salary comparison against a reference salary (`SalaryChecker`) |
| JR | the bot's persona name |

## Key features

- AI summary of the last N messages of a channel (`!résumé [n]`)
- Admission vote and vote-kick, with buttons
- Nightly kick of non-Exilés (cron)
- Russian roulette nickname punishment
- Random AI interventions in conversations
- Salary comparator and reminders
- Moderation guard: quotas, rollback, protected bot role
