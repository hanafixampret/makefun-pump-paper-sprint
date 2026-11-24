// Surge Harvester: a graduation-chasing bot for the pump.fun paper sprint
// (round 2 rebuild).
//
// Idea, from the bonding curve alone: nearly every new coin bleeds out, a
// handful graduate. The ones that graduate announce themselves early — real
// SOL reserves pile up fast while the price runs several multiples off its
// first-seen level. This bot only buys those: 50+ SOL of real reserves, price
// at least 5x its first print, younger than 200 slots, most of the tracked
// volume buys. It never adds to a position. It harvests on the way up instead
// of hoping for the migration: half off at +25%, half of the rest at +75%, a
// trailing stop once the peak doubles the entry, and a hard stop at -20% for
// the coins that never run. A coin that goes quiet for 1500 slots is sold.
// One buy per coin, at most five open at once. Nothing here reads the clock,
// the environment or Math.random, so the two grading executions agree byte
// for byte.
//
// Price of a coin is virtual_quote_reserves / virtual_token_reserves (SOL per
// token), read off the harness's own curve state after each batch.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;

const CFG = {
  stakeLamports: SOL / 2n, // 0.50 SOL per coin — the 1% size cap at the 50 SOL trigger
  minBuyLamports: (SOL * 2n) / 100n, // 0.02 SOL smallest buy (round-trip bar is 0.01)
  entryRsolLamports: SOL * 50n, // real SOL reserves must reach 50
  entryMultBps: 50000, // price must be at least 5x its first-seen price
  maxEntryAgeSlots: 200, // only coins younger than 200 slots
  buyShareBps: 5500, // at least 55% of tracked SOL volume must be buys
  tp1GainBps: 2500, // first harvest: +25% over entry
  tp1SellBps: 5000, // sell half the position there
  tp2GainBps: 7500, // second harvest: +75% over entry
  tp2SellBps: 5000, // sell half of what is left there
  trailArmBps: 10000, // trailing stop arms once the peak is +100% over entry
  trailDropBps: 1500, // sell all when price falls 15% below the peak
  stopLossBps: 2000, // sell all at -20% under entry
  quietSlots: 1500, // sell all after 1500 slots with no trade
  slippageBps: 10000, // wide open: never refuse a fill over price movement
};

interface CoinTrack {
  firstPrice: number;
  firstSlot: number;
  lastPrice: number;
  lastTradeSlot: number;
  buyVol: bigint;
  sellVol: bigint;
  decided: boolean;
  entryPrice: number;
  peak: number;
  tpStage: number;
}

