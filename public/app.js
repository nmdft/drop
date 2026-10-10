const element = id => document.getElementById(id);
const bytes = size => size < 1000000 ? `${(size / 1000).toFixed(1)} KB` : `${(size / 1000000).toFixed(1)} MB`;
const date = timestamp => new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
let sending = false;
let receiving;
let latestReceipt;
let limits;

async function api(action, body) {
  const response = await fetch(`/api/${action}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败，请重试。');
  return result;
}

function notice(id, message, error = false) {
  const target = element(id);
  target.textContent = message;
  target.classList.toggle('error', error);
}

async function refreshStatus() {
  try {
    limits = await api('status');
    element('file-limit').textContent = `最多 ${bytes(limits.maxFileBytes)}`;
  } catch { limits = undefined; }
}

function solveProof(challenge) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('proof-worker.js');
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('计算验证超时，请重试。')); }, 120000);
    worker.onmessage = ({ data }) => {
      if (data.working) return;
      clearTimeout(timer);
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data.nonce);
    };
    worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(new Error('浏览器无法完成计算验证。')); };
    worker.postMessage(challenge);
  });
}

async function copy(value, messageId) {
  try { await navigator.clipboard.writeText(value); notice(messageId, '已复制。'); }
  catch { notice(messageId, '复制失败，请手动选中内容复制。', true); }
}

element('file').addEventListener('change', () => {
  const file = element('file').files[0];
  if (!file) return;
  element('text').value = '';
  element('file-label').textContent = `${file.name} · ${bytes(file.size)}`;
  element('file-limit').textContent = limits ? `最多 ${bytes(limits.maxFileBytes)}` : '最多 300 MB';
  element('file-picker').classList.add('selected');
  element('clear-file').hidden = false;
});
element('text').addEventListener('input', () => {
  if (element('file').files.length) clearFile();
});

function clearFile() {
  element('file').value = '';
  element('file-label').textContent = '拖入文件或点击选择';
  element('file-picker').classList.remove('selected');
  element('clear-file').hidden = true;
  element('file-limit').textContent = limits ? `最多 ${bytes(limits.maxFileBytes)}` : '最多 300 MB';
}

element('clear-file').addEventListener('click', clearFile);
for (const eventName of ['dragenter', 'dragover']) element('composer').addEventListener(eventName, event => { event.preventDefault(); element('composer').classList.add('dragging'); });
for (const eventName of ['dragleave', 'drop']) element('composer').addEventListener(eventName, event => { event.preventDefault(); element('composer').classList.remove('dragging'); });
element('composer').addEventListener('drop', event => {
  const [file] = event.dataTransfer.files;
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  element('file').files = transfer.files;
  element('file').dispatchEvent(new Event('change'));
});

element('send-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (sending) return;
  let uploadToken;
  let committed = false;
  sending = true;
  element('send-button').disabled = true;
  element('send-progress').hidden = false;
  element('send-progress').value = 0;
  try {
    const file = element('file').files[0];
    const text = element('text').value;
    const kind = file ? 'file' : 'text';
    if (kind === 'file' && (file.size === 0 || file.size > (limits?.maxFileBytes ?? 300000000))) throw new Error('文件不能为空或超过当前大小限制。');
    if (kind === 'text' && (!text || new TextEncoder().encode(text).byteLength > 1000000)) throw new Error('请粘贴文字，或选择一个文件。');
    notice('send-notice', '正在进行匿名发送计算验证，请稍候…');
    const challenge = await api('challenge', {});
    const nonce = await solveProof(challenge);
    notice('send-notice', '正在预留空间…');
    let result = await api('send', { kind, duration: Number(element('duration').value), challengeToken: challenge.token, nonce, ...(kind === 'file' ? { name: file.name, size: file.size } : { text }) });
    if (kind === 'file') {
      uploadToken = result.uploadToken;
      for (let index = 0; index < result.parts; index += 1) {
        notice('send-notice', `正在上传 ${index + 1} / ${result.parts} 个分块…`);
        const part = file.slice(index * result.chunkBytes, Math.min(file.size, (index + 1) * result.chunkBytes));
        let success = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const response = await fetch(`/api/part?index=${index}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Token': uploadToken }, body: part });
          const output = await response.json();
          if (response.ok) { success = true; break; }
          if (response.status < 500 || attempt === 2) throw new Error(output.error || '上传失败。');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!success) throw new Error('上传失败。');
        element('send-progress').value = (index + 1) / result.parts;
      }
      notice('send-notice', '正在确认文件完整性并生成取件码…');
      result = await api('complete', { token: uploadToken });
    }
    committed = true;
    latestReceipt = result;
    element('receipt').hidden = false;
    element('receipt-code').textContent = result.code;
    element('receipt-expiry').textContent = `取件码有效至 ${date(result.expiresAt)}；内容保留至 ${date(result.deleteAt)}。`;
    element('receipt-link').value = `${location.origin}/#code=${result.code}`;
    element('revoke-link').value = `${location.origin}/#revoke=${encodeURIComponent(result.revokeToken)}`;
    notice('send-notice', '发送成功。请妥善保存取件码；撤销链接仅供自己使用。');
    element('send-progress').value = 1;
  } catch (error) {
    notice('send-notice', error.message, true);
    if (uploadToken && !committed) {
      try { await api('revoke', { token: uploadToken }); } catch { }
    }
  } finally {
    sending = false;
    element('send-button').disabled = false;
  }
});

