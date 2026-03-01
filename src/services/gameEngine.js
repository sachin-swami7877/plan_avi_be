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
 *    2. If admin is in daily loss OR last-5-round loss → crash at 1.00–1.05
 *    3. If ANY bet ≥ ₹500 → 80% crash at 1.00x, 20% cap at 2.00x
 *    4. Base 30% of ALL rounds crash at 1.00x
 *    5. If all bets are small (≤₹100) → generous multipliers (up to 7x)
 *    6. Normal bets → standard distribution capped at 7.00x
 *    7. No user-bet round → random 1–20x (cosmetic)
 *    8. 12-second gap between rounds
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
    this.HIGH_BET_CRASH_RATE = 0.80;  // 80% crash at 1x for high bets
    this.BASE_CRASH_AT_1X_RATE = 0.30; // 30% rounds crash at 1x
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
    const totalBetAmount = bets.reduce((s, b) => s + b.amount, 0);

    // ── RULE 1: Daily P&L + Last-5 rounds check ──
    const dailyPL = await this.getDailyProfitLoss();
    const last5PL = await this.getLastNRoundsPL(5);

    if (dailyPL < 0 || last5PL < 0) {
      // Admin is in loss → crash early to recover
      crashPoint = Number((1.0 + Math.random() * 0.05).toFixed(2)); // 1.00–1.05
      console.log(
        `⚠️  Admin LOSS (daily: ₹${dailyPL.toFixed(0)}, last5: ₹${last5PL.toFixed(0)}) → crash at ${crashPoint}x to recover`
      );
      this.currentRound.crashMultiplier = crashPoint;
      await this.currentRound.save();
      return;
    }

    // ── RULE 2: High bet (≥₹500) → 80% crash at 1x ──
    if (maxBet >= this.HIGH_BET_THRESHOLD) {
      if (Math.random() < this.HIGH_BET_CRASH_RATE) {
        crashPoint = 1.0;
        console.log(`💰 High bet ₹${maxBet} → crash at 1.00x (80% rule)`);
      } else {
        // 20%: let it run but cap very low
        crashPoint = Number((1.0 + Math.random() * 1.0).toFixed(2)); // 1.00–2.00
        console.log(`💰 High bet ₹${maxBet} → capped crash at ${crashPoint}x (20% mercy)`);
      }
      this.currentRound.crashMultiplier = crashPoint;
      await this.currentRound.save();
      return;
    }

    // ── RULE 3: Base 30% crash at 1.00x ──
    if (Math.random() < this.BASE_CRASH_AT_1X_RATE) {
      crashPoint = Number((1.0 + Math.random() * 0.03).toFixed(2)); // 1.00–1.03
      console.log(`🎯 Base 30% rule → crash at ${crashPoint}x`);
      this.currentRound.crashMultiplier = crashPoint;
      await this.currentRound.save();
      return;
    }

    // ── RULE 4: Small bets (all ≤ ₹100) → generous multipliers ──
    const allSmallBets = bets.every((b) => b.amount <= 100);

    if (allSmallBets) {
      // Friendly for small bets — keeps users engaged / coming back
      const rand = Math.random();
      if (rand < 0.15) {
        crashPoint = Number((1.1 + Math.random() * 0.5).toFixed(2));   // 1.1–1.6
      } else if (rand < 0.40) {
        crashPoint = Number((1.6 + Math.random() * 1.4).toFixed(2));   // 1.6–3.0
      } else if (rand < 0.70) {
        crashPoint = Number((3.0 + Math.random() * 2.0).toFixed(2));   // 3.0–5.0
      } else {
        crashPoint = Number((5.0 + Math.random() * 2.0).toFixed(2));   // 5.0–7.0
      }
      console.log(`🟢 Small bets (max ₹${maxBet}) → generous crash at ${crashPoint}x`);
    } else {
      // ── RULE 5: Medium bets → standard distribution ──
      const rand = Math.random();
      if (rand < 0.30) {
        crashPoint = Number((1.05 + Math.random() * 0.45).toFixed(2)); // 1.05–1.50
      } else if (rand < 0.60) {
        crashPoint = Number((1.5 + Math.random() * 1.0).toFixed(2));   // 1.50–2.50
      } else if (rand < 0.85) {
        crashPoint = Number((2.5 + Math.random() * 2.0).toFixed(2));   // 2.50–4.50
      } else {
        crashPoint = Number((4.5 + Math.random() * 2.5).toFixed(2));   // 4.50–7.00
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
        // Emit current multiplier
        this.io.emit('game:tick', {
          multiplier: Number(this.currentMultiplier.toFixed(2)),
        });

        // Check crash
        if (this.currentMultiplier >= this.currentRound.crashMultiplier) {
          clearInterval(this.gameInterval);
          this.gameInterval = null;
          this.isRunning = false;
          this._resolveRunningPhase = null;
          resolve();
          return;
        }

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
    this.currentRound.crashMultiplier = Number(this.currentMultiplier.toFixed(2));
    await this.currentRound.save();

    if (this.gameInterval) {
      clearInterval(this.gameInterval);
      this.gameInterval = null;
    }
    this.isRunning = false;
    if (this._resolveRunningPhase) {
      this._resolveRunningPhase();
      this._resolveRunningPhase = null;
    }
  }

  /* ═══════════════════════ CRASH HANDLER ═══════════════════════ */

  async handleCrash() {
    const crashMultiplier = this.currentRound.crashMultiplier;

    this.currentRound.status = 'crashed';
    this.currentRound.crashedAt = new Date();
    await this.currentRound.save();

    // Broadcast crash
    this.io.emit('game:crash', {
      roundId: this.currentRound.roundId,
      crashMultiplier: Number(crashMultiplier.toFixed(2)),
    });

    console.log(`💥 Round ${this.currentRound.roundId} — Crashed at ${crashMultiplier.toFixed(2)}x`);

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
