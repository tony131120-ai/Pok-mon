import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { Server as SocketServer } from 'socket.io';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);

const io = new SocketServer(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

const JWT_SECRET =
  process.env.JWT_SECRET || 'change-this-secret-on-render';

const TCG = 'https://api.tcgdex.net/v2/en';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

/* =========================================================
   PACKS
========================================================= */

const packNames = [
  ['Rayquaza VMAX Sky',30000,'sv6','Rayquaza VMAX'],
  ['Charizard Gold',1500000,'swsh3','Charizard VMAX'],
  ['Moonbreon Vault',750000,'swsh7','Umbreon VMAX'],
  ['Pikachu Crown',500000,'swsh8','Pikachu VMAX'],
  ['Lugia Silver',420000,'swsh12','Lugia VSTAR'],
  ['Giratina Lost',390000,'swsh11','Giratina VSTAR'],
  ['Mew Fusion',350000,'swsh8','Mew VMAX'],
  ['Gengar Fusion',330000,'swsh8','Gengar VMAX'],
  ['Rayquaza Evolving',280000,'swsh7','Rayquaza VMAX'],
  ['Sylveon Evolving',240000,'swsh7','Sylveon VMAX'],
  ['Eevee Heroes',200000,'swsh6','Umbreon VMAX'],
  ['Charizard Darkness',180000,'swsh3','Charizard VMAX'],
  ['Shining Fates',160000,'swsh45','Charizard VMAX'],
  ['Celebrations',140000,'cel25','Charizard'],
  ['Base Set Vault',120000,'base1','Charizard'],
  ['Scarlet Elite',100000,'sv1','Miraidon ex'],
  ['Paldea Evolved',85000,'sv2','Iono'],
  ['Obsidian Flames',75000,'sv3','Charizard ex'],
  ['Paradox Rift',65000,'sv4','Gholdengo ex'],
  ['Temporal Forces',60000,'sv5','Raging Bolt ex'],
  ['Twilight Masquerade',55000,'sv6','Greninja ex'],
  ['Stellar Crown',50000,'sv7','Terapagos ex'],
  ['Surging Sparks',45000,'sv8','Pikachu ex'],
  ['Prismatic Echo',40000,'sv8pt5','Umbreon ex'],
  ['Destined Rivals',35000,'sv10',"Team Rocket's Mewtwo ex"],
  ['Mega Evolution',30000,'sv8pt5','Mega Lucario ex'],
  ['Classic Hits',25000,'swsh12','Charizard'],
  ['Modern Hits',20000,'sv4','Groudon ex'],
  ['Budget Shine',12000,'sv2','Magikarp'],
  ['Starter Pack',5000,'sv1','Pikachu']
];

const packs = packNames
  .map((x, i) => ({
    id: i + 1,
    name: x[0],
    price: x[1],
    set: x[2],
    chase: x[3],
    n: 7 + (i % 2)
  }))
  .sort((a, b) => a.price - b.price);

/* =========================================================
   DATABASE
========================================================= */

async function setupDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL이 Render에 설정되어 있지 않습니다.');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id SERIAL PRIMARY KEY,
      username VARCHAR(32) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      cash BIGINT NOT NULL DEFAULT 100000,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inventory(
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL,
      card_name TEXT NOT NULL,
      image TEXT,
      rarity TEXT,
      price BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS inventory_user_idx
      ON inventory(user_id);
  `);

  const columns = [
    ['category', "TEXT NOT NULL DEFAULT ''"],
    ['hp', 'INTEGER NOT NULL DEFAULT 0'],
    ['types', "JSONB NOT NULL DEFAULT '[]'::jsonb"],
    ['attacks', "JSONB NOT NULL DEFAULT '[]'::jsonb"],
    ['weaknesses', "JSONB NOT NULL DEFAULT '[]'::jsonb"],
    ['resistances', "JSONB NOT NULL DEFAULT '[]'::jsonb"]
  ];

  for (const [name, definition] of columns) {
    await pool.query(
      `ALTER TABLE inventory ADD COLUMN IF NOT EXISTS ${name} ${definition}`
    );
  }
}

/* =========================================================
   CARD API / CACHE
========================================================= */

let cardCache = null;

const detailCache = new Map();

async function getCards() {
  if (cardCache) return cardCache;

  const r = await fetch(`${TCG}/cards`);

  if (!r.ok) {
    throw new Error('TCGdex cards failed');
  }

  const data = await r.json();

  cardCache = Array.isArray(data)
    ? data
        .filter(c => c?.id)
        .slice(0, 15000)
    : [];

  return cardCache;
}

async function getCardDetail(cardId) {
  if (!cardId) return null;

  if (detailCache.has(cardId)) {
    return detailCache.get(cardId);
  }

  const r = await fetch(
    `${TCG}/cards/${encodeURIComponent(cardId)}`
  );

  if (!r.ok) {
    return null;
  }

  const card = await r.json();

  detailCache.set(cardId, card);

  return card;
}

function imageUrl(c, quality = 'high', ext = 'webp') {
  const base = String(c?.image || '').replace(/\/$/, '');

  if (!base) return '';

  if (/\.(webp|png|jpg|jpeg)$/i.test(base)) {
    return base;
  }

  return `${base}/${quality}.${ext}`;
}

function imageCandidates(c) {
  const base = String(c?.image || '').replace(/\/$/, '');

  if (!base) return [];

  if (/\.(webp|png|jpg|jpeg)$/i.test(base)) {
    return [base];
  }

  return [
    `${base}/high.webp`,
    `${base}/high.png`,
    `${base}/low.webp`,
    `${base}/low.png`,
    `${base}/high.jpg`
  ];
}

/* =========================================================
   AUTH
========================================================= */

function tokenFor(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username
    },
    JWT_SECRET,
    {
      expiresIn: '7d'
    }
  );
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';

    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({
        error: '인증 필요'
      });
    }

    const token = header.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);

    const q = await pool.query(
      'SELECT id, username, cash FROM users WHERE id=$1',
      [payload.id]
    );

    if (!q.rowCount) {
      return res.status(401).json({
        error: '인증 필요'
      });
    }

    req.user = q.rows[0];

    next();
  } catch {
    res.status(401).json({
      error: '인증 필요'
    });
  }
}

/* =========================================================
   BASIC API
========================================================= */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true
  });
});

app.get('/api/packs', (req, res) => {
  res.json(packs);
});

app.get('/api/cards', async (req, res) => {
  try {
    const cards = await getCards();

    res.json(
      cards.map(c => ({
        ...c,
        image: imageUrl(c)
      }))
    );
  } catch {
    res.status(502).json({
      error: '카드 데이터를 불러오지 못했습니다.'
    });
  }
});

/* =========================================================
   SIGNUP
========================================================= */

app.post('/api/signup', async (req, res) => {
  const {
    username,
    password
  } = req.body || {};

  if (
    !/^[\w가-힣]{3,32}$/.test(username || '') ||
    (password || '').length < 4
  ) {
    return res.status(400).json({
      error: '닉네임 3~32자, 비밀번호 4자 이상'
    });
  }

  try {
    const hash = await bcrypt.hash(password, 10);

    const q = await pool.query(
      `
      INSERT INTO users(username,password_hash)
      VALUES($1,$2)
      RETURNING id,username,cash
      `,
      [username, hash]
    );

    res.json({
      token: tokenFor(q.rows[0]),
      user: q.rows[0]
    });
  } catch {
    res.status(409).json({
      error: '이미 사용 중인 닉네임입니다.'
    });
  }
});

/* =========================================================
   LOGIN
========================================================= */

app.post('/api/login', async (req, res) => {
  const {
    username,
    password
  } = req.body || {};

  const q = await pool.query(
    `
    SELECT id,username,cash,password_hash
    FROM users
    WHERE username=$1
    `,
    [username]
  );

  if (
    !q.rowCount ||
    !(await bcrypt.compare(
      password || '',
      q.rows[0].password_hash
    ))
  ) {
    return res.status(401).json({
      error: '닉네임 또는 비밀번호가 올바르지 않습니다.'
    });
  }

  const {
    password_hash,
    ...user
  } = q.rows[0];

  res.json({
    token: tokenFor(user),
    user
  });
});

/* =========================================================
   ME
========================================================= */

app.get('/api/me', auth, async (req, res) => {
  const inv = await pool.query(
    `
    SELECT
      id,
      card_id,
      card_name,
      image,
      rarity,
      price,
      category,
      hp,
      types,
      attacks,
      weaknesses,
      resistances
    FROM inventory
    WHERE user_id=$1
    ORDER BY id DESC
    `,
    [req.user.id]
  );

  res.json({
    user: req.user,
    inventory: inv.rows
  });
});

/* =========================================================
   PACK OPENING
========================================================= */

function commonPool(cards) {
  return cards.filter(c => {
    const r = String(c.rarity || '').toLowerCase();
    const n = String(c.name || '').toLowerCase();

    return (
      !/(secret|ultra|illustration|special|hyper|radiant|amazing|shining|vmax|vstar|ex)/.test(
        r + ' ' + n
      ) &&
      !/^(rare holo|double rare|ultra rare)/i.test(r)
    );
  });
}

function rarePool(cards) {
  return cards.filter(c => {
    const r = String(c.rarity || '').toLowerCase();
    const n = String(c.name || '').toLowerCase();

    return /(rare|holo|ex|vmax|vstar|illustration|secret|ultra|special|hyper|radiant|amazing|shining)/.test(
      r + ' ' + n
    );
  });
}

function tier(p) {
  return Math.min(
    1,
    0.01 + Math.sqrt(p.price / 1500000) * 0.27
  );
}

function priceFor(c, p, final) {
  const r = String(c.rarity || '').toLowerCase();

  let mult = final
    ? 0.7 + Math.random() * 1.2
    : 0.02 + Math.random() * 0.08;

  if (/secret|special|hyper|illustration|ultra/.test(r)) {
    mult *= final
      ? 2 + Math.random() * 5
      : 1;
  }

  if (/vmax|vstar|ex/.test(
    String(c.name || '').toLowerCase() + ' ' + r
  )) {
    mult *= final ? 1.4 : 1;
  }

  return Math.max(
    50,
    Math.round(p.price * mult)
  );
}

app.post('/api/open', auth, async (req, res) => {
  try {
    const p = packs.find(
      x => x.id === Number(req.body.packId)
    );

    if (!p) {
      return res.status(404).json({
        error: '팩 없음'
      });
    }

    if (Number(req.user.cash) < p.price) {
      return res.status(400).json({
        error: '돈이 부족합니다.'
      });
    }

    const all = await getCards();

    const normal = commonPool(all);
    const rare = rarePool(all);

    if (!normal.length || !rare.length) {
      throw new Error('pool empty');
    }

    const out = [];

    for (let i = 0; i < p.n - 1; i++) {
      const c =
        normal[
          Math.floor(
            Math.random() * normal.length
          )
        ];

      out.push({
        ...c,
        image: imageUrl(c),
        gamePrice: priceFor(c, p, false),
        final: false
      });
    }

    const premium = Math.random() < tier(p);

    let candidates = rare;

    if (!premium) {
      const lowerRare = rare.filter(c => {
        const r = String(c.rarity || '').toLowerCase();
        const n = String(c.name || '').toLowerCase();

        return !/(secret|special|hyper|illustration|ultra|vmax|vstar|ex)/.test(
          r + ' ' + n
        );
      });

      if (lowerRare.length) {
        candidates = lowerRare;
      }
    }

    const c =
      candidates[
        Math.floor(
          Math.random() * candidates.length
        )
      ];

    out.push({
      ...c,
      image: imageUrl(c),
      gamePrice: priceFor(c, p, true),
      final: true,
      premium
    });

    await pool.query(
      `
      UPDATE users
      SET cash=cash-$1
      WHERE id=$2
      `,
      [p.price, req.user.id]
    );

    await broadcastRanking();

    res.json({
      pack: p,
      cards: out
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: '팩 개봉 중 오류가 발생했습니다.'
    });
  }
});

/* =========================================================
   CLAIM CARD
========================================================= */

app.post('/api/claim', auth, async (req, res) => {
  const c = req.body?.card;

  if (!c?.id) {
    return res.status(400).json({
      error: '카드 없음'
    });
  }

  try {
    const detail =
      await getCardDetail(c.id);

    const image =
      imageUrl(detail || c);

    const category =
      detail?.category ||
      c.category ||
      '';

    const hp =
      Number(detail?.hp || c.hp || 0);

    const types =
      detail?.types ||
      c.types ||
      [];

    const attacks =
      detail?.attacks ||
      c.attacks ||
      [];

    const weaknesses =
      detail?.weaknesses ||
      c.weaknesses ||
      [];

    const resistances =
      detail?.resistances ||
      c.resistances ||
      [];

    await pool.query(
      `
      INSERT INTO inventory(
        user_id,
        card_id,
        card_name,
        image,
        rarity,
        price,
        category,
        hp,
        types,
        attacks,
        weaknesses,
        resistances
      )
      VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
      )
      `,
      [
        req.user.id,
        c.id,
        c.name || detail?.name || 'Unknown',
        image,
        c.rarity || detail?.rarity || '',
        Math.max(
          0,
          Number(c.gamePrice) || 0
        ),
        category,
        hp,
        JSON.stringify(types),
        JSON.stringify(attacks),
        JSON.stringify(weaknesses),
        JSON.stringify(resistances)
      ]
    );

    const q = await pool.query(
      `
      SELECT id,username,cash
      FROM users
      WHERE id=$1
      `,
      [req.user.id]
    );

    res.json({
      user: q.rows[0]
    });

    await broadcastRanking();
  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: '카드를 저장하지 못했습니다.'
    });
  }
});

/* =========================================================
   SELL
========================================================= */

app.post('/api/sell/:id', auth, async (req, res) => {
  const id = Number(req.params.id);

  const q = await pool.query(
    `
    DELETE FROM inventory
    WHERE id=$1 AND user_id=$2
    RETURNING price
    `,
    [id, req.user.id]
  );

  if (!q.rowCount) {
    return res.status(404).json({
      error: '카드 없음'
    });
  }

  const u = await pool.query(
    `
    UPDATE users
    SET cash=cash+$1
    WHERE id=$2
    RETURNING id,username,cash
    `,
    [
      q.rows[0].price,
      req.user.id
    ]
  );

  res.json({
    user: u.rows[0]
  });

  await broadcastRanking();
});

/* =========================================================
   RANKING
========================================================= */

async function ranking() {
  const q = await pool.query(
    `
    SELECT username,cash
    FROM users
    ORDER BY cash DESC,id ASC
    LIMIT 50
    `
  );

  return q.rows;
}

async function broadcastRanking() {
  try {
    io.emit(
      'ranking',
      await ranking()
    );
  } catch (e) {
    console.error('ranking error', e);
  }
}

/* =========================================================
   ONLINE
========================================================= */

const online = new Map();

function onlineList() {
  return [...online.values()].map(x => ({
    id: x.userId,
    username: x.username
  }));
}

function userSocket(userId) {
  const x = online.get(Number(userId));

  return x?.socketId || null;
}

/* =========================================================
   BATTLE STATE
========================================================= */

const pendingRequests = new Map();
const battles = new Map();

function battleForUser(userId) {
  for (const battle of battles.values()) {
    if (
      battle.p1.id === Number(userId) ||
      battle.p2.id === Number(userId)
    ) {
      return battle;
    }
  }

  return null;
}

function otherPlayer(battle, userId) {
  return battle.p1.id === Number(userId)
    ? battle.p2
    : battle.p1;
}

function playerOf(battle, userId) {
  return battle.p1.id === Number(userId)
    ? battle.p1
    : battle.p2;
}

function battleBroadcast(
  battle,
  event,
  data
) {
  const s1 = userSocket(battle.p1.id);
  const s2 = userSocket(battle.p2.id);

  if (s1) {
    io.to(s1).emit(event, data);
  }

  if (s2) {
    io.to(s2).emit(event, data);
  }
}

function cleanBattleCard(card) {
  if (!card) return null;

  return {
    inventoryId: Number(card.inventoryId),
    cardId: card.cardId,
    name: card.name,
    image: imageUrl(card),
    rarity: card.rarity || '',
    hp: Number(card.hp || 0),
    maxHp: Number(card.hp || 0),
    currentHp: Number(card.currentHp ?? card.hp ?? 0),
    types: Array.isArray(card.types)
      ? card.types
      : [],
    attacks: Array.isArray(card.attacks)
      ? card.attacks
      : [],
    weaknesses: Array.isArray(card.weaknesses)
      ? card.weaknesses
      : [],
    resistances: Array.isArray(card.resistances)
      ? card.resistances
      : []
  };
}

function battleStateFor(
  battle,
  userId
) {
  const me =
    playerOf(battle, userId);

  const opponent =
    otherPlayer(battle, userId);

  const myDeck =
    me.deck || [];

  const opponentDeck =
    opponent.deck || [];

  return {
    id: battle.id,
    status: battle.status,
    turn: battle.turn,
    me: {
      username: me.username,
      deck: myDeck.map(cleanBattleCard),
      active: cleanBattleCard(me.active),
      activeSlot: me.activeSlot
    },
    opponent: {
      username: opponent.username,
      deckCount: opponentDeck.length,
      active: cleanBattleCard(opponent.active),
      activeSlot: opponent.activeSlot
    }
  };
}

async function loadInventoryCards(
  userId,
  ids
) {
  const cleanIds = [
    ...new Set(
      ids.map(Number)
    )
  ];

  if (cleanIds.length !== 6) {
    throw new Error(
      '포켓몬 카드 6장을 선택해야 합니다.'
    );
  }

  const q = await pool.query(
    `
    SELECT
      id,
      card_id,
      card_name,
      image,
      rarity,
      price,
      category,
      hp,
      types,
      attacks,
      weaknesses,
      resistances
    FROM inventory
    WHERE user_id=$1
      AND id = ANY($2::bigint[])
    `,
    [
      userId,
      cleanIds
    ]
  );

  if (q.rows.length !== 6) {
    throw new Error(
      '보유하지 않은 카드가 포함되어 있습니다.'
    );
  }

  const result = [];

  for (const row of q.rows) {
    let card = {
      inventoryId: Number(row.id),
      cardId: row.card_id,
      name: row.card_name,
      image: row.image,
      rarity: row.rarity,
      hp: Number(row.hp || 0),
      types: row.types || [],
      attacks: row.attacks || [],
      weaknesses: row.weaknesses || [],
      resistances: row.resistances || [],
      category: row.category || ''
    };

    if (
      String(card.category).toLowerCase() !==
        'pokemon' ||
      !card.hp
    ) {
      const detail =
        await getCardDetail(
          card.cardId
        );

      if (detail) {
        card = {
          ...card,
          name:
            detail.name ||
            card.name,
          image:
            imageUrl(detail) ||
            card.image,
          category:
            detail.category ||
            card.category,
          hp:
            Number(detail.hp) ||
            card.hp,
          types:
            detail.types ||
            card.types ||
            [],
          attacks:
            detail.attacks ||
            card.attacks ||
            [],
          weaknesses:
            detail.weaknesses ||
            card.weaknesses ||
            [],
          resistances:
            detail.resistances ||
            card.resistances ||
            []
        };

        await pool.query(
          `
          UPDATE inventory
          SET
            category=$1,
            hp=$2,
            types=$3,
            attacks=$4,
            weaknesses=$5,
            resistances=$6,
            image=$7
          WHERE id=$8
          `,
          [
            card.category,
            card.hp,
            JSON.stringify(card.types),
            JSON.stringify(card.attacks),
            JSON.stringify(card.weaknesses),
            JSON.stringify(card.resistances),
            card.image,
            card.inventoryId
          ]
        );
      }
    }

    if (
      String(card.category).toLowerCase() !==
      'pokemon'
    ) {
      throw new Error(
        `${card.name}은(는) 포켓몬 카드가 아닙니다.`
      );
    }

    if (!Number(card.hp)) {
      throw new Error(
        `${card.name}의 HP 정보를 가져오지 못했습니다.`
      );
    }

    result.push(card);
  }

  return result;
}

function shuffle(arr) {
  const a = [...arr];

  for (
    let i = a.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(
        Math.random() * (i + 1)
      );

    [a[i], a[j]] =
      [a[j], a[i]];
  }

  return a;
}

function parseDamage(value) {
  if (
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    return value;
  }

  const text =
    String(value ?? '');

  const m =
    text.match(/\d+/);

  return m
    ? Number(m[0])
    : 0;
}

function hasType(
  list,
  type
) {
  return Array.isArray(list) &&
    list.some(
      x =>
        String(
          x?.type || x
        ).toLowerCase() ===
        String(type).toLowerCase()
    );
}

function weaknessMultiplier(
  defender,
  attacker
) {
  let multiplier = 1;

  const attackerTypes =
    attacker.types || [];

  const weaknesses =
    defender.weaknesses || [];

  for (const type of attackerTypes) {
    const w =
      weaknesses.find(
        x =>
          String(
            x?.type || ''
          ).toLowerCase() ===
          String(type).toLowerCase()
      );

    if (w) {
      const value =
        String(
          w.value || '×2'
        );

      if (
        value.includes('×2') ||
        value.includes('x2') ||
        value.includes('2')
      ) {
        multiplier *= 2;
      }
    }
  }

  return multiplier;
}

function resistanceAmount(
  defender,
  attacker
) {
  const attackerTypes =
    attacker.types || [];

  const resistances =
    defender.resistances || [];

  let amount = 0;

  for (const type of attackerTypes) {
    const r =
      resistances.find(
        x =>
          String(
            x?.type || ''
          ).toLowerCase() ===
          String(type).toLowerCase()
      );

    if (r) {
      const value =
        String(
          r.value || '-20'
        );

      const m =
        value.match(/-?\d+/);

      if (m) {
        amount +=
          Number(m[0]);
      }
    }
  }

  return amount;
}

function calculateDamage(
  attacker,
  defender,
  attack
) {
  const base =
    parseDamage(
      attack?.damage
    );

  if (base <= 0) {
    return {
      base: 0,
      weakness: 1,
      resistance: 0,
      damage: 0
    };
  }

  const weakness =
    weaknessMultiplier(
      defender,
      attacker
    );

  const resistance =
    resistanceAmount(
      defender,
      attacker
    );

  const afterWeakness =
    base * weakness;

  const finalDamage =
    Math.max(
      0,
      Math.round(
        afterWeakness +
        resistance
      )
    );

  return {
    base,
    weakness,
    resistance,
    damage: finalDamage
  };
}

/* =========================================================
   SOCKET.IO
========================================================= */

io.on(
  'connection',
  socket => {

    socket.on(
      'auth',
      async token => {
        try {
          const payload =
            jwt.verify(
              token,
              JWT_SECRET
            );

          const q =
            await pool.query(
              `
              SELECT id,username
              FROM users
              WHERE id=$1
              `,
              [payload.id]
            );

          if (!q.rowCount) {
            return;
          }

          const user =
            q.rows[0];

          online.set(
            Number(user.id),
            {
              userId:
                Number(user.id),
              username:
                user.username,
              socketId:
                socket.id
            }
          );

          socket.data.userId =
            Number(user.id);

          io.emit(
            'online',
            onlineList()
          );

          socket.emit(
            'ranking',
            await ranking()
          );

          const active =
            battleForUser(
              user.id
            );

          if (active) {
            socket.emit(
              'battle:state',
              battleStateFor(
                active,
                user.id
              )
            );
          }
        } catch {
          socket.emit(
            'toast',
            '실시간 연결 인증 실패'
          );
        }
      }
    );

    /* ---------------------------------------------
       BATTLE REQUEST
    --------------------------------------------- */

    socket.on(
      'battle:request',
      ({ to }) => {
        const fromUserId =
          socket.data.userId;

        const me =
          online.get(
            Number(fromUserId)
          );

        const target =
          [...online.entries()]
            .find(
              ([, value]) =>
                value.username === to
            );

        if (!me || !target) {
          return;
        }

        if (
          Number(target[0]) ===
          Number(fromUserId)
        ) {
          return;
        }

        if (
          battleForUser(
            fromUserId
          ) ||
          battleForUser(
            target[0]
          )
        ) {
          socket.emit(
            'toast',
            '이미 배틀 중인 플레이어가 있습니다.'
          );
          return;
        }

        pendingRequests.set(
          Number(target[0]),
          {
            from:
              Number(fromUserId),
            to:
              Number(target[0]),
            fromName:
              me.username,
            createdAt:
              Date.now()
          }
        );

        io.to(
          target[1].socketId
        ).emit(
          'battle:incoming',
          {
            from:
              me.username
          }
        );
      }
    );

    /* ---------------------------------------------
       BATTLE ANSWER
    --------------------------------------------- */

    socket.on(
      'battle:answer',
      ({ to, accepted }) => {
        const target =
          [...online.entries()]
            .find(
              ([, value]) =>
                value.username === to
            );

        if (!target) {
          return;
        }

        const targetId =
          Number(target[0]);

        const meId =
          Number(socket.data.userId);

        const request =
          pendingRequests.get(
            meId
          );

        if (
          !request ||
          request.from !==
            targetId
        ) {
          return;
        }

        pendingRequests.delete(
          meId
        );

        const requester =
          online.get(targetId);

        if (!requester) {
          return;
        }

        if (!accepted) {
          io.to(
            requester.socketId
          ).emit(
            'battle:answer',
            {
              from:
                online.get(meId)
                  ?.username || '',
              accepted: false
            }
          );

          return;
        }

        const opponent =
          online.get(meId);

        const battleId =
          `${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;

             const newBattle = {
          id: battleId,

          p1: {
            id: targetId,
            username: requester.username,
            socketId: requester.socketId,
            selected: null,
            deck: null,
            active: null,
            activeSlot: null
          },

          p2: {
            id: meId,
            username: opponent.username,
            socketId: opponent.socketId,
            selected: null,
            deck: null,
            active: null,
            activeSlot: null
          },

          status: 'selecting',
          turn: null
        };

        battles.set(
          battleId,
          newBattle
        );

        /*
         * 배틀 시작 알림
         * 두 사람 모두 6장 선택 화면으로 이동
         */
        if (requester.socketId) {
          io.to(
            requester.socketId
          ).emit(
            'battle:started',
            {
              battleId,
              opponent: opponent.username
            }
          );
        }

        if (opponent.socketId) {
          io.to(
            opponent.socketId
          ).emit(
            'battle:started',
            {
              battleId,
              opponent: requester.username
            }
          );
        }
   /* ---------------------------------------------
   SELECT SIX
--------------------------------------------- */

socket.on(
  'battle:select6',
  async ({ battleId, ids }) => {
    try {
      const battle =
        battles.get(battleId);

      if (!battle) {
        throw new Error(
          '배틀을 찾을 수 없습니다.'
        );
      }

      const userId =
        Number(socket.data.userId);

      const player =
        playerOf(
          battle,
          userId
        );

      if (!player) {
        throw new Error(
          '배틀 참가자가 아닙니다.'
        );
      }

      if (
        battle.status !==
        'selecting'
      ) {
        throw new Error(
          '지금은 6장 선택 시간이 아닙니다.'
        );
      }

      if (
        !Array.isArray(ids) ||
        ids.length !== 6
      ) {
        throw new Error(
          '포켓몬 카드 6장을 선택하세요.'
        );
      }

      player.selected =
        await loadInventoryCards(
          userId,
          ids
        );

      socket.emit(
        'battle:selected',
        {
          ok: true
        }
      );

      /*
       * 두 플레이어가 모두 6장을
       * 선택했는지 확인
       */
      if (
        battle.p1.selected &&
        battle.p2.selected
      ) {
        battle.status =
          'chooseActive';

        battle.p1.deck =
          shuffle(
            battle.p1.selected
          );

        battle.p2.deck =
          shuffle(
            battle.p2.selected
          );

        /*
         * 신청자
         */
        const s1 =
          userSocket(
            battle.p1.id
          );

        /*
         * 상대방
         */
        const s2 =
          userSocket(
            battle.p2.id
          );

        /*
         * 신청자에게 전송
         */
        if (s1) {
          io.to(s1).emit(
            'battle:decksReady',
            {
              battleId,
              message:
                '6장이 섞였습니다. 오른쪽 카드에서 첫 포켓몬을 선택하세요.'
            }
          );

          io.to(s1).emit(
            'battle:state',
            {
              ...battleStateFor(
                battle,
                battle.p1.id
              )
            }
          );
        }

        /*
         * 상대방에게 전송
         */
        if (s2) {
          io.to(s2).emit(
            'battle:decksReady',
            {
              battleId,
              message:
                '6장이 섞였습니다. 오른쪽 카드에서 첫 포켓몬을 선택하세요.'
            }
          );

          io.to(s2).emit(
            'battle:state',
            {
              ...battleStateFor(
                battle,
                battle.p2.id
              )
            }
          );
        }
      }

    } catch (e) {
      socket.emit(
        'battle:error',
        {
          message:
            e.message ||
            '6장 선택 실패'
        }
      );
    }
  }
);

/* ---------------------------------------------
   DEPLOY ACTIVE
--------------------------------------------- */
    /* ---------------------------------------------
       DEPLOY ACTIVE
    --------------------------------------------- */

    socket.on(
      'battle:deploy',
      ({
        battleId,
        slot
      }) => {
        try {
          const battle =
            battles.get(
              battleId
            );

          if (!battle) {
            throw new Error(
              '배틀 없음'
            );
          }

          const userId =
            Number(
              socket.data.userId
            );

          const player =
            playerOf(
              battle,
              userId
            );

          if (!player) {
            throw new Error(
              '참가자가 아닙니다.'
            );
          }

          if (
            battle.status !==
            'chooseActive'
          ) {
            throw new Error(
              '지금은 포켓몬 선택 시간이 아닙니다.'
            );
          }

          const index =
            Number(slot);

          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= player.deck.length
          ) {
            throw new Error(
              '잘못된 카드입니다.'
            );
          }

          if (player.active) {
            throw new Error(
              '이미 포켓몬을 선택했습니다.'
            );
          }

          const card =
            player.deck[index];

          player.active = {
            ...card,
            currentHp:
              Number(card.hp)
          };

          player.activeSlot =
            index;

          if (
            battle.p1.active &&
            battle.p2.active
          ) {
            battle.status =
              'playing';

            battle.turn =
              Math.random() < 0.5
                ? battle.p1.id
                : battle.p2.id;

            battleBroadcast(
              battle,
              'battle:state',
              {
                ...battleStateFor(
                  battle,
                  battle.p1.id
                )
              }
            );

            const s1 =
              userSocket(
                battle.p1.id
              );

            const s2 =
              userSocket(
                battle.p2.id
              );

            if (s1) {
              io.to(s1).emit(
                'battle:state',
                battleStateFor(
                  battle,
                  battle.p1.id
                )
              );
            }

            if (s2) {
              io.to(s2).emit(
                'battle:state',
                battleStateFor(
                  battle,
                  battle.p2.id
                )
              );
            }

            battleBroadcast(
              battle,
              'battle:turn',
              {
                username:
                  battle.turn ===
                  battle.p1.id
                    ? battle.p1.username
                    : battle.p2.username
              }
            );
          } else {
            battleBroadcast(
              battle,
              'battle:waiting',
              {
                username:
                  player.username
              }
            );
          }
        } catch (e) {
          socket.emit(
            'battle:error',
            {
              message:
                e.message
            }
          );
        }
      }
    );

    /* ---------------------------------------------
       ATTACK
    --------------------------------------------- */

    socket.on(
      'battle:attack',
      ({
        battleId,
        attackIndex
      }) => {
        try {
          const battle =
            battles.get(
              battleId
            );

          if (!battle) {
            throw new Error(
              '배틀 없음'
            );
          }

          if (
            battle.status !==
            'playing'
          ) {
            throw new Error(
              '지금은 공격할 수 없습니다.'
            );
          }

          const attackerId =
            Number(
              socket.data.userId
            );

          if (
            battle.turn !==
            attackerId
          ) {
            throw new Error(
              '상대의 턴입니다.'
            );
          }

          const attacker =
            playerOf(
              battle,
              attackerId
            );

          const defender =
            otherPlayer(
              battle,
              attackerId
            );

          if (
            !attacker.active ||
            !defender.active
          ) {
            throw new Error(
              '전투 포켓몬이 없습니다.'
            );
          }

          const attack =
            attacker.active.attacks[
              Number(attackIndex)
            ];

          if (!attack) {
            throw new Error(
              '기술을 찾을 수 없습니다.'
            );
          }

          const result =
            calculateDamage(
              attacker.active,
              defender.active,
              attack
            );

          defender.active.currentHp =
            Math.max(
              0,
              Number(
                defender.active.currentHp
              ) - result.damage
            );

          battleBroadcast(
            battle,
            'battle:attackResult',
            {
              attacker:
                attacker.username,
              defender:
                defender.username,
              attackName:
                attack.name ||
                '공격',
              damage:
                result.damage,
              base:
                result.base,
              weakness:
                result.weakness,
              resistance:
                result.resistance,
              defenderHp:
                defender.active.currentHp
            }
          );

          if (
            defender.active.currentHp <=
            0
          ) {
            const defeated =
              defender.active;

            battleBroadcast(
              battle,
              'battle:knockout',
              {
                username:
                  defender.username,
                card:
                  cleanBattleCard(
                    defeated
                  )
              }
            );

            defender.deck =
              defender.deck.filter(
                (_, i) =>
                  i !==
                  defender.activeSlot
              );

            defender.active =
              null;

            defender.activeSlot =
              null;

            if (
              defender.deck.length ===
              0
            ) {
              battle.status =
                'finished';

              battleBroadcast(
                battle,
                'battle:finished',
                {
                  winner:
                    attacker.username,
                  loser:
                    defender.username
                }
              );

              battles.delete(
                battle.id
              );

              return;
            }

            battle.status =
              'chooseActive';

            battle.turn =
              attacker.id;

            battleBroadcast(
              battle,
              'battle:replace',
              {
                username:
                  defender.username
              }
            );

            return;
          }

          battle.turn =
            defender.id;

          const s1 =
            userSocket(
              battle.p1.id
            );

          const s2 =
            userSocket(
              battle.p2.id
            );

          if (s1) {
            io.to(s1).emit(
              'battle:state',
              battleStateFor(
                battle,
                battle.p1.id
              )
            );
          }

          if (s2) {
            io.to(s2).emit(
              'battle:state',
              battleStateFor(
                battle,
                battle.p2.id
              )
            );
          }

          battleBroadcast(
            battle,
            'battle:turn',
            {
              username:
                defender.username
            }
          );
        } catch (e) {
          socket.emit(
            'battle:error',
            {
              message:
                e.message
            }
          );
        }
      }
    );

    /* ---------------------------------------------
       REPLACE ACTIVE AFTER KO
    --------------------------------------------- */

    socket.on(
      'battle:replace',
      ({
        battleId,
        slot
      }) => {
        try {
          const battle =
            battles.get(
              battleId
            );

          if (!battle) {
            throw new Error(
              '배틀 없음'
            );
          }

          const userId =
            Number(
              socket.data.userId
            );

          const player =
            playerOf(
              battle,
              userId
            );

          if (!player) {
            throw new Error(
              '참가자가 아닙니다.'
            );
          }

          if (
            battle.status !==
            'chooseActive'
          ) {
            throw new Error(
              '교체할 수 없습니다.'
            );
          }

          if (player.active) {
            throw new Error(
              '이미 전투 포켓몬이 있습니다.'
            );
          }

          const index =
            Number(slot);

          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= player.deck.length
          ) {
            throw new Error(
              '잘못된 카드입니다.'
            );
          }

          const card =
            player.deck[index];

          player.active = {
            ...card,
            currentHp:
              Number(card.hp)
          };

          player.activeSlot =
            index;

          battle.status =
            'playing';

          battle.turn =
            player.id;

          const s1 =
            userSocket(
              battle.p1.id
            );

          const s2 =
            userSocket(
              battle.p2.id
            );

          if (s1) {
            io.to(s1).emit(
              'battle:state',
              battleStateFor(
                battle,
                battle.p1.id
              )
            );
          }

          if (s2) {
            io.to(s2).emit(
              'battle:state',
              battleStateFor(
                battle,
                battle.p2.id
              )
            );
          }

          battleBroadcast(
            battle,
            'battle:turn',
            {
              username:
                player.username
            }
          );
        } catch (e) {
          socket.emit(
            'battle:error',
            {
              message:
                e.message
            }
          );
        }
      }
    );

    /* ---------------------------------------------
       DISCONNECT
    --------------------------------------------- */

    socket.on(
      'disconnect',
      () => {
        const userId =
          Number(
            socket.data.userId
          );

        if (!userId) {
          return;
        }

        const current =
          online.get(userId);

        if (
          current &&
          current.socketId ===
            socket.id
        ) {
          online.delete(userId);

          const battle =
            battleForUser(
              userId
            );

          if (battle) {
            const opponent =
              otherPlayer(
                battle,
                userId
              );

            const winner =
              online.get(
                opponent.id
              );

            if (winner) {
              io.to(
                winner.socketId
              ).emit(
                'battle:finished',
                {
                  winner:
                    opponent.username,
                  loser:
                    current.username,
                  reason:
                    '상대방 연결 종료'
                }
              );
            }

            battles.delete(
              battle.id
            );
          }

          io.emit(
            'online',
            onlineList()
          );
        }
      }
    );
  }
);

/* =========================================================
   ROOT
========================================================= */

app.get('/', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'index.html'
    )
  );
});

/* =========================================================
   START
========================================================= */

async function boot() {
  await setupDatabase();

  server.listen(
    PORT,
    () => {
      console.log(
        `PokéPack Vault online on ${PORT}`
      );
    }
  );
}

boot().catch(e => {
  console.error(e);
  process.exit(1);
});
