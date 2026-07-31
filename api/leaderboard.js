const LEADERBOARD_KEY = 'neural-net-containment:hard-mode:leaderboard';

function getRedisConfig() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  };
}

function parseEntries(result) {
  const values = Array.isArray(result) ? result : [];
  const entries = [];
  for (let index = 0; index < values.length; index += 2) {
    entries.push({
      nickname: String(values[index] || 'ANON'),
      levels: Math.max(0, Number(values[index + 1]) || 0)
    });
  }
  return entries;
}

async function redisPipeline(commands) {
  const { url, token } = getRedisConfig();
  if (!url || !token) {
    const error = new Error('Leaderboard storage is not configured.');
    error.statusCode = 503;
    throw error;
  }
  const response = await fetch(`${url.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });
  if (!response.ok) {
    const error = new Error('Leaderboard storage request failed.');
    error.statusCode = 502;
    throw error;
  }
  return response.json();
}

module.exports = async function leaderboardHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    if (req.method === 'GET') {
      const results = await redisPipeline([
        ['ZRANGE', LEADERBOARD_KEY, '0', '9', 'REV', 'WITHSCORES']
      ]);
      return res.status(200).json({
        storage: 'shared',
        provider: 'upstash',
        entries: parseEntries(results[0] && results[0].result)
      });
    }

    if (req.method === 'POST') {
      const nickname = String((req.body && req.body.nickname) || '')
        .trim()
        .replace(/[^a-zA-Z0-9 _-]/g, '')
        .slice(0, 16)
        .toUpperCase();
      const levels = Math.floor(Number(req.body && req.body.levels));
      if (!nickname || !Number.isFinite(levels) || levels < 1 || levels > 100000) {
        return res.status(400).json({ error: 'A nickname and valid completed-level count are required.' });
      }

      const results = await redisPipeline([
        ['ZADD', LEADERBOARD_KEY, 'GT', String(levels), nickname],
        ['ZRANGE', LEADERBOARD_KEY, '0', '9', 'REV', 'WITHSCORES']
      ]);
      const entries = parseEntries(results[1] && results[1].result);
      const rankIndex = entries.findIndex(entry => entry.nickname === nickname);
      return res.status(200).json({
        entries,
        ranked: rankIndex >= 0,
        rank: rankIndex >= 0 ? rankIndex + 1 : null
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (error) {
    const status = error && error.statusCode ? error.statusCode : 500;
    return res.status(status).json({ error: error.message || 'Leaderboard unavailable.' });
  }
};
