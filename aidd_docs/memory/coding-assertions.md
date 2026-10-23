# Coding Assertions

## Before commit

| Order | Command | Checks |
| ----- | ------- | ------ |
| 1 | `node --check <changed files>` | syntax |
| 2 | `npm test` | unit tests (`node --test`), once they exist |

## Before push

| Order | Command | Checks |
| ----- | ------- | ------ |
| 1 | `npm test` | unit tests |

## Behavior

If a fix is needed, spawn one agent per failing assertion.
