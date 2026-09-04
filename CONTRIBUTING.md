# Contributing

## Pre-commit hooks

This repo uses [Husky](https://typicode.github.io/husky/) to run checks before each commit (`.husky/pre-commit`):

- **ESLint** via `lint-staged` on staged `.js`/`.jsx` files.
- **`prisma validate`** whenever a staged file ends in `.prisma` (e.g. [stellar-payment-platform/prisma/schema.prisma](stellar-payment-platform/prisma/schema.prisma)). This catches schema syntax errors locally instead of failing in CI. The check is skipped entirely if no `.prisma` files are staged.

If `prisma validate` fails, the commit is blocked and the error is printed to the terminal. Fix the schema and re-commit.

You can run the same check manually at any time:

```bash
npm --prefix stellar-payment-platform run prisma:validate
```
