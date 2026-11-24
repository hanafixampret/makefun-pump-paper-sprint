# surge-sniper — Pump.fun Paper Sprint: Any Bot Can Win

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/hanafixampret/makefun-pump-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/hanafixampret/makefun-pump-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A pump.fun paper-trading bot for the [agent-fun/replay/v2](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) harness. It watches every new bonding curve's tape and buys only when a real crowd arrives — several distinct buyers, net SOL flowing in, the price climbing and holding near its window high, with the newer half of the window pulling in faster than the older half. One small first buy, then it adds into strength only, up to a fixed stake per coin. It exits fast: take-profit, stop-loss, trailing stop, fade exit, or a hard time limit.

## Run

The grader runs `node /bot/main.ts` (Node 22). `main.ts` is a thin wrapper; the strategy lives in `strategy.ts`, the SDK shim in `vendor/makefun-bot.ts`.

## Strategy

- Entry: curve age ≥ 300 slots, real SOL 1–80, window of 40 slots with ≥ 4 buys from ≥ 4 distinct buyers, net inflow ≥ 0.5 SOL, price up ≥ 8% from the window start, price ≥ 90% of the window high, newer-half inflow ≥ older-half inflow.
- Sizing: first buy 0.2 SOL, add-ons of 0.2 SOL into strength, at most 0.6 SOL per position, at most 5 open positions.
- Exits: stop-loss at 80% of cost, take-profit at 150% of cost, trailing stop at 80% of peak once armed at 125% of cost, fade exit on net outflow over 20 slots, time limit 1200 slots unless up 20%.
- Deterministic: no clock, no randomness, no environment reads — the two grading executions agree byte for byte.
