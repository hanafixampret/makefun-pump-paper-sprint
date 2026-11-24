// surge-sniper: a pump.fun replay bot for agent-fun/replay/v2.
//
// Idea: new bonding curves either surge in their first minutes or bleed out.
// The bot watches every curve's tape and buys only when the tape shows a real
// crowd arriving — several distinct buyers, net SOL flowing in, the price
// climbing and holding near its window high, with the newer half of the
// window pulling in faster than the older half. One small first buy, then it
// adds into strength only, up to a fixed stake per coin. It exits fast: a
// take-profit, a stop-loss, a trailing stop once the position is up, a fade
// exit when the flow turns, or a hard time limit. No clock, no randomness,
// no environment reads: every decision comes from the batch stream, so the
// two grading executions agree byte for byte.
//
// The grader runs `node /bot/main.ts`; the strategy lives here and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface SurgeParams {
  /** Entry lookback in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip curves that already ran too far. */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** First buy of a position (SOL). */
  firstSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Sell when value falls to this share of cost. */
  stopLoss: number;
  /** Sell when value reaches this multiple of cost. */
  takeProfit: number;
  /** Trailing stop arms once value reaches cost times this. */
  trailArm: number;
  /** Sell when value falls to this share of its peak. */
  trail: number;
  /** Exit when net SOL over the fade window falls below minus this. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Exit after this many slots held, unless the position is up enough. */
  maxHold: number;
  /** The time limit does not apply while value is at least cost times this. */
  holdIfUp: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while the position's close value is at least cost times this. */
  addIfUp: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
}

/** Settings traded with. Picked on the dev window with the local sim, preferring
 *  a flat region over the single best cell: take-profit 1.2x, 700-slot hold,
 *  0.9 trailing stop, 0.9 stop-loss scored +0.32 SOL on dev (53 coins, 203
 *  fills, 5.3% max drawdown), and the neighbouring cells at 600-800 slots
 *  and 0.85-0.9 stop-loss stayed positive too. */
export const DEFAULT_SURGE: SurgeParams = {
  window: 40,
  minNetSol: 0.5,
  minBuys: 4,
  minBuyers: 4,
  minPriceUp: 0.08,
  maxPriceUp: 2.0,
  accel: 1,
  nearHigh: 0.9,
  minRqSol: 1,
  maxRqSol: 80,
  minAge: 300,
  stakeSol: 0.6,
  firstSol: 0.2,
  addSol: 0.2,
  minBuySol: 0.02,
  buySlipBps: 1500,
  stopLoss: 0.9,
  takeProfit: 1.2,
  trailArm: 1.25,
  trail: 0.9,
  fadeWindow: 20,
  fadeNetSol: 1,
  maxHold: 700,
  holdIfUp: 1.2,
  addStep: 0.1,
  addIfUp: 1.05,
  addNetSol: 0.5,
  cooldown: 200,
  maxEntries: 2,
};

const LAMPORTS = 1e9;
/** Curve fees: 95 bps protocol + 30 bps creator. */
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peak: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastBuyPrice: number;
  lastValue: number;
}

export function createSurgeBot(p: SurgeParams = DEFAULT_SURGE): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Price of a curve from its reserves: SOL per token. */
  const priceOf = (vq: bigint, vt: bigint): number =>
    vt > 0n ? Number(vq) / Number(vt) : 0;

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const buyers = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || buyers.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    if (netNew <= 0 || netNew < p.accel * netOld) return false;
    return true;
  };

  /** Close value of a position in SOL, curve and tx fees deducted. */
  const closeValue = (
    state: BotState,
    mint: Pubkey,
    tokens: bigint,
  ): number => {
    const curve = state.curves.get(mint);
    if (curve === undefined) return 0;
    const vq = Number(curve.virtual_quote_reserves);
    const vt = Number(curve.virtual_token_reserves);
    const n = Number(tokens);
    const q = (n * vq) / (vt + n);
    return (q / LAMPORTS) * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / LAMPORTS;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: sell the whole position on the first trigger.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(state, mint, BigInt(pos.token_amount));
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peak) h.peak = value;
        h.lastValue = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value < cost * p.stopLoss) exit = true;
        if (!exit && value >= cost * p.takeProfit) exit = true;
        if (!exit && h.peak >= cost * p.trailArm && value < h.peak * p.trail) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * p.holdIfUp) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Then entries and add-ons, in the order the batch's events arrived.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = p.firstSol;
        } else {
          // Add into strength only: the price stepped up from the last buy,
          // the position is up, and net SOL still flows in.
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastBuyPrice * (1 + p.addStep)) continue;
          if (h.lastValue < (Number(pos.cost_lamports) / LAMPORTS) * p.addIfUp) continue;
          if (flow(t, now, p.window) < p.addNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, want);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
          max_slippage_bps: p.buySlipBps,
        });
        free -= amount + tx;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peak: 0,
            invested: amount,
            exiting: false,
            filled: false,
            lastBuyPrice: price,
            lastValue: 0,
          });
          t.entries++;
          slotsLeft--;
        } else {
          h.invested += amount;
          h.lastBuyPrice = price;
        }
      }
      return orders;
    },
  };
}
