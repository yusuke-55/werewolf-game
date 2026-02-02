/*
  Headless autoplay client for werewolf-AI-prototype.

  Usage:
    node tools/autoplay.js --url http://localhost:3002 --reset --start

  Notes:
  - Connects to SSE /events and reacts to:
      - player_operation_phase: issues random mayor operations, then proceeds to voting
      - night_action_request: submits a random user night action (playerId=0)
      - game_end/show_play_again: exits
*/

const http = require('http');
const https = require('https');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const out = {
    url: process.env.BASE_URL || 'http://localhost:3002',
    reset: false,
    start: false,
    userName: process.env.USER_NAME || 'オートプレイヤー',
    userIcon: process.env.USER_ICON || null,
    quiet: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && argv[i + 1]) {
      out.url = argv[++i];
    } else if (a === '--reset') {
      out.reset = true;
    } else if (a === '--start') {
      out.start = true;
    } else if (a === '--name' && argv[i + 1]) {
      out.userName = argv[++i];
    } else if (a === '--icon' && argv[i + 1]) {
      out.userIcon = argv[++i];
    } else if (a === '--quiet') {
      out.quiet = true;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }

  return out;
}

function normalizeBaseUrl(base) {
  try {
    const u = new URL(base);
    // remove trailing slash
    u.pathname = u.pathname.replace(/\/+$/, '');
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return base.replace(/\/+$/, '');
  }
}

