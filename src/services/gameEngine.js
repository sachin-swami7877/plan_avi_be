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
 *    2. If admin is in SIGNIFICANT daily loss → conservative range
 *    3. If ANY bet ≥ ₹500 → tighter but varied distribution
 *    4. Balanced distribution: 40% below 2x, 10% above 6x (max 8x)
 *    5. No user-bet round → random 1–20x (cosmetic)
 *    6. 5-second gap between rounds
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
    // Bulk crash: next N user-bet rounds crash at same value
    this.adminBulkCrash = null; // { crashAt: Number, total: Number, remaining: Number }
    // Sequential crash: array of crash values consumed one per user-bet round
    this.adminSequentialCrashes = []; // [1.0, 1.3, 1.6, 5.0, ...]

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
    // Load persisted betsEnabled from database
    try {
      const AdminSettings = require('../models/AdminSettings');
      const settings = await AdminSettings.findOne({ key: 'main' });
      if (settings && typeof settings.betsEnabled === 'boolean') {
        this.betsEnabled = settings.betsEnabled;
        console.log(`🎮 Loaded betsEnabled from DB: ${this.betsEnabled}`);
      }
    } catch (err) {
      console.error('Failed to load betsEnabled from DB, defaulting to true:', err.message);
    }
    console.log('🎮 Game Engine Started (Admin-Optimized)');

    // Clean up orphaned "active" bets from previous server runs
    await this.cleanupOrphanedBets();

    this.runGameLoop();
  }

  /**
   * On server startup, find any bets still marked "active" that belong to
   * rounds that already crashed. These are orphans from a server restart
   * that happened mid-round. Mark them as "lost".
   */
  async cleanupOrphanedBets() {
    try {
      // Find all crashed rounds
      const crashedRounds = await GameRound.find({ status: 'crashed' }).select('_id');
      const crashedIds = crashedRounds.map((r) => r._id);

      if (crashedIds.length === 0) return;

      // Bulk-update any "active" bets in those rounds → "lost"
      const result = await Bet.updateMany(
        { gameRoundId: { $in: crashedIds }, status: 'active' },
        { $set: { status: 'lost', profit: 0 } }
      );

      if (result.modifiedCount > 0) {
        console.log(`🧹 Cleaned up ${result.modifiedCount} orphaned active bets from crashed rounds`);
      }

      // Also handle "running" or "waiting" rounds that were never completed (server crash)
      const staleRounds = await GameRound.find({ status: { $in: ['waiting', 'running'] } }).select('_id');
      if (staleRounds.length > 0) {
        const staleIds = staleRounds.map((r) => r._id);

        // Refund bets from stale waiting/running rounds
        const staleBets = await Bet.find({ gameRoundId: { $in: staleIds }, status: 'active' });
        for (const bet of staleBets) {
          try {
            const user = await User.findById(bet.userId);
            if (user) {
              user.creditEarnings(bet.amount);
              await user.save();
              await recordWalletTx(user._id, bet.amount, 'credit', 'bet_refund', `Refund for orphaned bet (server restart)`);
            }
            bet.status = 'lost';
            bet.profit = 0;
            await bet.save();
          } catch (refundErr) {
            console.error(`Failed to refund orphaned bet ${bet._id}:`, refundErr.message);
          }
        }

        // Mark stale rounds as crashed
        await GameRound.updateMany(
          { _id: { $in: staleIds } },
          { $set: { status: 'crashed', crashedAt: new Date() } }
        );

        if (staleBets.length > 0) {
          console.log(`🧹 Refunded ${staleBets.length} bets from ${staleRounds.length} stale rounds`);
        }
      }
    } catch (err) {
      console.error('Cleanup orphaned bets error:', err.message);
    }
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
    // ── PRIORITY 1: ADMIN SINGLE OVERRIDE (highest priority) ──
    if (this.adminNextCrash !== null) {
      const adminCrash = this.adminNextCrash;
      this.adminNextCrash = null; // consume it (one-time use)
      this.currentRound.crashMultiplier = Number(adminCrash.toFixed(2));
      await this.currentRound.save();
      console.log(`👑 ADMIN SINGLE OVERRIDE → crash at ${adminCrash.toFixed(2)}x`);
      return;
    }

    const bets = await Bet.find({ gameRoundId: this.currentRound._id });
    const hasRealBets = bets.length > 0;

    // ── PRIORITY 2: ADMIN SEQUENTIAL CRASHES (per-round values, only for user-bet rounds) ──
    if (this.adminSequentialCrashes.length > 0 && hasRealBets) {
      const crashVal = this.adminSequentialCrashes.shift(); // consume first value
      this.currentRound.crashMultiplier = Number(Number(crashVal).toFixed(2));
      await this.currentRound.save();
      console.log(`👑 ADMIN SEQUENTIAL [${this.adminSequentialCrashes.length} left] → crash at ${crashVal}x`);
      // Emit update to admin so UI stays in sync
      this.io.to('admins').emit('admin:crash-queue-update', this.getCrashQueueState());
      return;
    }

    // ── PRIORITY 3: ADMIN BULK CRASH (3 modes: exact, range, auto-random) ──
    if (this.adminBulkCrash && this.adminBulkCrash.remaining > 0 && hasRealBets) {
      const bulk = this.adminBulkCrash;
      bulk.remaining -= 1;

      let bulkCrashPoint;
      if (bulk.mode === 'exact') {
        // Fixed value every round
        bulkCrashPoint = bulk.crashAt;
      } else if (bulk.mode === 'range') {
        // Random within admin-set min-max range
        bulkCrashPoint = Number((bulk.min + Math.random() * (bulk.max - bulk.min)).toFixed(2));
      } else {
        // mode === 'auto' → balanced distribution (same as RULE 3)
        const r = Math.random();
        if (r < 0.20) bulkCrashPoint = Number((1.0 + Math.random() * 0.30).toFixed(2));
        else if (r < 0.40) bulkCrashPoint = Number((1.30 + Math.random() * 0.70).toFixed(2));
        else if (r < 0.60) bulkCrashPoint = Number((2.0 + Math.random() * 1.0).toFixed(2));
        else if (r < 0.75) bulkCrashPoint = Number((3.0 + Math.random() * 1.50).toFixed(2));
        else if (r < 0.90) bulkCrashPoint = Number((4.50 + Math.random() * 1.50).toFixed(2));
        else bulkCrashPoint = Number((6.0 + Math.random() * 1.0).toFixed(2));
      }

      this.currentRound.crashMultiplier = Number(bulkCrashPoint.toFixed(2));
      await this.currentRound.save();
      console.log(`👑 ADMIN BULK [${bulk.remaining}/${bulk.total} left] (${bulk.mode}) → crash at ${bulkCrashPoint}x`);
      if (bulk.remaining <= 0) {
        this.adminBulkCrash = null;
        console.log('👑 ADMIN BULK CRASH completed — cleared');
      }
      // Emit update to admin
      this.io.to('admins').emit('admin:crash-queue-update', this.getCrashQueueState());
      return;
    }

    let crashPoint;

    // ── RULE 0: No real bets → cosmetic round (balanced distribution) ──
    if (!hasRealBets) {
      const cosmeticRand = Math.random();
      if (cosmeticRand < 0.10) {
        crashPoint = 1.00;                                            // exactly 1x (10%)
      } else if (cosmeticRand < 0.30) {
        crashPoint = Number((1.0 + Math.random() * 2.0).toFixed(2)); // 1x–3x (20%)
      } else if (cosmeticRand < 0.40) {
        crashPoint = Number((3.0 + Math.random() * 1.0).toFixed(2)); // 3x–4x (10%)
      } else if (cosmeticRand < 0.55) {
        crashPoint = Number((4.0 + Math.random() * 2.0).toFixed(2)); // 4x–6x (15%)
      } else if (cosmeticRand < 0.85) {
        crashPoint = Number((6.0 + Math.random() * 4.0).toFixed(2)); // 6x–10x (30%)
      } else {
        crashPoint = Number((10.0 + Math.random() * 5.0).toFixed(2)); // 10x–15x (15%)
      }
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

    // ── RULE 3: Balanced distribution for all normal bets ──
    // Truly random feel — low crashes happen naturally, high crashes are rare
    // 40% crash below 2x → admin profits on most rounds
    // Only 10% go above 6x → rare big multipliers keep players engaged
    const rand = Math.random();
    if (rand < 0.20) {
      crashPoint = Number((1.0 + Math.random() * 0.30).toFixed(2));   // 1.00–1.30 (20%)
    } else if (rand < 0.40) {
      crashPoint = Number((1.30 + Math.random() * 0.70).toFixed(2));  // 1.30–2.00 (20%)
    } else if (rand < 0.60) {
      crashPoint = Number((2.0 + Math.random() * 1.0).toFixed(2));    // 2.00–3.00 (20%)
    } else if (rand < 0.75) {
      crashPoint = Number((3.0 + Math.random() * 1.50).toFixed(2));   // 3.00–4.50 (15%)
    } else if (rand < 0.90) {
      crashPoint = Number((4.50 + Math.random() * 1.50).toFixed(2));  // 4.50–6.00 (15%)
    } else {
      crashPoint = Number((6.0 + Math.random() * 1.0).toFixed(2));    // 6.00–7.00 (10%)
    }
    console.log(`🎲 Normal bets (max ₹${maxBet}) → crash at ${crashPoint}x`);

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
        // Safety cap at 15x — unless admin explicitly set a higher crash target
        const SAFETY_CAP = 15.0;
        const crashTarget = this.currentRound.crashMultiplier;
        const isAdminOverride = crashTarget > SAFETY_CAP; // admin set it high intentionally

        // Check crash FIRST — stop before emitting a value above crash target
        const hitCrash = this.currentMultiplier >= crashTarget;
        const hitSafetyCap = !isAdminOverride && this.currentMultiplier >= SAFETY_CAP;

        if (hitCrash || hitSafetyCap) {
          clearInterval(this.gameInterval);
          this.gameInterval = null;
          this.isRunning = false;
          if (hitSafetyCap && crashTarget > SAFETY_CAP) {
            this.currentRound.crashMultiplier = Number(this.currentMultiplier.toFixed(2));
          }
          this._resolveRunningPhase = null;
          resolve();
          return;
        }

        // Emit current multiplier (guaranteed below crash target)
        this.io.emit('game:tick', {
          multiplier: Number(this.currentMultiplier.toFixed(2)),
        });

        // Increment for next tick — speed ramps up at higher multipliers
        let speedMultiplier = 1;
        if (this.currentMultiplier >= 60) speedMultiplier = 4;
        else if (this.currentMultiplier >= 30) speedMultiplier = 3;
        else if (this.currentMultiplier >= 15) speedMultiplier = 2;
        else if (this.currentMultiplier >= 10) speedMultiplier = 1.5;
        this.currentMultiplier += this.MULTIPLIER_INCREMENT * speedMultiplier;
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

    if (activeBets.length > 0) {
      console.log(`💰 Settling ${activeBets.length} active bets as lost...`);
    }

    for (const bet of activeBets) {
      try {
        bet.status = 'lost';
        bet.profit = -bet.amount;
        await bet.save();

        this.io.to(`user_${bet.userId}`).emit('bet:lost', {
          amount: bet.amount,
          crashMultiplier,
        });
      } catch (settleErr) {
        console.error(`❌ Failed to settle bet ${bet._id}:`, settleErr.message);
      }
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
    user.smartDeduct(amount);
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
    user.creditEarnings(profit);
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

  // ── Bulk crash: 3 modes ──
  // mode 'exact': fixed crashAt for every round
  // mode 'range': random between min and max each round
  // mode 'auto':  balanced distribution each round
  setBulkCrash(count, { mode = 'exact', crashAt, min, max } = {}) {
    if (count < 1 || count > 100) throw new Error('Count must be between 1 and 100');
    if (mode === 'exact') {
      if (!crashAt || crashAt < 1) throw new Error('crashAt must be >= 1');
      this.adminBulkCrash = { mode, crashAt: Number(crashAt), total: Number(count), remaining: Number(count) };
      console.log(`👑 Admin set BULK crash: next ${count} rounds at exactly ${crashAt}x`);
    } else if (mode === 'range') {
      if (!min || !max || min < 1 || max < min) throw new Error('min must be >= 1 and max must be >= min');
      this.adminBulkCrash = { mode, min: Number(min), max: Number(max), total: Number(count), remaining: Number(count) };
      console.log(`👑 Admin set BULK crash: next ${count} rounds random ${min}x–${max}x`);
    } else {
      // auto mode
      this.adminBulkCrash = { mode: 'auto', total: Number(count), remaining: Number(count) };
      console.log(`👑 Admin set BULK crash: next ${count} rounds with auto balanced distribution`);
    }
  }

  clearBulkCrash() {
    this.adminBulkCrash = null;
    console.log('👑 Admin cleared bulk crash');
  }

  // ── Sequential crashes: specific values for each round ──
  setSequentialCrashes(values) {
    if (!Array.isArray(values) || values.length === 0) throw new Error('Provide an array of crash values');
    if (values.length > 100) throw new Error('Max 100 sequential values');
    for (const v of values) {
      if (Number(v) < 1) throw new Error('All crash values must be at least 1.00');
    }
    this.adminSequentialCrashes = values.map(v => Number(v));
    console.log(`👑 Admin set SEQUENTIAL crashes: [${values.join(', ')}]`);
  }

  clearSequentialCrashes() {
    this.adminSequentialCrashes = [];
    console.log('👑 Admin cleared sequential crashes');
  }

  getCrashQueueState() {
    return {
      adminNextCrash: this.adminNextCrash,
      bulkCrash: this.adminBulkCrash,
      sequentialCrashes: this.adminSequentialCrashes,
    };
  }

  getCurrentState() {
    return {
      round: this.currentRound,
      multiplier: Number(this.currentMultiplier.toFixed(2)),
      isRunning: this.isRunning,
      status: this.currentRound?.status || 'idle',
      betsEnabled: this.betsEnabled,
      adminNextCrash: this.adminNextCrash,
      bulkCrash: this.adminBulkCrash,
      sequentialCrashes: this.adminSequentialCrashes,
    };
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { GameEngine };