const coins = new Map<string, CoinTrack>();

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function track(mint: string, price: number, slot: number): CoinTrack {
  let c = coins.get(mint);
  if (c === undefined) {
    c = {
      firstPrice: price,
      firstSlot: slot,
      lastPrice: price,
      lastTradeSlot: slot,
      buyVol: 0n,
      sellVol: 0n,
      decided: false,
      entryPrice: 0,
      peak: 0,
      tpStage: 0,
    };
    coins.set(mint, c);
  }
  return c;
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const orders: Array<BuyInput | SellInput> = [];
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();

    // Fills first: a buy that landed sets the entry price and peak for exits.
    // A sell that closed the position clears them; a partial (harvest) sell
    // leaves them alone so the rest keeps its own exit levels.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      const c = coins.get(f.mint);
      if (c === undefined) continue;
      if (f.side === 'buy' && BigInt(f.token_amount) > 0n) {
        c.entryPrice = Number(f.quote_lamports) / Number(f.token_amount);
        c.peak = c.entryPrice;
        c.tpStage = 0;
      } else if (f.side === 'sell' && !state.positions.has(f.mint)) {
        c.entryPrice = 0;
        c.peak = 0;
        c.tpStage = 0;
      }
    }

    // Marks refresh the latest price of held / pending mints even with no trade.
    for (const m of batch.marks) {
      const c = coins.get(m.mint);
      if (c === undefined) continue;
      c.lastPrice = priceOf(BigInt(m.virtual_quote_reserves), BigInt(m.virtual_token_reserves));
      if (c.entryPrice > 0 && c.lastPrice > c.peak) c.peak = c.lastPrice;
    }

    // Trades update price, volume split and age for every coin in this batch.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        track(e.mint, p, e.slot);
      } else if (e.event === 'TradeEvent') {
        const curve = state.curves.get(e.mint);
        if (curve === undefined) continue;
        const p = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const c = track(e.mint, p, e.slot);
        c.lastPrice = p;
        c.lastTradeSlot = e.slot;
        if (c.entryPrice > 0 && p > c.peak) c.peak = p;
        if (e.is_buy) c.buyVol += BigInt(e.sol_amount);
        else c.sellVol += BigInt(e.sol_amount);
      }
    }

    // Harvests: one level per coin per batch. Selling half at +25% and half of
    // the rest at +75% banks the run before the single-slot cliffs that end
    // most near-graduation coins, while the remainder still rides a migration.
    const harvested = new Set<string>();
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const c = coins.get(mint);
      if (c === undefined || c.entryPrice <= 0 || c.lastPrice <= 0) continue;
      const tokens = BigInt(pos.token_amount);
      if (tokens <= 0n) continue;
      let gain = 0;
      let share = 0;
      if (c.tpStage === 0 && c.lastPrice >= c.entryPrice * (1 + CFG.tp1GainBps / 10000)) {
        gain = CFG.tp1GainBps;
        share = CFG.tp1SellBps;
      } else if (c.tpStage === 1 && c.lastPrice >= c.entryPrice * (1 + CFG.tp2GainBps / 10000)) {
        gain = CFG.tp2GainBps;
        share = CFG.tp2SellBps;
      }
      if (gain === 0) continue;
      const amt = (tokens * BigInt(share)) / 10000n;
      if (amt <= 0n || amt >= tokens) continue;
      c.tpStage += 1;
      harvested.add(mint);
      orders.push({ side: 'sell', mint, token_amount: amt, max_slippage_bps: CFG.slippageBps });
    }

    // Full exits: hard stop, trailing stop once armed, or gone quiet. A coin
    // harvested in this batch is left alone until the next one.
    for (const [mint, pos] of state.positions) {
      if (harvested.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const c = coins.get(mint);
      if (c === undefined) continue;
      if (c.lastPrice > c.peak) c.peak = c.lastPrice;
      let entry = c.entryPrice;
      if (entry <= 0 && BigInt(pos.token_amount) > 0n) {
        entry = Number(pos.cost_lamports) / Number(pos.token_amount);
      }
      if (entry <= 0 || c.lastPrice <= 0) continue;
      const stopped = c.lastPrice <= entry * (1 - CFG.stopLossBps / 10000);
      const armed = c.peak >= entry * (1 + CFG.trailArmBps / 10000);
      const trailed = armed && c.lastPrice <= c.peak * (1 - CFG.trailDropBps / 10000);
      const quiet = batch.slot - c.lastTradeSlot > CFG.quietSlots;
      if (stopped || trailed || quiet) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: BigInt(pos.token_amount),
          max_slippage_bps: CFG.slippageBps,
        });
      }
    }

    // Entries: coins in this batch's events, in order, one buy each, never twice.
    for (const e of batch.events) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) continue;
      const c = coins.get(e.mint);
      if (c === undefined || c.decided) continue;
      if (batch.slot - c.firstSlot > CFG.maxEntryAgeSlots) {
        c.decided = true;
        continue;
      }
      if (curve.real_quote_reserves < CFG.entryRsolLamports) continue;
      if (c.firstPrice <= 0 || c.lastPrice < c.firstPrice * (CFG.entryMultBps / 10000)) continue;
      const vol = c.buyVol + c.sellVol;
      if (vol === 0n) continue;
      if ((c.buyVol * 10000n) / vol < BigInt(CFG.buyShareBps)) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < CFG.minBuyLamports) continue;
      const amount = cap < CFG.stakeLamports ? cap : CFG.stakeLamports;
      if (free < amount + tx) continue;
      c.decided = true;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: CFG.slippageBps });
      free -= amount + tx;
      slots -= 1;
    }

    return orders;
  },

  onDone(state: BotState) {
    const pnl = state.cash - BigInt(state.hello.capital.lamports);
    console.error(`done: cash ${state.cash} lamports, net ${pnl} lamports, coins tracked ${coins.size}`);
  },
});
