# surge-harvester — Pump.fun Paper Sprint: Any Bot Can Win

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/hanafixampret/makefun-pump-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/hanafixampret/makefun-pump-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A pump.fun paper-trading bot for the [agent-fun/replay/v2](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) harness. Nearly every new coin bleeds out; a handful graduate. The ones that graduate announce themselves early — real SOL reserves pile up fast while the price runs several multiples off its first print. This bot only buys those, never adds to a position, and harvests on the way up instead of hoping for the migration: half off at +25%, half of the rest at +75%, a trailing stop once the peak doubles the entry, and a hard stop at -20% for the coins that never run.

## Run

The grader runs `node /bot/main.ts` (Node 22). The strategy lives in `main.ts`; the SDK shim in `vendor/makefun-bot.ts`.

## Strategy

- Entry: real SOL reserves ≥ 50, price ≥ 5x its first-seen price, age ≤ 200 slots, ≥ 55% of tracked SOL volume buys.
- Sizing: one buy of 0.50 SOL per coin (capped by the 1% of real reserves size limit), at most 5 open positions.
- Exits: harvest half at +25% over entry, harvest half of the rest at +75%; trailing stop (arms at +100% over entry, sells all at -15% below the peak); hard stop at -20% under entry; sell all after 1500 slots with no trade.
- Deterministic: no clock, no randomness, no environment reads — the two grading executions agree byte for byte.