async function httpJson(method, url, body) {
  const init = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    err.status = res.status;
    err.payload = parsed;
    throw err;
  }
  return parsed;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function connectSSE(eventsUrl, onEvent) {
  const u = new URL(eventsUrl);
  const mod = u.protocol === 'https:' ? https : http;

  const req = mod.request(
    {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    },
    (res) => {
      res.setEncoding('utf8');
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk;
        buffer = buffer.replace(/\r\n/g, '\n');

        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!raw.trim()) continue;

          let eventName = 'message';
          const dataLines = [];

          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) {
              eventName = line.slice('event:'.length).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice('data:'.length).trim());
            }
          }

          const dataStr = dataLines.join('\n');
          let data = dataStr;
          try {
            data = dataStr ? JSON.parse(dataStr) : null;
          } catch {
            // keep as string
          }

          try {
            onEvent(eventName, data);
          } catch (e) {
            // swallow handler errors to keep stream alive
          }
        }
      });

      res.on('end', () => {
        onEvent('__end__', null);
      });
    },
  );

  req.on('error', (err) => {
    onEvent('__error__', err);
  });

  req.end();
  return req;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node tools/autoplay.js [--url http://localhost:3002] [--reset] [--start] [--name NAME] [--icon URL]');
    process.exit(0);
  }

  const baseUrl = normalizeBaseUrl(args.url);
  const statusUrl = `${baseUrl}/api/status`;

  const log = (...xs) => {
    if (!args.quiet) console.log(...xs);
  };

  log(`[autoplay] baseUrl=${baseUrl}`);

  if (args.reset) {
    try {
      await httpJson('POST', `${baseUrl}/api/reset`, {});
      log('[autoplay] reset ok');
    } catch (e) {
      log('[autoplay] reset failed (ignored):', e.message || e);
    }
  }

  if (args.start) {
    await httpJson('POST', `${baseUrl}/api/start`, {
      userName: args.userName,
      userIcon: args.userIcon,
    });
    log('[autoplay] start ok');
  } else {
    // If not starting, still show whether a game is running.
    try {
      const st = await httpJson('GET', statusUrl);
      log(`[autoplay] running=${!!st.running}`);
    } catch (e) {
      log('[autoplay] status check failed:', e.message || e);
    }
  }

  let lastOperationDay = -1;
  let handlingOperation = false;

  const sseReq = connectSSE(`${baseUrl}/events`, async (event, data) => {
    if (event === 'connected') {
      log('[SSE] connected');
      return;
    }

    if (event === '__error__') {
      console.error('[SSE] error:', data);
      process.exit(1);
      return;
    }

    if (event === '__end__') {
      console.error('[SSE] connection closed');
      process.exit(1);
      return;
    }

    if (event === 'game_end' || event === 'show_play_again') {
      log(`[SSE] ${event} -> exit`);
      try {
        sseReq.destroy();
      } catch {}
      process.exit(0);
      return;
    }

    if (event === 'night_action_request') {
      try {
        const alive = Array.isArray(data?.alivePlayers) ? data.alivePlayers : [];
        if (alive.length === 0) return;
        // quick action to avoid 30s timeout
        await sleep(200);
        const target = pickRandom(alive);
        await httpJson('POST', `${baseUrl}/api/night-action`, { playerId: 0, targetId: target.id });
        log(`[autoplay] night-action -> targetId=${target.id}`);
      } catch (e) {
        log('[autoplay] night-action failed:', e.message || e);
      }
      return;
    }

    if (event === 'player_operation_phase') {
      const day = Number(data?.day);
      if (!Number.isFinite(day)) return;
      if (day <= lastOperationDay) return;
      if (handlingOperation) return;
      handlingOperation = true;
      lastOperationDay = day;

      try {
        const alive = Array.isArray(data?.alivePlayers) ? data.alivePlayers : [];
        const targets = alive.filter((p) => p && typeof p.id === 'number' && p.id !== 0);

        log(`[autoplay] player_operation_phase day=${day} (alive=${alive.length})`);

        // 1) maybe ask suspicious (1/day limit)
        if (Math.random() < 0.6) {
          try {
            await httpJson('POST', `${baseUrl}/api/operation/ask_suspicious`, {});
            log('[autoplay] ask_suspicious');
            await sleep(400);
          } catch (e) {
            // ignore limit/phase errors
          }
        }

        // 2) maybe ask 1-2 individual questions (up to 3/day server-side)
        const qKeys = [
          'ask_if_ok_to_be_divined',
          'ask_if_ok_to_be_sacrificed',
          'ask_if_have_role',
          'ask_who_will_be_attacked',
          'ask_why_suspicious',
        ];
        const qCount = targets.length > 0 ? (Math.random() < 0.5 ? 1 : Math.random() < 0.3 ? 2 : 0) : 0;
        for (let i = 0; i < qCount; i++) {
          try {
            const t = pickRandom(targets);
            const k = pickRandom(qKeys);
            await httpJson('POST', `${baseUrl}/api/operation/question`, { targetId: t.id, questionKey: k });
            log(`[autoplay] question -> ${k} targetId=${t.id}`);
            await sleep(350);
          } catch (e) {
            // ignore
          }
        }

        // 3) maybe designate random vote target (makes voting converge quickly)
        if (Math.random() < 0.7) {
          try {
            await httpJson('POST', `${baseUrl}/api/operation/designate_random`, { type: 'vote' });
            log('[autoplay] designate_random vote');
            await sleep(250);
          } catch (e) {
            // ignore
          }
        }

        // 4) maybe force a CO
        if (Math.random() < 0.35) {
          try {
            const roles = ['SEER', 'MEDIUM', 'KNIGHT'];
            await httpJson('POST', `${baseUrl}/api/operation/co`, { role: pickRandom(roles) });
            log('[autoplay] co');
            await sleep(250);
          } catch (e) {
            // ignore
          }
        }

        // 5) optionally cast a user vote to avoid -1
        if (targets.length > 0 && Math.random() < 0.6) {
          try {
            const t = pickRandom(targets);
            await httpJson('POST', `${baseUrl}/api/vote`, { playerId: 0, targetId: t.id });
            log(`[autoplay] user vote -> targetId=${t.id}`);
          } catch (e) {
            // ignore
          }
        }

        // Finally proceed to voting (this unblocks the game loop)
        await sleep(500);
        await httpJson('POST', `${baseUrl}/api/proceed_to_voting`, {});
        log('[autoplay] proceed_to_voting');
      } catch (e) {
        log('[autoplay] operation handler error:', e.message || e);
      } finally {
        handlingOperation = false;
      }

      return;
    }

    // Other events are ignored.
  });

  // keep process alive
  process.on('SIGINT', () => {
    console.log('\n[autoplay] interrupted');
    try {
      sseReq.destroy();
    } catch {}
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('[autoplay] fatal:', e);
  process.exit(1);
});
