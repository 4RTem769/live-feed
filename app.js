(() => {
  'use strict';

  window.LIVE_FEED_VERSION = '1.8.2';

  const $ = (id) => document.getElementById(id);

  /* ---------- Конфигурация ---------- */

  const BROKER = 'wss://test.mosquitto.org:8081/mqtt';
  const ROOM = (() => {
    const raw = new URLSearchParams(location.search).get('room') || 'main';
    return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'main';
  })();
  const BASE = 'livefeed/v1/4rtem769/' + ROOM;
  const MAX_MESSAGES = 400;
  const HISTORY_TTL = 3 * 24 * 60 * 60 * 1000;
  const PRESENCE_TTL = 90 * 1000;

  /* ---------- Хранилище ---------- */

  const store = {
    get(key, fallback) {
      try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch {}
    },
  };

  const rand = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

  let clientId = store.get('livefeed.clientId', '');
  if (!clientId) {
    clientId = rand();
    store.set('livefeed.clientId', clientId);
  }

  let myName = store.get('livefeed.name', '');
  const myColor = colorFromId(clientId);
  const tabId = rand().slice(0, 18);

  /* ---------- Элементы ---------- */

  const feed = $('feed');
  const input = $('input');
  const sendBtn = $('sendBtn');
  const jumpBtn = $('jumpBtn');
  const typingEl = $('typing');
  const peopleEl = $('people');
  const ghostLayer = $('ghosts');
  const ghostToggle = $('ghostToggle');
  const screamerEl = $('screamer');
  const duelEl = $('duel');
  const scoresEl = $('scores');
  const nameModal = $('nameModal');
  const nameInput = $('nameInput');
  const nameGo = $('nameGo');

  /* ---------- Состояние ---------- */

  let messages = [];
  const online = new Map();
  const typingUsers = new Map();
  let mqtt = null;
  let connected = false;
  let stickToBottom = true;
  let unread = 0;
  let renderTimer = null;
  let typingTimer = null;
  let typingActive = false;
  let lastTypingSent = 0;
  let lastScreamerAt = 0;
  let screaming = false;
  let screamCtx = null;
  const processedEvents = new Set();
  let lastEchoAt = 0;

  const scores = new Map();
  let duel = null;
  let duelCooldownAt = 0;
  let duelTimers = [];
  let duelTick = null;
  let duelResend = null;
  let duelKeyHandler = null;

  /* ---------- Утилиты ---------- */

  function colorFromId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
    return `hsl(${h} 78% 66%)`;
  }

  function initials(name) {
    return (name || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  }

  function timeOf(ts) {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  function dayOf(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date();
    yest.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Сегодня';
    if (d.toDateString() === yest.toDateString()) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  /* ---------- Рендер ---------- */

  function buildMessage(msg, prev) {
    if (msg.kind === 'system') {
      const note = document.createElement('div');
      note.className = 'sys';
      note.textContent = msg.text;
      return note;
    }

    const wrap = document.createElement('div');
    const mine = msg.clientId === clientId;
    wrap.className = 'msg anim' + (mine ? ' is-mine' : '');
    wrap.dataset.id = msg.id;

    const sameAuthor = prev && prev.clientId === msg.clientId && (msg.ts - prev.ts) < 5 * 60 * 1000;
    if (sameAuthor) wrap.classList.add('grouped');

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = msg.color || colorFromId(msg.clientId || msg.name || '');
    avatar.textContent = initials(msg.name);
    avatar.title = msg.name;

    const body = document.createElement('div');
    body.className = 'msg-body';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const nm = document.createElement('span');
    nm.className = 'msg-name';
    nm.textContent = msg.name;
    const tm = document.createElement('span');
    tm.className = 'msg-time';
    tm.textContent = timeOf(msg.ts);
    tm.title = new Date(msg.ts).toLocaleString('ru-RU');
    meta.append(nm, tm);

    const text = document.createElement('div');
    text.className = 'msg-text';
    text.textContent = msg.text;

    body.append(meta, text);
    wrap.append(avatar, body);
    return wrap;
  }

  function renderFeed() {
    feed.innerHTML = '';
    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      const emoji = document.createElement('span');
      emoji.className = 'emoji';
      emoji.textContent = '👀';
      const b = document.createElement('b');
      b.textContent = 'Пока тихо';
      empty.append(emoji, b, document.createTextNode('Напишите первое сообщение — и его увидят все, кто сейчас на сайте.'));
      feed.append(empty);
    } else {
      let prev = null;
      let lastDay = '';
      for (const msg of messages) {
        const day = dayOf(msg.ts);
        if (day !== lastDay) {
          const div = document.createElement('div');
          div.className = 'daydiv';
          div.textContent = day;
          feed.append(div);
          lastDay = day;
          prev = null;
        }
        feed.append(buildMessage(msg, prev));
        prev = msg;
      }
    }
    updateCount();
    if (stickToBottom) scrollToBottom(true);
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderFeed, 120);
  }

  function updateCount() {
    const n = messages.length;
    $('msgCount').textContent = n === 0 ? 'пока пусто' : `${n} ${plural(n, 'сообщение', 'сообщения', 'сообщений')}`;
  }

  function scrollToBottom(instant) {
    requestAnimationFrame(() => {
      feed.scrollTo({ top: feed.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
    });
  }

  function renderOnline() {
    const people = [...online.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    $('onlineCount').textContent = people.length;
    $('sideCount').textContent = people.length;
    peopleEl.innerHTML = '';
    for (const person of people) {
      const li = document.createElement('li');
      const av = document.createElement('div');
      av.className = 'avatar';
      av.style.background = person.color || colorFromId(person.clientId);
      av.textContent = initials(person.name);

      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = person.name;

      li.append(av, nm);
      if (person.clientId === clientId) {
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = 'вы';
        li.append(you);
      }
      peopleEl.append(li);
    }
    if (!people.length) {
      const li = document.createElement('li');
      li.style.color = 'var(--muted)';
      li.style.fontSize = '13px';
      li.textContent = 'Никого нет…';
      peopleEl.append(li);
    }
    syncGhosts(people);
  }

  /* ---------- Призраки ---------- */

  const GHOST_PATH = 'M32 5C17.6 5 6 16.6 6 31v39.5c0 3.2 3.7 4.8 6 2.6l6.4-6.3c1.4-1.4 3.7-1.4 5.1 0l5.8 5.8c1.4 1.4 3.7 1.4 5.1 0l5.8-5.8c1.4-1.4 3.7-1.4 5.1 0l6.4 6.3c2.3 2.2 6 .6 6-2.6V31C58 16.6 46.4 5 32 5z';
  const ghostEls = new Map();
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function hashOf(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  function makeGhost(person) {
    const h = hashOf(person.clientId || person.name || '');
    const el = document.createElement('div');
    el.className = 'ghost' + (person.clientId === clientId ? ' mine' : '');
    el.style.left = (6 + ((h >>> 6) % 78)) + '%';
    el.style.top = (6 + ((h >>> 7) % 64)) + '%';

    const dur = 9 + (h % 9);
    el.style.setProperty('--dur', dur + 's');
    el.style.setProperty('--delay', '-' + (h % (dur * 1000)) / 1000 + 's');
    el.style.setProperty('--bob', (3 + ((h >>> 3) % 4)) + 's');
    el.style.setProperty('--size', (46 + ((h >>> 11) % 26)) + 'px');
    el.style.setProperty('--dx', (30 + ((h >>> 13) % 50)) + 'px');
    el.style.setProperty('--dy', (-30 + ((h >>> 17) % 45)) + 'px');

    const inner = document.createElement('div');
    inner.className = 'ghost-inner';

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 64 84');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', GHOST_PATH);
    path.setAttribute('fill', person.color || colorFromId(person.clientId || ''));
    svg.append(path);
    for (const cx of [23, 41]) {
      const eye = document.createElementNS(SVG_NS, 'circle');
      eye.setAttribute('cx', String(cx));
      eye.setAttribute('cy', '33');
      eye.setAttribute('r', '4.2');
      eye.setAttribute('fill', '#0b0c10');
      svg.append(eye);
    }

    const name = document.createElement('span');
    name.className = 'ghost-name';
    name.textContent = person.name;

    inner.append(svg, name);
    el.append(inner);
    ghostLayer.append(el);

    return { el, name, color: person.color };
  }

  function syncGhosts(people) {
    const MAX_GHOSTS = 12;
    people = people.slice(0, MAX_GHOSTS);
    const ids = new Set(people.map((p) => p.clientId));

    for (const [id, ghost] of ghostEls) {
      if (ids.has(id)) continue;
      ghostEls.delete(id);
      ghost.el.classList.add('leaving');
      setTimeout(() => ghost.el.remove(), 550);
    }

    for (const person of people) {
      const ghost = ghostEls.get(person.clientId);
      if (!ghost) {
        ghostEls.set(person.clientId, makeGhost(person));
        continue;
      }
      if (ghost.name.textContent !== person.name) ghost.name.textContent = person.name;
      if (ghost.color !== person.color) {
        ghost.color = person.color;
        const path = ghost.el.querySelector('path');
        if (path) path.setAttribute('fill', person.color || colorFromId(person.clientId));
      }
      ghost.el.classList.toggle('mine', person.clientId === clientId);
    }
  }

  /* ---------- Скример ---------- */

  function pushSystem(text) {
    messages.push({ id: rand(), kind: 'system', text, ts: Date.now() });
    messages.sort((a, b) => a.ts - b.ts);
    scheduleRender();
  }

  function playScreamer() {
    if (screaming) return;
    screaming = true;

    try { navigator.vibrate && navigator.vibrate([180, 60, 220, 60, 300]); } catch {}

    screamerEl.classList.add('on');
    screamerEl.setAttribute('aria-hidden', 'false');
    void screamerEl.offsetWidth;

    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        screamCtx = screamCtx || new AC();
        const ctx = screamCtx;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const now = ctx.currentTime;

        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(190, now);
        osc.frequency.exponentialRampToValueAtTime(1300, now + 0.12);
        osc.frequency.exponentialRampToValueAtTime(240, now + 1.15);

        const lfo = ctx.createOscillator();
        lfo.frequency.value = 23;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 70;
        lfo.connect(lfoGain).connect(osc.frequency);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.22, now + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
        osc.connect(gain).connect(ctx.destination);

        const len = Math.floor(ctx.sampleRate * 1.3);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.6);
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buf;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 1100;
        const ng = ctx.createGain();
        ng.gain.value = 0.16;
        noise.connect(hp).connect(ng).connect(ctx.destination);

        osc.start(now);
        lfo.start(now);
        noise.start(now);
        osc.stop(now + 1.5);
        lfo.stop(now + 1.5);
      }
    } catch {}

    setTimeout(() => {
      screamerEl.classList.remove('on');
      screamerEl.setAttribute('aria-hidden', 'true');
      screaming = false;
    }, 2500);
  }

  function runScreamerCommand() {
    const now = Date.now();
    if (now - lastScreamerAt < 10000) {
      pushSystem('⏳ Скример перезаряжается — подождите несколько секунд');
      return;
    }
    if (!mqtt || !connected) {
      pushSystem('⚠️ Нет связи — скример не отправлен');
      return;
    }

    const people = [...online.values()].filter((p) => Date.now() - (p.lastSeen || 0) < 60000);
    if (!people.length) {
      pushSystem('😶 На сайте никого нет — некого пугать');
      return;
    }

    lastScreamerAt = now;
    const others = people.filter((p) => p.clientId !== clientId);
    const pool = others.length ? others : people;
    const target = pool[Math.floor(Math.random() * pool.length)];
    const eventId = rand();

    processedEvents.add(eventId);
    mqtt.publish(`${BASE}/x`, JSON.stringify({
      id: eventId,
      type: 'screamer',
      target: target.clientId,
      targetTab: target.tabId,
      targetName: target.name,
      from: myName,
      ts: now,
    }), { qos: 1 });

    pushSystem(`😱 ${myName} наслал скримера на ${target.name}`);
    if (target.clientId === clientId) playScreamer();
  }

  /* ---------- Дуэль кликов ---------- */

  function makeNode(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function publishX(payload) {
    if (!mqtt) return;
    mqtt.publish(`${BASE}/x`, JSON.stringify(payload), { qos: 1 });
  }

  function publishXRepeat(payload) {
    publishX(payload);
    publishX(payload);
    publishX(payload);
  }

  function clearDuelTimers() {
    for (const id of duelTimers) clearTimeout(id);
    duelTimers = [];
    if (duelResend) {
      clearInterval(duelResend);
      duelResend = null;
    }
    if (duelTick) {
      clearInterval(duelTick);
      duelTick = null;
    }
    if (duelKeyHandler) {
      window.removeEventListener('keydown', duelKeyHandler);
      duelKeyHandler = null;
    }
  }

  function startDuelResend(makePayload, times, delay) {
    if (duelResend) clearInterval(duelResend);
    let sent = 0;
    duelResend = setInterval(() => {
      sent++;
      if (sent >= times) {
        clearInterval(duelResend);
        duelResend = null;
        return;
      }
      publishX(makePayload());
    }, delay);
    publishX(makePayload());
  }

  function setDuelTimer(fn, ms) {
    const id = setTimeout(fn, ms);
    duelTimers.push(id);
    return id;
  }

  function closeDuel() {
    clearDuelTimers();
    duelEl.classList.remove('on');
    duelEl.innerHTML = '';
    duel = null;
  }

  function renderScores() {
    const list = [...scores.values()]
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    $('scoreCount').textContent = list.length;
    scoresEl.innerHTML = '';

    if (!list.length) {
      scoresEl.append(makeNode('li', 'empty-scores', 'Очков пока нет — выиграйте дуэль'));
      return;
    }

    list.slice(0, 10).forEach((s, i) => {
      const li = document.createElement('li');
      li.append(
        makeNode('span', 'rank', String(i + 1)),
        makeNode('span', 'snm', s.name + (s.clientId === clientId ? ' (вы)' : '')),
        makeNode('span', 'sp', String(s.score))
      );
      scoresEl.append(li);
    });
  }

  function awardDuelPoint(duelId) {
    const key = 'livefeed.scored.' + duelId;
    if (store.get(key) === '1') return;
    store.set(key, '1');

    const next = (scores.get(clientId)?.score || 0) + 1;
    scores.set(clientId, { clientId, name: myName, color: myColor, score: next });
    renderScores();

    if (mqtt && connected) {
      mqtt.publish(`${BASE}/s/${clientId}`, JSON.stringify({
        clientId,
        name: myName,
        color: myColor,
        score: next,
        ts: Date.now(),
      }), { qos: 1, retain: true });
    }
  }

  function runDuelCommand(arg) {
    const now = Date.now();
    if (duel) {
      pushSystem('⚔️ Дуэль уже идёт — сначала закончите текущую');
      return;
    }
    if (now - duelCooldownAt < 10000) {
      pushSystem('⏳ Подождите пару секунд перед новым вызовом');
      return;
    }
    if (!mqtt || !connected) {
      pushSystem('⚠️ Нет связи — вызов не отправлен');
      return;
    }

    const people = [...online.values()].filter(
      (p) => p.clientId !== clientId && Date.now() - (p.lastSeen || 0) < 60000
    );
    if (!people.length) {
      pushSystem('😶 Некого вызвать — на сайте больше никого нет');
      return;
    }

    const wanted = (arg || '').trim().toLowerCase();
    let target = null;
    if (wanted) {
      target = people.find((p) => p.name.toLowerCase().includes(wanted)) || null;
      if (!target) {
        pushSystem(`🤷 Не нашёл гостя «${arg.trim()}»`);
        return;
      }
    } else {
      target = people[Math.floor(Math.random() * people.length)];
    }

    duelCooldownAt = now;
    const duelId = rand();
    const duration = 10000;

    duel = {
      id: duelId,
      role: 'challenger',
      state: 'waiting',
      opponentName: target.name,
      opponentId: target.clientId,
      opponentTab: target.tabId,
      duration,
      clicks: 0,
      results: new Map(),
      endsAt: 0,
    };

    const invitePayload = () => ({
      type: 'duel-invite',
      duelId,
      from: myName,
      fromId: clientId,
      fromTab: tabId,
      targetId: target.clientId,
      targetTab: target.tabId,
      targetName: target.name,
      duration,
      ts: Date.now(),
    });
    startDuelResend(invitePayload, 9, 1500);

    pushSystem(`⚔️ ${myName} вызывает ${target.name} на дуэль кликов`);
    showDuelWaiting();
  }

  function showDuelWaiting() {
    const myDuel = duel;
    duelEl.classList.add('on');
    duelEl.innerHTML = '';

    const card = makeNode('div', 'duel-card');
    card.append(
      makeNode('div', 'duel-badge', '⚔️'),
      makeNode('h2', 'duel-title', 'Вызов отправлен'),
      makeNode('p', 'duel-sub', `Ждём ответа: ${myDuel.opponentName}`)
    );

    const actions = makeNode('div', 'duel-actions');
    const cancel = makeNode('button', 'duel-btn', 'Отменить вызов');
    cancel.addEventListener('click', () => {
      if (duel !== myDuel) return;
      publishX({ type: 'duel-decline', duelId: myDuel.id, fromId: clientId, reason: 'cancel', ts: Date.now() });
      const name = myDuel.opponentName;
      closeDuel();
      pushSystem(`⚔️ Вызов для ${name} отменён`);
    });
    actions.append(cancel);
    card.append(actions);
    duelEl.append(card);

    setDuelTimer(() => {
      if (duel === myDuel && duel.state === 'waiting') {
        const name = myDuel.opponentName;
        closeDuel();
        pushSystem(`⚔️ ${name} не ответил на вызов`);
      }
    }, 15000);
  }

  function renderDuelInvite(data) {
    duelEl.classList.add('on');
    duelEl.innerHTML = '';

    const card = makeNode('div', 'duel-card');
    card.append(
      makeNode('div', 'duel-badge', '⚔️'),
      makeNode('h2', 'duel-title', `${data.from} вызывает вас`),
      makeNode('p', 'duel-sub', 'Кто больше кликнет за 10 секунд — победителю +1 очко.')
    );

    const actions = makeNode('div', 'duel-actions');
    const accept = makeNode('button', 'duel-btn primary', 'Принять');
    const decline = makeNode('button', 'duel-btn', 'Отклонить');

    accept.addEventListener('click', () => {
      if (!duel || duel.state !== 'invite') return;
      if (!connected) {
        const warn = card.querySelector('.duel-timertext');
        if (warn) warn.textContent = 'Нет связи с лентой — проверьте интернет и попробуйте ещё раз';
        return;
      }
      clearDuelTimers();
      const payload = () => ({
        type: 'duel-accept',
        duelId: duel.id,
        fromId: clientId,
        name: myName,
        ts: Date.now(),
      });
      openDuelArena();
      startDuelResend(payload, 10, 1200);
    });

    decline.addEventListener('click', () => {
      if (!duel) return;
      publishX({ type: 'duel-decline', duelId: duel.id, fromId: clientId, name: myName, ts: Date.now() });
      closeDuel();
    });

    actions.append(accept, decline);
    card.append(actions, makeNode('div', 'duel-timertext', 'Автопропуск через 12 с'));
    duelEl.append(card);

    setDuelTimer(() => {
      if (duel && duel.state === 'invite') {
        publishX({ type: 'duel-decline', duelId: duel.id, fromId: clientId, name: myName, ts: Date.now() });
        closeDuel();
      }
    }, 12000);
  }

  function registerDuelClick(counter) {
    if (!duel || duel.state !== 'arena') return;
    duel.clicks++;
    counter.textContent = String(duel.clicks);
    try { navigator.vibrate && navigator.vibrate(8); } catch {}
  }

  function openDuelArena() {
    clearDuelTimers();
    if (!duel) return;

    duel.state = 'arena';
    duel.clicks = 0;
    duel.endsAt = Date.now() + duel.duration;
    duelEl.classList.add('on');
    duelEl.innerHTML = '';

    const card = makeNode('div', 'duel-card duel-arena');

    const line = makeNode('div', 'duel-scoreline');
    const me = makeNode('span');
    me.append(makeNode('b', null, 'вы'));
    const opp = makeNode('span');
    opp.append(makeNode('b', null, duel.opponentName));
    line.append(me, makeNode('span', null, ' против '), opp);

    const counter = makeNode('div', 'duel-counter', '0');
    const barWrap = makeNode('div', 'duel-bar');
    const bar = makeNode('i');
    barWrap.append(bar);

    const pad = makeNode('button', 'duel-pad', 'ЖМИ!');
    pad.type = 'button';
    pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      registerDuelClick(counter);
    });

    const timerText = makeNode('div', 'duel-timertext', 'осталось 10.0 с');

    card.append(
      makeNode('h2', 'duel-title', '⚔️ Дуэль!'),
      line,
      counter,
      barWrap,
      pad,
      timerText
    );
    duelEl.append(card);

    duelKeyHandler = (e) => {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        registerDuelClick(counter);
      }
    };
    window.addEventListener('keydown', duelKeyHandler);

    duelTick = setInterval(() => {
      if (!duel || duel.state !== 'arena') return;
      const left = Math.max(0, duel.endsAt - Date.now());
      bar.style.width = (left / duel.duration) * 100 + '%';
      timerText.textContent = 'осталось ' + (left / 1000).toFixed(1) + ' с';
      if (left <= 0) endDuel();
    }, 100);
  }

  function showWaitingResult(myDuel) {
    duelEl.innerHTML = '';
    const card = makeNode('div', 'duel-card');
    card.append(
      makeNode('div', 'duel-badge', '⏳'),
      makeNode('h2', 'duel-title', 'Время вышло'),
      makeNode('p', 'duel-sub', `Ваши клики: ${myDuel.clicks}. Ждём итог соперника…`)
    );
    duelEl.append(card);
  }

  function renderDuelCard(opts) {
    duelEl.classList.add('on');
    duelEl.innerHTML = '';

    const card = makeNode('div', 'duel-card');
    card.append(makeNode('div', 'duel-badge', opts.noResult ? '❔' : opts.won ? '🏆' : opts.draw ? '🤝' : '😞'));
    card.append(makeNode('h2', 'duel-title', opts.noResult
      ? 'Итог не получен'
      : opts.won ? 'Победа!' : opts.draw ? 'Ничья' : 'Поражение'));

    const scoreLine = makeNode('div', 'duel-result-score');
    scoreLine.append(
      makeNode('span', opts.won ? 'win' : '', String(opts.myClicks)),
      makeNode('span', '', opts.noResult ? ' : ?' : ' : '),
      makeNode('span', opts.draw ? '' : 'lose', opts.noResult ? '' : String(opts.oppClicks))
    );
    card.append(scoreLine);
    card.append(makeNode('p', 'duel-sub', opts.noResult
      ? 'Соперник не прислал результат — очко не начислено'
      : opts.awarded
        ? 'Вы получаете +1 очко'
        : opts.draw
          ? 'Очков никто не получает'
          : opts.won
            ? 'Итог не подтверждён — очко не начислено'
            : `${opts.opponent} получает +1 очко`));

    const actions = makeNode('div', 'duel-actions');
    const done = makeNode('button', 'duel-btn primary', 'Продолжить');
    done.addEventListener('click', () => closeDuel());
    actions.append(done);
    card.append(actions);
    duelEl.append(card);
  }

  function endDuel() {
    if (!duel || duel.state !== 'arena') return;
    clearDuelTimers();

    const myDuel = duel;
    duel.state = 'result-wait';
    duel.results.set(clientId, myDuel.clicks);

    const payload = () => ({
      type: 'duel-result',
      duelId: myDuel.id,
      clientId,
      name: myName,
      clicks: myDuel.clicks,
      ts: Date.now(),
    });

    if (myDuel.role === 'challenger') {
      publishX(payload());
      setDuelTimer(() => publishX(payload()), 500);
    } else {
      startDuelResend(payload, 12, 1200);
    }

    showWaitingResult(myDuel);

    if (myDuel.role === 'challenger') {
      setDuelTimer(() => {
        if (duel !== myDuel || duel.state !== 'result-wait') return;
        if (myDuel.results.size >= 2) {
          publishDuelEnd(myDuel);
        } else {
          myDuel.state = 'done';
          renderDuelCard({
            myClicks: myDuel.clicks,
            oppClicks: 0,
            won: false,
            draw: false,
            awarded: false,
            opponent: myDuel.opponentName,
            noResult: true,
          });
          pushSystem('⚠️ Итог дуэли не получен — очки не начислены');
          myDuel.noResult = true;
        }
      }, 30000);
    } else {
      setDuelTimer(() => {
        if (duel !== myDuel || duel.state !== 'result-wait') return;
        myDuel.state = 'done';
        renderDuelCard({
          myClicks: myDuel.clicks,
          oppClicks: 0,
          won: false,
          draw: false,
          awarded: false,
          opponent: myDuel.opponentName,
          noResult: true,
        });
        myDuel.noResult = true;
      }, 32000);
    }
  }

  function publishDuelEnd(myDuel) {
    if (!duel || duel !== myDuel || !duel.results.size) return;

    const aId = clientId;
    const aClicks = duel.results.get(clientId) ?? duel.clicks ?? 0;

    let bId = null;
    let bClicks = 0;
    for (const [id, clicks] of duel.results) {
      if (id !== clientId) {
        bId = id;
        bClicks = Number(clicks) || 0;
      }
    }

    let winnerId = null;
    if (aClicks > bClicks) winnerId = aId;
    else if (bClicks > aClicks) winnerId = bId;

    if (bId === null) return;

    const payload = {
      type: 'duel-end',
      duelId: duel.id,
      aId,
      aName: myName,
      aClicks,
      bId,
      bName: duel.opponentName,
      bClicks,
      winnerId,
      ts: Date.now(),
    };

    publishXRepeat(payload);
    handleDuelEnd(payload);
  }

  function handleDuelEnd(payload) {
    if (!payload || payload.type !== 'duel-end') return;

    const endKey = 'end:' + payload.duelId;
    if (processedEvents.has(endKey)) return;
    processedEvents.add(endKey);

    const active = Boolean(duel && duel.id === payload.duelId);

    if (active) {
      if (duel.state === 'done' && !duel.noResult) return;
      clearDuelTimers();
      duel.state = 'done';
    }

    const mine = payload.aId === clientId;
    const myClicks = mine ? payload.aClicks : payload.bClicks;
    const oppClicks = mine ? payload.bClicks : payload.aClicks;
    const opponent = mine ? payload.bName : payload.aName;
    const won = payload.winnerId === clientId;
    const draw = payload.winnerId === null;

    if (active) {
      renderDuelCard({ myClicks, oppClicks, won, draw, awarded: won, opponent });
      if (won) awardDuelPoint(payload.duelId);

      if (won) pushSystem(`🏆 ${myName} побеждает в дуэли с ${opponent} (${myClicks}:${oppClicks})`);
      else if (draw) pushSystem(`🤝 Ничья в дуэли ${myName} и ${opponent} (${myClicks}:${oppClicks})`);
      else pushSystem(`⚔️ ${opponent} побеждает в дуэли с ${myName} (${oppClicks}:${myClicks})`);
      return;
    }

    const winnerName = payload.winnerId === null
      ? null
      : payload.winnerId === payload.aId
        ? payload.aName
        : payload.bName;

    if (draw) {
      pushSystem(`🤝 Ничья в дуэли ${payload.aName} и ${payload.bName} (${payload.aClicks}:${payload.bClicks})`);
    } else {
      const w = payload.winnerId === payload.aId ? payload.aClicks : payload.bClicks;
      const l = payload.winnerId === payload.aId ? payload.bClicks : payload.aClicks;
      pushSystem(`🏆 ${winnerName} побеждает в дуэли (${w}:${l})`);
    }
  }

  function onDuelResult(data) {
    if (!duel || duel.id !== data.duelId) return;
    duel.results.set(data.clientId, Number(data.clicks) || 0);
    if (duel.role === 'challenger' && duel.results.size >= 2) {
      if (duel.state === 'done' && duel.noResult) duel.state = 'result-wait';
      publishDuelEnd(duel);
    }
  }

  function onDuelInvite(data) {
    if (data.targetTab !== tabId && data.targetId !== clientId) return;
    if (duel && duel.id === data.duelId) return;

    if (!myName) {
      publishX({ type: 'duel-decline', duelId: data.duelId, fromId: clientId, ts: Date.now() });
      return;
    }
    if (duel) {
      publishX({ type: 'duel-decline', duelId: data.duelId, fromId: clientId, reason: 'busy', ts: Date.now() });
      return;
    }

    duel = {
      id: data.duelId,
      role: 'target',
      state: 'invite',
      opponentName: data.from || 'Гость',
      opponentId: data.fromId,
      opponentTab: data.fromTab,
      duration: Number(data.duration) || 10000,
      clicks: 0,
      results: new Map(),
      endsAt: 0,
    };

    renderDuelInvite(data);
  }

  function onDuelAccept(data) {
    if (!duel || duel.id !== data.duelId || duel.state !== 'waiting') return;
    publishXRepeat({ type: 'duel-ack', duelId: data.duelId, fromId: clientId, ts: Date.now() });
    openDuelArena();
  }

  function onDuelDecline(data) {
    if (!duel || duel.id !== data.duelId || duel.state !== 'waiting') return;
    const name = duel.opponentName;
    const reason = data.reason === 'busy'
      ? `${name} сейчас занят(а)`
      : data.reason === 'cancel'
        ? 'вызов отменён'
        : `${name} отклонил(а) вызов`;
    closeDuel();
    pushSystem('⚔️ ' + reason);
  }

  function renderTyping() {    const names = [...typingUsers.values()];
    typingEl.innerHTML = '';
    if (!names.length) return;
    const label = names.length === 1 ? `${names[0]} печатает` : `${names.length} человека печатают`;
    const span = document.createElement('span');
    span.textContent = label;
    const b = document.createElement('span');
    b.className = 'b';
    for (let i = 0; i < 3; i++) b.append(document.createElement('i'));
    typingEl.append(span, b);
  }

  function setConn(state) {
    const dot = $('connDot');
    const text = $('connText');
    const tag = $('liveTag');
    if (state === 'live') {
      dot.className = 'dot live';
      text.textContent = 'в эфире';
      tag.classList.remove('off');
      tag.innerHTML = '<span class="dot live"></span>live';
    } else if (state === 'connecting') {
      dot.className = 'dot';
      text.textContent = 'подключение…';
      tag.classList.add('off');
      tag.innerHTML = '<span class="dot"></span>офлайн';
    } else {
      dot.className = 'dot';
      text.textContent = 'нет связи';
      tag.classList.add('off');
      tag.innerHTML = '<span class="dot"></span>офлайн';
    }
  }

  /* ---------- Сообщения ---------- */

  function addMessage(msg, isIncoming) {
    if (!msg || !msg.id || !msg.text) return;
    if (messages.some((m) => m.id === msg.id)) return;

    messages.push(msg);
    messages.sort((a, b) => a.ts - b.ts);
    if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);

    if (isIncoming && msg.clientId !== clientId) {
      typingUsers.delete(msg.clientId);
      renderTyping();
      if (!stickToBottom) {
        unread++;
        jumpBtn.textContent = `↓ Новые сообщения (${unread})`;
        jumpBtn.classList.add('show');
      }
    }
    scheduleRender();
  }

  function publishPresence() {
    if (!mqtt || !connected || !myName) return;
    mqtt.publish(`${BASE}/p/${tabId}`, JSON.stringify({
      clientId,
      name: myName,
      color: myColor,
      ts: Date.now(),
    }), { qos: 0, retain: true });
  }

  function sendMessage(text) {
    const msg = {
      id: rand(),
      clientId,
      name: myName,
      color: myColor,
      text: text.slice(0, 2000),
      ts: Date.now(),
    };
    addMessage(msg, false);
    stickToBottom = true;
    if (mqtt) {
      mqtt.publish(`${BASE}/m/${msg.id}`, JSON.stringify(msg), { qos: 1, retain: true });
    }
  }

  /* ---------- MQTT ---------- */

  function reconnectNow() {
    if (!myName) return;
    connected = false;
    setConn('connecting');
    online.delete(clientId);
    renderOnline();
    try { if (mqtt) mqtt.end(true); } catch {}
    mqtt = null;
    connect();
  }

  function connect() {
    if (!myName) return;    if (mqtt) {
      try { mqtt.end(true); } catch {}
    }
    setConn('connecting');

    mqtt = window.mqtt.connect(BROKER, {
      clientId: 'lf_' + tabId,
      clean: false,
      keepalive: 60,
      resubscribe: true,
      reconnectPeriod: 2500,
      connectTimeout: 12000,
      will: {
        topic: `${BASE}/p/${tabId}`,
        payload: '',
        qos: 0,
        retain: true,
      },
    });

    mqtt.on('connect', () => {
      connected = true;
      online.set(clientId, {
        clientId,
        name: myName,
        color: myColor,
        tabId,
        ts: Date.now(),
        lastSeen: Date.now(),
      });
      renderOnline();
      mqtt.subscribe([`${BASE}/#`], { qos: 1 }, () => {
        setConn('live');
        publishPresence();
        lastEchoAt = Date.now();
      });
      input.focus();
    });

    mqtt.on('reconnect', () => setConn('connecting'));
    mqtt.on('close', () => {
      connected = false;
      setConn('error');
      typingUsers.clear();
      renderTyping();
    });
    mqtt.on('error', () => setConn('error'));

    mqtt.on('message', (topic, payload) => {
      let data = null;
      const raw = payload.toString();
      if (!raw) {
        if (topic.startsWith(`${BASE}/p/`)) {
          const key = topic.slice(`${BASE}/p/`.length);
          const found = [...online.entries()].find(([, v]) => v.tabId === key);
          if (found) {
            online.delete(found[0]);
            renderOnline();
          }
        }
        return;
      }
      try { data = JSON.parse(raw); } catch { return; }
      if (!data) return;

      if (topic.startsWith(`${BASE}/m/`)) {
        if (data.ts && Date.now() - data.ts > HISTORY_TTL) {
          mqtt.publish(topic, '', { qos: 0, retain: true });
          return;
        }
        addMessage(data, true);
      } else if (topic.startsWith(`${BASE}/p/`)) {
        const tab = topic.slice(`${BASE}/p/`.length);
        if (data.ts && Date.now() - data.ts > PRESENCE_TTL) {
          mqtt.publish(topic, '', { qos: 0, retain: true });
          return;
        }
        const prev = online.get(data.clientId);
        if (prev && prev.ts > (data.ts || 0)) return;
        online.set(data.clientId, {
          clientId: data.clientId,
          name: data.name,
          color: data.color,
          tabId: tab,
          ts: data.ts || Date.now(),
          lastSeen: Date.now(),
        });
        renderOnline();
      } else if (topic === `${BASE}/t`) {
        if (!data.clientId || data.clientId === clientId) return;
        if (data.typing) typingUsers.set(data.clientId, data.name);
        else typingUsers.delete(data.clientId);
        renderTyping();
      } else if (topic === `${BASE}/x`) {
        if (!data.ts || Date.now() - data.ts > 60000) return;
        if (data.id && processedEvents.has(data.id)) return;

        if (data.type === 'screamer') {
          if (data.id) processedEvents.add(data.id);
          pushSystem(`😱 ${data.from} наслал скримера на ${data.targetName}`);
          if (data.targetTab === tabId || data.target === clientId) playScreamer();
        } else if (data.type === 'duel-invite') {
          onDuelInvite(data);
        } else if (data.type === 'duel-accept') {
          onDuelAccept(data);
        } else if (data.type === 'duel-decline') {
          onDuelDecline(data);
        } else if (data.type === 'duel-result') {
          onDuelResult(data);
        } else if (data.type === 'duel-end') {
          handleDuelEnd(data);
        } else if (data.type === 'duel-ack') {
          if (duel && duel.id === data.duelId && duelResend) {
            clearInterval(duelResend);
            duelResend = null;
          }
        }
      } else if (topic.startsWith(`${BASE}/hb/`)) {
        lastEchoAt = Date.now();
      } else if (topic.startsWith(`${BASE}/s/`)) {
        if (!data || !data.clientId) return;
        scores.set(data.clientId, {
          clientId: data.clientId,
          name: data.name || 'Гость',
          color: data.color || colorFromId(data.clientId),
          score: Number(data.score) || 0,
        });
        renderScores();
      }
    });
  }

  setInterval(() => {
    publishPresence();
    let changed = false;
    for (const [id, person] of online) {
      if (Date.now() - person.lastSeen > PRESENCE_TTL) {
        online.delete(id);
        changed = true;
      }
    }
    if (changed) renderOnline();
    if (mqtt && connected) {
      mqtt.publish(`${BASE}/hb/${tabId}`, String(Date.now()), { qos: 0 });
      if (Date.now() - lastEchoAt > 30000) reconnectNow();
    }
  }, 10_000);

  // публичный брокер иногда теряет подписку — проверяем по «эху» и переподключаемся
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && mqtt && connected && Date.now() - lastEchoAt > 12000) {
      reconnectNow();
    }
  });

  setInterval(() => {
    for (const [id, name] of typingUsers) {
      // чистим «печатает», если человек давно молчит
      if (!online.has(id)) typingUsers.delete(id);
    }
    renderTyping();
  }, 5000);

  /* ---------- Ввод ---------- */

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 148) + 'px';
    const len = input.value.length;
    $('chars').textContent = len > 1500 ? `${len} / 2000` : '';
  }

  function send() {
    const text = input.value.trim();
    if (!text || !myName) return;

    if (/^\/(скример|screamer)(\s|$)/i.test(text)) {
      input.value = '';
      autosize();
      sendBtn.disabled = true;
      stopTyping();
      runScreamerCommand();
      return;
    }

    const duelMatch = text.match(/^\/(дуэль|duel)(?:\s+([\s\S]+))?$/i);
    if (duelMatch) {
      input.value = '';
      autosize();
      sendBtn.disabled = true;
      stopTyping();
      runDuelCommand(duelMatch[2] || '');
      return;
    }

    input.value = '';
    autosize();
    sendBtn.disabled = true;
    stopTyping();
    if (!connected) {
      alert('Нет связи с лентой. Проверьте интернет — сообщение не отправлено.');
      input.value = text;
      autosize();
      return;
    }
    sendMessage(text);
  }

  function sendTyping(typing) {
    if (!mqtt || !connected) return;
    mqtt.publish(`${BASE}/t`, JSON.stringify({ clientId, name: myName, typing }), { qos: 0 });
  }

  function startTyping() {
    if (!myName) return;
    const now = Date.now();
    if (!typingActive) {
      typingActive = true;
      sendTyping(true);
      lastTypingSent = now;
    } else if (now - lastTypingSent > 2500) {
      sendTyping(true);
      lastTypingSent = now;
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 1800);
  }

  function stopTyping() {
    clearTimeout(typingTimer);
    if (typingActive) {
      typingActive = false;
      sendTyping(false);
    }
  }

  /* ---------- Имя ---------- */

  function applyName(name) {
    myName = name.trim().slice(0, 32) || 'Аноним';
    store.set('livefeed.name', myName);
    $('myName').textContent = myName;
    $('myAvatar').textContent = initials(myName);
    $('myAvatar').style.background = myColor;
    $('myAvatar').title = myName;
    document.title = `Live-лента — ${myName}`;
  }

  function openNameModal() {
    nameInput.value = myName;
    nameModal.classList.remove('hidden');
    nameGo.disabled = !nameInput.value.trim();
    setTimeout(() => nameInput.focus(), 60);
  }

  nameInput.addEventListener('input', () => {
    nameGo.disabled = !nameInput.value.trim();
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameGo.click();
  });

  nameGo.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const hadName = Boolean(myName);
    applyName(name);
    nameModal.classList.add('hidden');
    if (!mqtt) connect();
    else publishPresence();
    if (hadName) renderFeed();
    input.focus();
  });

  $('renameBtn').addEventListener('click', openNameModal);

  /* ---------- Переключатель призраков ---------- */

  function setGhosts(on) {
    document.body.classList.toggle('no-ghosts', !on);
    ghostToggle.classList.toggle('off', !on);
    ghostToggle.setAttribute('aria-pressed', String(on));
    store.set('livefeed.ghosts', on ? '1' : '0');
  }

  ghostToggle.addEventListener('click', () => {
    setGhosts(document.body.classList.contains('no-ghosts'));
  });

  setGhosts(store.get('livefeed.ghosts', '1') !== '0');

  /* ---------- События ---------- */

  feed.addEventListener('scroll', () => {
    const distance = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
    stickToBottom = distance < 90;
    if (stickToBottom && unread) {
      unread = 0;
      jumpBtn.classList.remove('show');
    }
  });

  jumpBtn.addEventListener('click', () => {
    unread = 0;
    stickToBottom = true;
    jumpBtn.classList.remove('show');
    scrollToBottom(false);
  });

  input.addEventListener('input', () => {
    autosize();
    sendBtn.disabled = !input.value.trim();
    if (input.value.trim()) startTyping();
    else stopTyping();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });

  window.addEventListener('beforeunload', () => {
    if (typingActive) sendTyping(false);
    if (mqtt) {
      try {
        mqtt.publish(`${BASE}/p/${tabId}`, '', { qos: 0, retain: true });
      } catch {}
    }
  });

  /* ---------- Старт ---------- */

  autosize();
  setConn('connecting');
  renderFeed();
  renderOnline();
  renderScores();

  if (myName) {
    applyName(myName);
    connect();
  } else {
    applyName('Гость');
    openNameModal();
    $('myName').textContent = 'Гость';
  }
})();
