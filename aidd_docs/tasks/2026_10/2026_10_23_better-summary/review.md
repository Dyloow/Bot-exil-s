# Review: better-summary

- **Verdict**: approve
- **Diff**: `main...feat/better-summary` (HEAD 7787f4a)
- **Axes run**: code, functional, relevancy
- **Date**: 2026_10_23
- **Findings**: 0 critical, 0 warning, 7 minor

## Phases

### Phase 1 — Transcript builder

- [x] A fake message with mentions, reply, attachments and embeds yields the full plain object, with names resolved — src/modules/summary/transcript.js:50-99; real discord.js 14.27 `Embed` (no `type` getter) now read via `embedGet` (transcript.js:30-32), probe with `new Embed({type:'gifv',...})` gives `[GIF img 3: abc]`
- [x] The transcript shows day headers, local times, reply context and every media tag, and caps the vision images at N — transcript.js:266-304; most-recent N kept after budget (transcript.js:335-364, probe: 10 GIFs + 1 gifv, N=3 => p8, p9, abc); reply prefix kept on merged group (transcript.js:245-249, 284-291, test transcript.test.js:153)
- [x] Over budget, the last message is always present and the first line is the omission marker — transcript.js:310-328, counts source messages
- [x] `npm test` passes with no network and no extra `node_modules` — re-run: 41/41 pass

### Phase 2 — Summary command rewrite

- [x] Counts, minutes, hours and days parse. Invalid input returns a usage error. Out-of-range values are clamped. — src/modules/summary/range.js:45-75
- [x] `!résumé 2h` stops fetching at the first message older than 2h. Short messages like "mdr" stay in the transcript. — SummaryManager.js:226-245, 267-276
- [x] The request carries the transcript and at most `maxImages` image parts, with `json_object` format — SummaryManager.js:352-366, each image preceded by an `img N:` label
- [x] The output is topic-based, and every embed is within the Discord limits. A long output spans several embeds instead of being cut. — render.js:82-115 (footer reserved), render.js:181-204 (≤10 embeds and ≤6000 chars per message); probe 12 topics x 1000 chars => 3 messages of 5044/5061/5106 chars
- [x] A second `!résumé` in the same channel within the cooldown gets a wait reply. `npm test` passes. — SummaryManager.js:82-101 (cooldown set at lock), lock released in `finally` (SummaryManager.js:181-184)

### Phase 3 — Project bug fixes from review

- [x] `!list_salaries` no longer triggers a roulette — src/index.js:575
- [x] With a valid `LOG_TALK_ID`, Discord logging is enabled at startup — src/index.js:157-159
- [x] `!config` renders without `TypeError`. `!status` reflects the real state of each module. — src/index.js:692-698, 740-743
- [x] The README matches the code — README.md summary sections (cost line stale, see Findings)

## Findings

| Sev | Kind | Phase | Location | Issue | Fix |
| --- | ---- | ----- | -------- | ----- | --- |
| 🟢 | code | 1 | src/modules/summary/transcript.js:318-325 | `fitToBudget` drops the leading `--- jour ---` header with the oldest lines, so the first kept block has times without a day (probe: transcript starts with the omission marker then `[12:18]` lines, no header); ambiguous on `!résumé 1j`/`2j` | After trimming, if the first kept non-marker line is not a header, re-insert the header of the day it belongs to (keep the day key on each line entry) |
| 🟢 | fit | 2 | src/modules/SummaryManager.js:309-312 | Image-error retry sends `usedImages = []` but the transcript text still carries `[photo img N]` / `[GIF img N: …]`, while the prompt says those refs point to images that follow: invites hallucinated photo descriptions on that path | On retry, rebuild text with `resolveImages(fittedLines, candidates, 0)` (pass the fitted lines in), or append a line "images indisponibles" to the user content |
| 🟢 | fit | 2 | src/modules/SummaryManager.js:226, render.js:48-51 | Since-mode stops silently at `maxFetch` (2000): `!résumé 2j` on a busy channel covers less than 48h while the title says "dernières 48h"; the footer period is HH:mm only, so the real start is not visible across days | Show date in the footer period when start and end are on different days, and/or flag "(limité à 2000 messages)" when `totalFetched >= maxFetch` |
| 🟢 | code | 2 | src/modules/summary/render.js:152-154 | Valid JSON with the wrong shape (e.g. `{"tldr":…,"sujets":[…]}`) is posted verbatim as raw JSON (probe confirmed) | When `data` is an object with `tldr`, render the tldr alone; otherwise show a clean error instead of the JSON |
| 🟢 | rot | 1 | src/modules/summary/transcript.js:71 | `video?.thumbnail?.url` reads a field that the raw Discord embed video object does not have (`url`, `proxy_url`, `height`, `width` only, discord.js Embed.js:116-124): dead branch | Drop it, or use `embedGet(embed, 'image')?.url` as the fallback |
| 🟢 | rot | 2 | src/modules/SummaryManager.js:173 | `result.usage?.total_tokens ?? transcriptText.length` falls back to chars logged as "tokens", the mix the previous review flagged | Fall back to `null`/`'?'` |
| 🟢 | rot | 3 | README.md:12 | "~0.002€ par résumé" is stale: at 60k chars (~17k tokens) + 6 low-detail images (gpt-4o-mini bills ~2.8k tokens each) a run is ~$0.005-0.006, up to ~3x with retries | Update to "~0.005€" or drop the figure |

## Verification

| Metric        | Value |
| ------------- | ----- |
| Verified      | 100% (13/13) |
| Files checked | src/modules/SummaryManager.js, src/modules/summary/transcript.js, src/modules/summary/format.js, src/modules/summary/range.js, src/modules/summary/render.js, src/index.js, src/config.json, package.json, README.md, test/*.test.js |
| Unchecked     | none |
| Unplanned     | aidd_docs/ memory + CLAUDE.md scaffolding (6f0d4e5, project setup); `src/modules/summary/format.js` shared helpers (from prior rot finding); image-error and truncation retries in `generateCompletion` (from prior findings) |
