(() => {
  'use strict';

  window.LIVE_FEED_VERSION = '1.6.1';

  const $ = (id) => document.getElementById(id);

  /* ---------- Конфигурация ---------- */

  const BROKER = 'wss://broker.emqx.io:8084/mqtt';
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

    const people = [...online.values()];
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
      targetName: target.name,
      from: myName,
      ts: now,
    }), { qos: 0 });

    pushSystem(`😱 ${myName} наслал скримера на ${target.name}`);
    if (target.clientId === clientId) playScreamer();
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

  function connect() {
    if (!myName) return;
    if (mqtt) {
      try { mqtt.end(true); } catch {}
    }
    setConn('connecting');

    mqtt = window.mqtt.connect(BROKER, {
      clientId: 'lf_' + tabId,
      clean: true,
      keepalive: 30,
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
      mqtt.subscribe([`${BASE}/m/+`, `${BASE}/p/+`, `${BASE}/t`, `${BASE}/x`], { qos: 1 }, () => {
        setConn('live');
        publishPresence();
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
        if (data.type !== 'screamer') return;
        if (!data.ts || Date.now() - data.ts > 60000) return;
        if (data.id && processedEvents.has(data.id)) return;
        if (data.id) processedEvents.add(data.id);
        pushSystem(`😱 ${data.from} наслал скримера на ${data.targetName}`);
        if (data.target === clientId) playScreamer();
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
  }, 20_000);

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

  if (myName) {
    applyName(myName);
    connect();
  } else {
    applyName('Гость');
    openNameModal();
    $('myName').textContent = 'Гость';
  }
})();
