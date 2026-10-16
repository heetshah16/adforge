# 0005 — Seeded vocabulary families

**Status:** accepted · 2026-10-15

## Context
`assertVariantDiversity()` checks hook and format *families* (architecture §5.2). The build spec has slugs but no families; one-family-per-slug would make the family check identical to the slug check and let near-synonyms through.

## Decision
Seed 4 hook families and 5 format families (spec §5.1 table). Archetypes get no family yet (`family_id` nullable). Families are DB rows; regrouping is an edit to `packages/db/src/seed/vocabulary.ts` + `pnpm db:seed`, or a direct row update. Re-seeding updates membership but never changes `status`.

## Consequences
With 4 hook families, "3 distinct hook families" is satisfiable but tight — `targeting` has one member. If the Director repeatedly fails the repair pass on archetypes whose shortlists lack a family, revisit the grouping before loosening the rule.

## Amendment 2026-10-16
`objection_lead` moved from `tension` to a new `objection` family (5 hook families). The build spec's own worked outputs pair `curiosity_gap` with `objection_lead` as two genuinely different bets (§7.1, §7.2); under the old grouping they would fail family-level diversity. `tension` now holds only `curiosity_gap`.
