const GameRound = require('../models/GameRound');
const Bet = require('../models/Bet');
const User = require('../models/User');
const GlobalStats = require('../models/GlobalStats');
const { recordWalletTx } = require('../utils/recordWalletTx');

/**
 * ═══════════════════════════════════════════════════════════════════
 *  ADMIN-OPTIMIZED GAME ENGINE
 *
 *  Profit-protection rules (priority order):
 *    1. No cashout below 1.00x
 *    2. If admin is in SIGNIFICANT daily loss → conservative range (not 1x only)
 *    3. If ANY bet ≥ ₹500 → tighter but varied distribution
 *    4. Base 10% of rounds crash at 1.00–1.20x
 *    5. If all bets are small (≤₹100) → generous multipliers (up to 7x)
 *    6. Normal bets → balanced distribution capped at 7.00x
 *    7. No user-bet round → random 1–20x (cosmetic)
 *    8. 5-second gap between rounds
 * ═══════════════════════════════════════════════════════════════════
 */

class GameEngine {
  constructor(io) {
    this.io = io;
    this.currentRound = null;
    this.currentMultiplier = 1.0;
    this.isRunning = false;
    this.gameInterval = null;
    this.roundBets = [];
    this.betsEnabled = true;
    this.adminNextCrash = null; // Admin-set crash point for the NEXT round

    // ── Timing ──
    this.WAITING_TIME = 5000;         // 5s betting window
    this.COUNTDOWN_SECONDS = 5;       // 5s gap between rounds
    this.TICK_INTERVAL = 100;         // 100ms per tick
    this.MULTIPLIER_INCREMENT = 0.03; // 0.3x per second (faster pace)

    // ── Profit-protection knobs ──
    this.MAX_MULTIPLIER_CAP = 7.0;    // Hard cap when users have bets
    this.HIGH_BET_THRESHOLD = 500;    // ₹500+
    this.LOSS_DAILY_THRESHOLD = -1000; // Trigger loss-recovery only if daily loss > ₹1000
    this.LOSS_RECENT_THRESHOLD = -500; // Trigger loss-recovery only if last-5 loss > ₹500
  }

  /* ═══════════════════════ LIFECYCLE ═══════════════════════ */

  async start() {
    console.log('🎮 Game Engine Started (Admin-Optimized)');
    this.runGameLoop();
  }

  async runGameLoop() {
    while (true) {
      try {
        // If bets are disabled, wait and check again
        if (!this.betsEnabled) {
          console.log('⏸️  Bets are disabled - pausing game loop');
          await this.delay(2000);
          continue;
        }

        // Phase 1: Betting window (5s)
        await this.waitingPhase();

        // Check again before running phase
        if (!this.betsEnabled) {
          if (this.currentRound && this.currentRound.status === 'waiting') {
            await this.forceCrashRound();
          }
          continue;
        }

        // Phase 2: Smart crash calculation AFTER all bets are in
        await this.smartRecalculateCrash();

        // Phase 3: Run the multiplier until crash
        await this.runningPhase();

        // Phase 4: 12-second countdown before next round
        // (handled inside handleCrash)
      } catch (err) {
        console.error('Game loop error (continuing):', err);
        this.isRunning = false;
        this.gameInterval = null;
        this._resolveRunningPhase = null;
        await this.delay(2000);
      }
    }
  }

  /* ═══════════════════════ BET CONTROL ═══════════════════════ */

  setBetsEnabled(enabled) {
    this.betsEnabled = enabled;
    this.io.to('admins').emit('settings:bets-enabled', { enabled });
    this.io.to('game').emit('settings:bets-enabled', { enabled });
    this.io.emit('settings:bets-enabled', { enabled });
    console.log(`⚙️  Bets ${enabled ? 'enabled' : 'disabled'}`);

    if (!enabled && this.isRunning && this.currentRound) {
      this.forceCrashRound().catch((err) => {
        console.error('Error crashing round:', err);
        this.isRunning = false;
        if (this.gameInterval) {
          clearInterval(this.gameInterval);
          this.gameInterval = null;
        }
      });
    }
  }

  getBetsEnabled() {
    return this.betsEnabled;
  }

  /* ═══════════════════════ WAITING PHASE ═══════════════════════ */

