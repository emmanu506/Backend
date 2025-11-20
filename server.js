const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('.'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initializeDatabase() {
  try {
    console.log('Initializing database tables...');
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        referral_code TEXT UNIQUE NOT NULL,
        referred_by INTEGER REFERENCES users(id),
        balance NUMERIC(10, 2) DEFAULT 0 NOT NULL,
        vip_level INTEGER DEFAULT 0 NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deposits (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        amount NUMERIC(10, 2) NOT NULL,
        status TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referral_rewards (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        referred_user_id INTEGER NOT NULL REFERENCES users(id),
        deposit_id INTEGER NOT NULL REFERENCES deposits(id),
        reward_amount NUMERIC(10, 2) NOT NULL,
        reward_level INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS team_bonuses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        bonus_amount NUMERIC(10, 2) NOT NULL,
        team_total NUMERIC(10, 2) NOT NULL,
        bonus_type TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON deposits(user_id);
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_deposits_created_at ON deposits(created_at);
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_referral_rewards_user_id ON referral_rewards(user_id);
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_team_bonuses_user_id ON team_bonuses(user_id);
    `);
    
    console.log('Database tables initialized successfully!');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

async function getUserLevel(userId, referrerId, level = 0) {
  if (!referrerId || level >= 3) return null;
  const result = await pool.query('SELECT id, referred_by FROM users WHERE id = $1', [referrerId]);
  if (result.rows.length === 0) return null;
  return { userId: referrerId, level: level + 1, nextReferrer: result.rows[0].referred_by };
}

app.post('/api/register', async (req, res) => {
  const { username, referralCode } = req.body;
  
  try {
    let referrerId = null;
    
    if (referralCode) {
      const referrerResult = await pool.query('SELECT id FROM users WHERE referral_code = $1', [referralCode]);
      if (referrerResult.rows.length > 0) {
        referrerId = referrerResult.rows[0].id;
      }
    }
    
    const newReferralCode = generateReferralCode();
    const result = await pool.query(
      'INSERT INTO users (username, email, referral_code, referred_by, balance, vip_level) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [username, `${username}@temp.com`, newReferralCode, referrerId, 0, 0]
    );
    
    res.json({ 
      success: true, 
      user: result.rows[0],
      referralLink: `https://refferaltest.onrender.com/?ref=${newReferralCode}`
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/api/deposit', async (req, res) => {
  const { userId, amount } = req.body;
  
  try {
    const depositResult = await pool.query(
      'INSERT INTO deposits (user_id, amount, status, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
      [userId, amount, 'completed']
    );
    
    const deposit = depositResult.rows[0];
    
    await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, userId]);
    
    const userResult = await pool.query('SELECT referred_by, vip_level FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    
    if (user.vip_level === 0 && amount >= 100) {
      await pool.query('UPDATE users SET vip_level = 1 WHERE id = $1', [userId]);
    }
    
    const rewards = [];
    let currentReferrer = user.referred_by;
    let level = 1;
    const percentages = [0.16, 0.03, 0.02];
    
    while (currentReferrer && level <= 3) {
      const rewardAmount = amount * percentages[level - 1];
      
      await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [rewardAmount, currentReferrer]);
      
      await pool.query(
        'INSERT INTO referral_rewards (user_id, referred_user_id, deposit_id, reward_amount, reward_level, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
        [currentReferrer, userId, deposit.id, rewardAmount, level]
      );
      
      rewards.push({ referrerId: currentReferrer, level, amount: rewardAmount });
      
      const nextResult = await pool.query('SELECT referred_by FROM users WHERE id = $1', [currentReferrer]);
      currentReferrer = nextResult.rows.length > 0 ? nextResult.rows[0].referred_by : null;
      level++;
    }
    
    const teamBonuses = [
      { threshold: 2000, reward: 12 },
      { threshold: 5000, reward: 40 },
      { threshold: 10000, reward: 200 },
      { threshold: 20000, reward: 500 },
      { threshold: 50000, reward: 1000 },
      { threshold: 100000, reward: 2500 },
      { threshold: 200000, reward: 5500 }
    ];
    
    if (user.referred_by) {
      const teamStatsResult = await pool.query(
        `SELECT SUM(d.amount) as total 
         FROM deposits d 
         JOIN users u ON d.user_id = u.id 
         WHERE u.referred_by = $1 
         AND d.created_at > NOW() - INTERVAL '24 hours'`,
        [user.referred_by]
      );
      
      const teamTotal = parseFloat(teamStatsResult.rows[0].total || 0);
      
      for (const bonus of teamBonuses) {
        if (teamTotal >= bonus.threshold) {
          const alreadyGiven = await pool.query(
            `SELECT * FROM team_bonuses 
             WHERE user_id = $1 
             AND team_total = $2 
             AND created_at > NOW() - INTERVAL '24 hours'`,
            [user.referred_by, bonus.threshold]
          );
          
          if (alreadyGiven.rows.length === 0) {
            await pool.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [bonus.reward, user.referred_by]);
            
            await pool.query(
              'INSERT INTO team_bonuses (user_id, bonus_amount, team_total, bonus_type, created_at) VALUES ($1, $2, $3, $4, NOW())',
              [user.referred_by, bonus.reward, bonus.threshold, '24h_bonus']
            );
          }
        }
      }
    }
    
    res.json({ 
      success: true, 
      deposit,
      rewards,
      message: 'Deposit completed and rewards distributed'
    });
  } catch (error) {
    console.error('Deposit error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/user/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    const rewardsResult = await pool.query(
      'SELECT * FROM referral_rewards WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [userId]
    );
    
    const teamSizeResult = await pool.query(
      `WITH RECURSIVE team AS (
        SELECT id, referred_by, vip_level FROM users WHERE id = $1
        UNION ALL
        SELECT u.id, u.referred_by, u.vip_level FROM users u
        INNER JOIN team t ON u.referred_by = t.id
      )
      SELECT COUNT(*) as count FROM team WHERE vip_level >= 1 AND id != $1`,
      [userId]
    );
    
    const teamTotalResult = await pool.query(
      `WITH RECURSIVE team AS (
        SELECT id FROM users WHERE id = $1
        UNION ALL
        SELECT u.id FROM users u
        INNER JOIN team t ON u.referred_by = t.id
      )
      SELECT SUM(d.amount) as total FROM deposits d
      WHERE d.user_id IN (SELECT id FROM team WHERE id != $1)`,
      [userId]
    );
    
    res.json({
      success: true,
      user,
      rewards: rewardsResult.rows,
      teamSize: parseInt(teamSizeResult.rows[0].count),
      teamTotal: parseFloat(teamTotalResult.rows[0].total || 0),
      referralLink: `https://refferaltest.onrender.com/?ref=${user.referral_code}`
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/user-by-username/:username', async (req, res) => {
  const { username } = req.params;
  
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    res.json({ success: true, user: userResult.rows[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT}`);
  await initializeDatabase();
});
