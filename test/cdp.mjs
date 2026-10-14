// CDP 传输层共享模块：WebSocket 连接 + send/eval/mouse/click，browser/desktop e2e 与 ui-audit 共用。
export async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = {
    id: 0, pending: new Map(), ws,
    send(method, params = {}) {
      return new Promise((res, rej) => {
        const id = ++cdp.id;
        cdp.pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async eval(expr) {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
      return r.result.value;
    },
    mouse(type, x, y, button = 'left', count = 1, modifiers = 0) {
      return cdp.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: count, modifiers });
    },
    async click(selector, text = '') {
      const point = await cdp.eval(`(() => {
        const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find(element => element.textContent.includes(${JSON.stringify(text)}));
        const rect = element?.getBoundingClientRect();
        return rect?.width && rect.height ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
      })()`);
      if (!point) throw new Error('点击目标不可见：' + selector + ' ' + text);
      await cdp.mouse('mousePressed', point.x, point.y);
      await cdp.mouse('mouseReleased', point.x, point.y);
    },
  };
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && cdp.pending.has(m.id)) {
      const { res, rej } = cdp.pending.get(m.id);
      cdp.pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  return cdp;
}