  async waitingPhase() {
    const roundId = `R${Date.now()}`;

    // Create round with a placeholder crash point (will be recalculated)
    this.currentRound = await GameRound.create({
      roundId,
      crashMultiplier: 5.0, // placeholder
      status: 'waiting',
    });

    this.roundBets = [];
    this.currentMultiplier = 1.0;

    // Broadcast waiting state
    this.io.emit('game:waiting', {
      roundId,
      countdown: this.WAITING_TIME / 1000,
    });

    console.log(`🎲 Round ${roundId} — Waiting for bets...`);

    // Wait for betting period
    await this.delay(this.WAITING_TIME);
  }

  /* ═════════════════ SMART CRASH CALCULATION ═════════════════ */

  async smartRecalculateCrash() {
    // ── ADMIN OVERRIDE: If admin set a specific crash point, use it ──
    if (this.adminNextCrash !== null) {
      const adminCrash = this.adminNextCrash;
      this.adminNextCrash = null; // consume it (one-time use)
      this.currentRound.crashMultiplier = Number(adminCrash.toFixed(2));
      await this.currentRound.save();
      console.log(`👑 ADMIN OVERRIDE → crash at ${adminCrash.toFixed(2)}x`);
      return;
    }

    const bets = await Bet.find({ gameRoundId: this.currentRound._id });

    let crashPoint;

    // ── RULE 0: No real bets → cosmetic round (1x – 20x) ──
    if (bets.length === 0) {
      crashPoint = Number((1 + Math.random() * 19).toFixed(2));
      console.log(`📈 No bets — cosmetic crash at ${crashPoint}x`);
      this.currentRound.crashMultiplier = crashPoint;
      await this.currentRound.save();
      return;
    }

    const maxBet = Math.max(...bets.map((b) => b.amount));

    // ── RULE 1: Loss recovery (only for SIGNIFICANT losses) ──
    const dailyPL = await this.getDailyProfitLoss();
    const last5PL = await this.getLastNRoundsPL(5);

    if (dailyPL < this.LOSS_DAILY_THRESHOLD || last5PL < this.LOSS_RECENT_THRESHOLD) {
      // Significant loss — be conservative but still varied
      const rand = Math.random();
      if (rand < 0.35) {
        crashPoint = Number((1.0 + Math.random() * 0.15).toFixed(2));  // 1.00–1.15 (35%)
      } else if (rand < 0.65) {
        crashPoint = Number((1.15 + Math.random() * 0.55).toFixed(2)); // 1.15–1.70 (30%)
      } else {
        crashPoint = Number((1.70 + Math.random() * 1.0).toFixed(2));  // 1.70–2.70 (35%)
      }
      console.log(
        `⚠️  Loss recovery (daily: ₹${dailyPL.toFixed(0)}, last5: ₹${last5PL.toFixed(0)}) → crash at ${crashPoint}x`
      );
      this.currentRound.crashMultiplier = crashPoint;
      await this.currentRound.save();
      return;
    }

    // ── RULE 2: High bet (≥₹500) → tighter but varied distribution ──
    if (maxBet >= this.HIGH_BET_THRESHOLD) {
      const rand = Math.random();
      if (rand < 0.30) {
        crashPoint = Number((1.0 + Math.random() * 0.20).toFixed(2));  // 1.00–1.20 (30%)
      } else if (rand < 0.60) {
        crashPoint = Number((1.20 + Math.random() * 0.80).toFixed(2)); // 1.20–2.00 (30%)
      } else {
        crashPoint = Number((2.0 + Math.random() * 1.50).toFixed(2));  // 2.00–3.50 (40%)
      }
      console.log(`💰 High bet ₹${maxBet} → crash at ${crashPoint}x`);
      this.currentRound.crashMultiplier = crashPoint;
      await this.currentRound.save();
      return;
    }

    // ── RULE 3: Base 10% crash at 1.00–1.20x (keeps house edge) ──
    if (Math.random() < 0.10) {
      crashPoint = Number((1.0 + Math.random() * 0.20).toFixed(2)); // 1.00–1.20
      console.log(`🎯 Base 10% rule → crash at ${crashPoint}x`);
      this.currentRound.crashMultiplier = crashPoint;
      await this.currentRound.save();
      return;
    }

    // ── RULE 4: Small bets (all ≤ ₹100) → generous multipliers ──
    const allSmallBets = bets.every((b) => b.amount <= 100);

    if (allSmallBets) {
      const rand = Math.random();
      if (rand < 0.10) {
        crashPoint = Number((1.0 + Math.random() * 0.30).toFixed(2));  // 1.00–1.30 (10%)
      } else if (rand < 0.30) {
        crashPoint = Number((1.30 + Math.random() * 0.70).toFixed(2)); // 1.30–2.00 (20%)
      } else if (rand < 0.55) {
        crashPoint = Number((2.0 + Math.random() * 1.50).toFixed(2));  // 2.00–3.50 (25%)
      } else if (rand < 0.80) {
        crashPoint = Number((3.50 + Math.random() * 2.0).toFixed(2));  // 3.50–5.50 (25%)
      } else {
        crashPoint = Number((5.50 + Math.random() * 1.50).toFixed(2)); // 5.50–7.00 (20%)
      }
      console.log(`🟢 Small bets (max ₹${maxBet}) → generous crash at ${crashPoint}x`);
    } else {
      // ── RULE 5: Medium bets → balanced distribution ──
      const rand = Math.random();
      if (rand < 0.15) {
        crashPoint = Number((1.0 + Math.random() * 0.30).toFixed(2));  // 1.00–1.30 (15%)
      } else if (rand < 0.40) {
        crashPoint = Number((1.30 + Math.random() * 0.70).toFixed(2)); // 1.30–2.00 (25%)
      } else if (rand < 0.65) {
        crashPoint = Number((2.0 + Math.random() * 1.50).toFixed(2));  // 2.00–3.50 (25%)
      } else if (rand < 0.85) {
        crashPoint = Number((3.50 + Math.random() * 2.0).toFixed(2));  // 3.50–5.50 (20%)
      } else {
        crashPoint = Number((5.50 + Math.random() * 1.50).toFixed(2)); // 5.50–7.00 (15%)
      }
      console.log(`🔵 Medium bets (max ₹${maxBet}) → crash at ${crashPoint}x`);
    }

    // ── Hard cap at 7x ──
    crashPoint = Math.min(crashPoint, this.MAX_MULTIPLIER_CAP);

    this.currentRound.crashMultiplier = Number(crashPoint.toFixed(2));
    await this.currentRound.save();
  }

