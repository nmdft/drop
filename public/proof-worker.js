const encoder = new TextEncoder();
self.onmessage = async ({ data: { salt, difficulty } }) => {
  if (difficulty !== 17) { self.postMessage({ error: '验证参数无效。' }); return; }
  for (let nonce = 0; nonce < 100000000; nonce += 1) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}:${nonce}`)));
    if (digest[0] === 0 && digest[1] === 0 && digest[2] < 128) {
      self.postMessage({ nonce });
      return;
    }
    if (nonce % 10000 === 0) self.postMessage({ working: true });
  }
  self.postMessage({ error: '计算验证未完成，请重试。' });
};