element('pickup-form').addEventListener('submit', async event => {
  event.preventDefault();
  element('pickup-button').disabled = true;
  element('received').hidden = true;
  receiving = undefined;
  try {
    const code = element('code').value.trim();
    if (!/^\d{4}$/.test(code)) throw new Error('请输入四位数字，包括开头的0。');
    notice('pickup-notice', '正在取件…');
    receiving = await api('pickup', { code });
    element('received').hidden = false;
    element('received-name').textContent = receiving.name;
    element('received-detail').textContent = `${bytes(receiving.size)} · 有效至 ${date(receiving.expiresAt)}`;
    element('received-text').hidden = receiving.kind !== 'text';
    element('received-text').textContent = receiving.text || '';
    element('copy-text').hidden = receiving.kind !== 'text';
    element('download-button').hidden = receiving.kind !== 'file';
    notice('pickup-notice', '取件成功。有效期内可以重复领取。');
  } catch (error) { notice('pickup-notice', error.message, true); }
  finally { element('pickup-button').disabled = false; }
});

element('download-button').addEventListener('click', async () => {
  if (!receiving) return;
  element('download-button').disabled = true;
  const transfer = receiving;
  let writable;
  try {
    if ('showSaveFilePicker' in window) {
      const handle = await window.showSaveFilePicker({ suggestedName: transfer.name });
      writable = await handle.createWritable();
    }
    const chunks = [];
    for (let index = 0; index < transfer.parts; index += 1) {
      notice('pickup-notice', `正在下载 ${index + 1} / ${transfer.parts} 个分块…`);
      const response = await fetch('/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: transfer.downloadToken, index }) });
      if (!response.ok) throw new Error((await response.json()).error || '下载失败。');
      const data = await response.arrayBuffer();
      if (writable) await writable.write(data);
      else chunks.push(data);
    }
    if (writable) await writable.close();
    else {
      const url = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = transfer.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    notice('pickup-notice', '下载完成。');
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    notice('pickup-notice', error.name === 'AbortError' ? '已取消下载。' : error.message, error.name !== 'AbortError');
  } finally { element('download-button').disabled = false; }
});

element('copy-code').addEventListener('click', () => copy(latestReceipt.code, 'send-notice'));
element('copy-link').addEventListener('click', () => copy(element('receipt-link').value, 'send-notice'));
element('copy-revoke').addEventListener('click', () => copy(element('revoke-link').value, 'send-notice'));
element('copy-text').addEventListener('click', () => copy(receiving.text, 'pickup-notice'));
element('revoke-button').addEventListener('click', async () => {
  if (!latestReceipt || !confirm('立即删除这份内容并使取件码失效？')) return;
  try {
    await api('revoke', { token: latestReceipt.revokeToken });
    element('receipt').hidden = true;
    notice('send-notice', '内容已撤销。取件码仍会保留至三天期满，避免被复用。');
  } catch (error) { notice('send-notice', error.message, true); }
});

async function init() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (/^\d{4}$/.test(fragment.get('code') || '')) element('code').value = fragment.get('code');
  if (fragment.has('revoke')) {
    const token = fragment.get('revoke');
    history.replaceState(null, '', location.pathname);
    if (confirm('此链接用于撤销分享。是否立即删除内容？')) {
      try { await api('revoke', { token }); notice('send-notice', '内容已撤销。'); }
      catch (error) { notice('send-notice', error.message, true); }
    }
  }
  await refreshStatus();
}
init();
