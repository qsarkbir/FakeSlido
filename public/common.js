export const $ = (id) => document.getElementById(id);

export function el(tag, { cls, text, attrs = {} } = {}, ...children) {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text !== undefined) element.textContent = text;
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  element.append(...children);
  return element;
}

export function button(label, handler, cls, disabled = false) {
  const element = el('button', { cls, text: label, attrs: { type: 'button' } });
  element.addEventListener('click', handler);
  element.disabled = disabled;
  return element;
}

export function message(text, target = $('notice')) {
  target.textContent = text;
  target.hidden = !text;
}

export function connection(text, disconnected = false) {
  const target = $('connection');
  target.textContent = text;
  target.classList.toggle('offline', disconnected);
}

export function storageGet(store, name) {
  try { return store.getItem(name); } catch { return null; }
}

export function storageSet(store, name, value) {
  try {
    if (value === null) store.removeItem(name);
    else store.setItem(name, value);
    return true;
  } catch {
    return false;
  }
}

export function readFragment() {
  const fragment = location.hash.slice(1);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return fragment;
}

export function tabCredential(name) {
  const keyName = 'fakeslido:' + name;
  const fragment = readFragment();
  if (fragment) storageSet(sessionStorage, keyName, fragment);
  return fragment || storageGet(sessionStorage, keyName);
}

export function participantUrl(code) {
  return location.origin + '/#' + code;
}

export class RequestError extends Error {
  constructor(response, body) {
    super(body?.error ?? 'サーバーとの通信に失敗しました。');
    this.status = response.status;
    this.code = body?.code;
    this.retryAfter = Number(response.headers.get('Retry-After')) || 0;
  }
}

export async function request(path, token, { method = 'GET', data, download = false } = {}) {
  const headers = { Authorization: 'Bearer ' + token };
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method, headers, body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(25_000), cache: 'no-store', credentials: 'omit'
  });
  if (!response.ok) throw new RequestError(response, await response.json().catch(() => null));
  if (response.status === 204) return null;
  return download ? response.blob() : response.json();
}

export async function poll(path, token, { interval, onState, onUnchanged, onInvalid }) {
  if (!token) {
    connection('未接続', true);
    onInvalid('アクセス用URLから開いてください。');
    return;
  }
  let revision = null;
  let delay = 0;
  let retries = 0;
  while (true) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const data = await request(path + (revision === null ? '' : '?revision=' + revision), token);
      if (data) {
        await onState(data);
        revision = data.revision;
      } else {
        onUnchanged?.();
      }
      connection('接続済み');
      delay = interval;
      retries = 0;
    } catch (error) {
      if (error.status === 401 || error.status === 410) {
        connection('未接続', true);
        onInvalid(error.message);
        return;
      }
      connection('再接続中', true);
      revision = null;
      delay = Math.max((error.retryAfter ?? 0) * 1000, Math.min(1000 * 2 ** retries, 15_000));
      retries = Math.min(retries + 1, 4);
    }
  }
}

export function downloadFile(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { attrs: { href: url, download: name } });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const styleLabels = {
  horizontal: '横棒グラフ', vertical: '縦棒グラフ', donut: 'ドーナツ', stacked: '横帯'
};

export function emptyState(title, text) {
  return el('div', { cls: 'empty-state' }, el('img', { attrs: { src: '/mark.svg', alt: '', width: 44, height: 44 } }),
    el('h2', { text: title }), el('p', { text }));
}

export function statusPill(open, everOpened = true) {
  return el('span', {
    cls: 'pill ' + (open ? 'pill-live' : 'pill-muted'),
    text: open ? '受付中' : everOpened ? '受付終了' : '未オープン'
  });
}
