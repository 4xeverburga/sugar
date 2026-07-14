# CLAUDE.md

## Branch strategy (mandatory)

- Any PR targeting `main` MUST have `dev` as the head branch.
- Feature branches merge into `dev` first.
- Promotion to `main` happens only through `dev`.

## Governance source of truth

- Constitution (local, engine-governing principles): `.specify/memory/constitution.md`
- Extracted from and cross-referenced with the companion canvas/UI
  constitution: `https://github.com/4xeverburga/chiffonstack-diagram-lab/blob/main/.specify/memory/constitution.md`

## 014 Node Model Registry follow-up notes

- T033 is validated in GitHub Actions through:
  - `.github/workflows/ci-main.yml`
  - `.github/workflows/ci-dev.yml`
- Both workflows now run this quality gate sequence:
  1. `npx oxlint . --deny-warnings`
  2. `npm run typecheck`
  3. `npm test`
  4. `npm run build`

## T034 template

Use this issue template for the R7 cross-repo governance follow-up:

- `.github/ISSUE_TEMPLATE/t034-governance-follow-ups.md`
