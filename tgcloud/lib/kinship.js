// kinship.js — ESM-реэкспорт общего канона kinship.cjs (план:
// .kilo/plans/20261107-shared-modules-plan.md). Канон правится только в
// kinship.cjs: его требует ВК-бот (lunarreturns.js) и деплой
// /var/lib/lunarreturns; ТГ-копия (bot.js, chart.js) читает этот шим.
// Контракт — dev/sync-check.mjs (раздел kinLabel).
export { fynny, kinLabel, kinBlood, kinChain, fullSiblings, genLabel } from './kinship.cjs';
