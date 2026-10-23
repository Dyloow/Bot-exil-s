---
objective: "`!résumé` gives a correct, readable, topic-based summary that accounts for message times, images, GIFs, links, replies and sarcasm, and can be called by count or by duration."
status: pending
---

# Plan: Better summary command

## Overview

| Field      | Value |
| ---------- | ----- |
| **Goal**   | Rewrite the summary pipeline (collect → format → AI → send) and fix the bugs the project review found |
| **Source** | User request: the summary is "very bad". The content is wrong and misses topics, the output is too long and unreadable, the persona falls flat, it is awkward to use, and it ignores message times, photos, sarcasm, GIFs and links. Chosen format: by topics. |

## Phases

| #   | Phase | File |
| --- | ----- | ---- |
| 1   | Transcript builder (pure, tested) | [`phase-1.md`](./phase-1.md) |
| 2   | Summary command rewrite (range, vision, prompt, output) | [`phase-2.md`](./phase-2.md) |
| 3   | Project bug fixes found in review | [`phase-3.md`](./phase-3.md) |

## Resources

| Source | Verified |
| ------ | -------- |
| https://platform.openai.com/docs/guides/vision | `gpt-4o-mini` accepts `image_url` content parts. `detail: "low"` keeps the cost per image low. Animated GIFs are not supported, so send a static thumbnail instead. |
| https://discord.com/developers/docs/resources/message#embed-object-embed-limits | Embed description ≤ 4096 chars, total embeds per message ≤ 6000 chars, at most 10 embeds per message |

## Decisions

| Decision | Why |
| -------- | --- |
| Move the formatting logic into a pure module, `src/modules/summary/transcript.js` | It can be unit-tested without Discord or OpenAI. Today nothing is testable. |
| Use OpenAI vision for images and GIF thumbnails, capped at `summary.maxImages`, with `detail: "low"` | The user wants photos and GIFs understood. A cap keeps the cost bounded. |
| Keep the most recent messages when the transcript is over budget | The current code keeps the oldest messages and drops the newest ones, which is the opposite of what a reader needs |
| Ask the model for structured topics, then render the embeds ourselves | Control over the length and the layout is the root fix for "too long, unreadable" |