  /* ═══════════════════ PROFIT/LOSS HELPERS ═══════════════════ */

  /**
   * Daily admin P&L: total bets received - total payouts (for won bets)
   * Positive = profit, Negative = loss
   */
  async getDailyProfitLoss() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const rounds = await GameRound.find({
      status: 'crashed',
      crashedAt: { $gte: todayStart },
      totalBetAmount: { $gt: 0 },
    });

    let adminPL = 0;
    for (const round of rounds) {
      adminPL += (round.totalBetAmount || 0) - (round.totalWinAmount || 0);
    }
    return adminPL;
  }

  /**
   * Last N rounds with real bets: admin P&L
   * Positive = profit, Negative = loss
   */
  async getLastNRoundsPL(n = 5) {
    const rounds = await GameRound.find({
      status: 'crashed',
      totalBetAmount: { $gt: 0 },
    })
      .sort({ crashedAt: -1 })
      .limit(n);

    let adminPL = 0;
    for (const round of rounds) {
      adminPL += (round.totalBetAmount || 0) - (round.totalWinAmount || 0);
    }
    return adminPL;
  }

  /* ═══════════════════════ RUNNING PHASE ═══════════════════════ */

  async runningPhase() {
    // Update round status
    this.currentRound.status = 'running';
    this.currentRound.startedAt = new Date();
    await this.currentRound.save();

    this.isRunning = true;
    this.currentMultiplier = 1.0;

    // Broadcast game start
    this.io.emit('game:start', {
      roundId: this.currentRound.roundId,
    });

    console.log(
      `🚀 Round ${this.currentRound.roundId} — Started (crash target: ${this.currentRound.crashMultiplier}x)`
    );

    // Run multiplier loop
    await new Promise((resolve) => {
      this._resolveRunningPhase = resolve;

      this.gameInterval = setInterval(() => {
        // Check crash FIRST — stop before emitting a value above crash target
        if (this.currentMultiplier >= this.currentRound.crashMultiplier) {
          clearInterval(this.gameInterval);
          this.gameInterval = null;
          this.isRunning = false;
          this._resolveRunningPhase = null;
          resolve();
          return;
        }

        // Emit current multiplier (guaranteed below crash target)
        this.io.emit('game:tick', {
          multiplier: Number(this.currentMultiplier.toFixed(2)),
        });

        // Increment for next tick
        this.currentMultiplier += this.MULTIPLIER_INCREMENT;
      }, this.TICK_INTERVAL);
    });

    await this.handleCrash();
  }

  /* ═══════════════════════ FORCE CRASH ═══════════════════════ */

  async forceCrashRound() {
    if (!this.isRunning || !this.currentRound) {
      throw new Error('No round is running');
    }

    // Stop ticks IMMEDIATELY — must happen before any async DB write
    if (this.gameInterval) {
      clearInterval(this.gameInterval);
      this.gameInterval = null;
    }
    this.isRunning = false;

    this.currentRound.crashMultiplier = Number(this.currentMultiplier.toFixed(2));

    if (this._resolveRunningPhase) {
      this._resolveRunningPhase();
      this._resolveRunningPhase = null;
    }
    // DB save happens in handleCrash() which runs after resolve
  }

  /* ═══════════════════════ CRASH HANDLER ═══════════════════════ */

  async handleCrash() {
    const crashMultiplier = this.currentRound.crashMultiplier;

    // Broadcast crash IMMEDIATELY via socket — before any DB writes
    // so the frontend stops the multiplier display instantly
    this.io.emit('game:crash', {
      roundId: this.currentRound.roundId,
      crashMultiplier: Number(crashMultiplier.toFixed(2)),
    });

    console.log(`💥 Round ${this.currentRound.roundId} — Crashed at ${crashMultiplier.toFixed(2)}x`);

    // Now do DB writes (these can take 50-200ms, frontend already knows to stop)
    this.currentRound.status = 'crashed';
    this.currentRound.crashedAt = new Date();
    await this.currentRound.save();

    // Settle all bets that didn't cash out — they lose
    const activeBets = await Bet.find({
      gameRoundId: this.currentRound._id,
      status: 'active',
    });

    for (const bet of activeBets) {
      bet.status = 'lost';
      bet.profit = -bet.amount;
      await bet.save();

      this.io.to(`user_${bet.userId}`).emit('bet:lost', {
        amount: bet.amount,
        crashMultiplier,
      });
    }

    // Update round totals
    const roundBets = await Bet.find({ gameRoundId: this.currentRound._id });
    let totalBetAmount = 0;
    let totalWinAmount = 0;

    for (const bet of roundBets) {
      totalBetAmount += bet.amount;
      if (bet.status === 'won') {
        totalWinAmount += bet.profit;
      }
    }

    this.currentRound.totalBetAmount = totalBetAmount;
    this.currentRound.totalWinAmount = totalWinAmount;
    await this.currentRound.save();

    // Update global stats
    await this.updateGlobalStats(roundBets);

    // Log admin P&L for this round
    const roundPL = totalBetAmount - totalWinAmount;
    console.log(
      `📊 Round P&L: bets ₹${totalBetAmount} − payouts ₹${totalWinAmount} = ${roundPL >= 0 ? '+' : ''}₹${roundPL.toFixed(2)}`
    );

    // ── 12-second countdown before next round ──
    for (let sec = this.COUNTDOWN_SECONDS; sec >= 1; sec--) {
      await this.delay(1000);
      this.io.emit('game:countdown', { secondsLeft: sec });
    }
  }

  /* ═══════════════════════ BET PLACEMENT ═══════════════════════ */

  async placeBet(userId, amount) {
    if (!this.betsEnabled) {
      throw new Error('Bets are currently paused');
    }
    if (!this.currentRound || this.currentRound.status !== 'waiting') {
      throw new Error('Cannot place bet now');
    }

    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');
    if (user.walletBalance < amount) throw new Error('Insufficient balance');

    // Check duplicate
    const existingBet = await Bet.findOne({
      userId,
      gameRoundId: this.currentRound._id,
    });
    if (existingBet) throw new Error('Already placed a bet this round');

    // Deduct balance & track cumulative bets
    const balBefore = user.walletBalance;
    user.walletBalance -= amount;
    user.totalBetAmount = (user.totalBetAmount || 0) + amount;
    await user.save();

    // Create bet
    const bet = await Bet.create({
      userId,
      gameRoundId: this.currentRound._id,
      amount,
      status: 'active',
    });

    await recordWalletTx(
      userId, 'debit', 'game_bet', amount,
      `Aviator bet of ₹${amount}`,
      balBefore, user.walletBalance, bet._id
    );

    this.roundBets.push(bet);
    return { bet, newBalance: user.walletBalance };
  }

  /* ═══════════════════════ CASH OUT ═══════════════════════ */

  async cashOut(userId) {
    if (!this.isRunning || !this.currentRound) {
      throw new Error('Game not running');
    }

    // ── Block cashout below 1.00x ──
    if (this.currentMultiplier < 1.0) {
      throw new Error('Cannot cash out below 1x');
    }

    const bet = await Bet.findOne({
      userId,
      gameRoundId: this.currentRound._id,
      status: 'active',
    });

    if (!bet) throw new Error('No active bet found');

    const cashOutMultiplier = this.currentMultiplier;
    const profit = bet.amount * cashOutMultiplier;

    // Update bet
    bet.status = 'won';
    bet.cashOutMultiplier = Number(cashOutMultiplier.toFixed(2));
    bet.profit = Number(profit.toFixed(2));
    await bet.save();

    // Add winnings to user
    const user = await User.findById(userId);
    const balBefore = user.walletBalance;
    user.walletBalance += profit;
    await user.save();

    await recordWalletTx(
      userId, 'credit', 'game_win', Number(profit.toFixed(2)),
      `Aviator win ₹${profit.toFixed(2)} at ${cashOutMultiplier.toFixed(2)}x`,
      balBefore, user.walletBalance, bet._id
    );

    return {
      bet,
      cashOutMultiplier: bet.cashOutMultiplier,
      profit: bet.profit,
      newBalance: user.walletBalance,
    };
  }

  /* ═══════════════════════ FORCE CRASH BET ═══════════════════════ */

  async forceCrashBet(betId) {
    const bet = await Bet.findById(betId);
    if (!bet || bet.status !== 'active') {
      throw new Error('Bet not found or not active');
    }

    bet.status = 'lost';
    bet.profit = -bet.amount;
    await bet.save();

    this.io.to(`user_${bet.userId}`).emit('bet:force-crashed', {
      amount: bet.amount,
    });

    return bet;
  }

  /* ═══════════════════════ GLOBAL STATS ═══════════════════════ */

  async updateGlobalStats(roundBets) {
    const betsPlaced = roundBets.length;
    const betsWon = roundBets.filter((b) => b.status === 'won').length;
    const totalBet = roundBets.reduce((sum, b) => sum + b.amount, 0);
    const totalWin = roundBets
      .filter((b) => b.status === 'won')
      .reduce((sum, b) => sum + b.profit, 0);

    await GlobalStats.findOneAndUpdate(
      { key: 'main' },
      {
        $inc: {
          totalBetsPlaced: betsPlaced,
          totalBetsWon: betsWon,
          totalBetAmount: totalBet,
          totalWinAmount: totalWin,
        },
      },
      { upsert: true }
    );
  }

  /* ═══════════════════════ STATE ═══════════════════════ */

  /* ═══════════════════ ADMIN NEXT-CRASH CONTROL ═══════════════════ */

  setNextCrash(multiplier) {
    if (multiplier < 1) throw new Error('Crash multiplier must be at least 1.00');
    this.adminNextCrash = Number(multiplier);
    console.log(`👑 Admin set NEXT round crash: ${multiplier}x`);
  }

  clearNextCrash() {
    this.adminNextCrash = null;
    console.log('👑 Admin cleared next round crash override');
  }

  getNextCrash() {
    return this.adminNextCrash;
  }

  getCurrentState() {
    return {
      round: this.currentRound,
      multiplier: Number(this.currentMultiplier.toFixed(2)),
      isRunning: this.isRunning,
      status: this.currentRound?.status || 'idle',
      betsEnabled: this.betsEnabled,
      adminNextCrash: this.adminNextCrash,
    };
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { GameEngine };
