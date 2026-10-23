# Testing

## Strategy

- No automated tests exist yet. `npm test` is a placeholder.
- Test the pure logic (formatting, chunking, parsing) with unit tests. Discord and OpenAI calls stay behind thin methods, so they are easy to stub.
- Behaviour against Discord is checked by hand on the real server.

## Tools

- `node:test` and `node:assert`, built into Node, with no extra dependency

## Conventions

- Tests live in `test/` and are named `*.test.js`
- Stub Discord objects with plain objects. Never call the real APIs from a test.

## Run

- `node --test`
