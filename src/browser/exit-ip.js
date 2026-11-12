/**
 * 经上游代理探测出口 IP（供 detail / proxy/update 回写）。
 *
 * 所有网络步骤都必须有超时：
 * 代理握手成功但不回数据、或目标端口被代理吞掉时，没有超时会永久挂起，
 * 进而让 /browser/proxy/update 一直不返回，「打开环境」在 open 之前就卡死。
 */
const net = require('node:net');
const http = require('node:http');

const SOCKET_TIMEOUT_MS = 8000;
const PROBE_HARD_TIMEOUT_MS = 12000;

function socks5Connect(host, port, user, pass, destHost, destPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), host);
    sock.setTimeout(SOCKET_TIMEOUT_MS);
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    const fail = (e) => { try { sock.destroy(); } catch { /* */ } reject(e); };

    sock.on('error', fail);
    sock.on('timeout', () => fail(new Error(`socks5 ${stage} 超时`)));
    sock.on('close', () => { if (stage !== 'done') fail(new Error(`socks5 ${stage} 连接被关闭`)); });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        const method = buf[1];
        buf = buf.slice(2);
        if (method === 0x02) {
          stage = 'auth';
          const u = Buffer.from(String(user || ''), 'utf8');
          const p = Buffer.from(String(pass || ''), 'utf8');
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          return;
        }
        if (method === 0x00) {
          stage = 'request';
          sendReq();
          return;
        }
        return fail(new Error('socks method'));
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        if (buf[1] !== 0x00) return fail(new Error('socks auth fail'));
        buf = buf.slice(2);
        stage = 'request';
        sendReq();
        return;
      }
      if (stage === 'request') {
        if (buf.length < 4) return;
        if (buf[1] !== 0x00) return fail(new Error('socks connect fail'));
        stage = 'done';
        sock.removeAllListeners('data');
        sock.removeAllListeners('timeout');
        sock.setTimeout(0);
        resolve(sock);
      }
    });

    function sendReq() {
      const hb = Buffer.from(destHost, 'utf8');
      const req = Buffer.alloc(7 + hb.length);
      req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03; req[4] = hb.length;
      hb.copy(req, 5);
      req.writeUInt16BE(destPort, 5 + hb.length);
      sock.write(req);
    }

    const methods = (user || pass) ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
    sock.write(methods);
  });
}

function httpGetOverSocket(sock, host, path = '/') {
  return new Promise((resolve, reject) => {
    const req = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n');
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* */ }
      const idx = data.indexOf('\r\n\r\n');
      resolve(idx >= 0 ? data.slice(idx + 4).trim() : data.trim());
    };
    sock.setTimeout(SOCKET_TIMEOUT_MS);
    sock.on('data', (c) => {
      data += c.toString('utf8');
      // 响应已含完整 IP 就不必等对端关闭连接
      const idx = data.indexOf('\r\n\r\n');
      if (idx >= 0 && /\d+\.\d+\.\d+\.\d+/.test(data.slice(idx + 4))) finish();
    });
    sock.on('end', finish);
    sock.on('close', finish);
    sock.on('timeout', () => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* */ }
      reject(new Error('读取出口 IP 响应超时'));
    });
    sock.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    sock.write(req);
  });
}

async function probeExitIpInner(profile) {
  const type = String(profile.proxy_type || 'noproxy').toLowerCase();
  if (type === 'noproxy' || !profile.proxy_host) {
    return probeDirect();
  }
  try {
    if (type === 'socks5' || type === 'socks') {
      const sock = await socks5Connect(
        profile.proxy_host,
        profile.proxy_port,
        profile.proxy_user,
        profile.proxy_pass,
        'api.ipify.org',
        80
      );
      const body = await httpGetOverSocket(sock, 'api.ipify.org', '/');
      const ip = String(body || '').match(/\d+\.\d+\.\d+\.\d+/)?.[0] || '';
      return { ip, via: 'socks5' };
    }
    // http(s) proxy: CONNECT then GET
    const sock = net.connect(Number(profile.proxy_port), profile.proxy_host);
    sock.setTimeout(SOCKET_TIMEOUT_MS);
    const auth = (profile.proxy_user || profile.proxy_pass)
      ? Buffer.from(`${profile.proxy_user || ''}:${profile.proxy_pass || ''}`, 'utf8').toString('base64')
      : '';
    const head = [
      'CONNECT api.ipify.org:80 HTTP/1.1',
      'Host: api.ipify.org:80',
      auth ? `Proxy-Authorization: Basic ${auth}` : '',
      '',
      '',
    ].filter(Boolean).join('\r\n');
    await new Promise((resolve, reject) => {
      let buf = '';
      sock.on('error', reject);
      sock.on('timeout', () => { try { sock.destroy(); } catch { /* */ } reject(new Error('http 代理 CONNECT 超时')); });
      sock.on('data', (c) => {
        buf += c.toString('binary');
        if (buf.includes('\r\n\r\n')) {
          if (!/^HTTP\/1\.\d 200/i.test(buf)) {
            reject(new Error(buf.split('\r\n')[0]));
            return;
          }
          sock.removeAllListeners('data');
          sock.removeAllListeners('timeout');
          resolve();
        }
      });
      sock.write(head);
    });
    const body = await httpGetOverSocket(sock, 'api.ipify.org', '/');
    const ip = String(body || '').match(/\d+\.\d+\.\d+\.\d+/)?.[0] || '';
    return { ip, via: 'http' };
  } catch (e) {
    return { ip: '', via: 'error', error: e.message };
  }
}

/**
 * @param {{ proxy_type?: string, proxy_host?: string, proxy_port?: number, proxy_user?: string, proxy_pass?: string }} profile
 * 无论内部发生什么，PROBE_HARD_TIMEOUT_MS 内必定返回（失败时 ip 为空）。
 */
function probeExitIp(profile) {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ip: '', via: 'error', error: `出口 IP 探测超时（${PROBE_HARD_TIMEOUT_MS / 1000}s）` }),
      PROBE_HARD_TIMEOUT_MS,
    );
    probeExitIpInner(profile)
      .then((r) => { clearTimeout(timer); resolve(r); })
      .catch((e) => { clearTimeout(timer); resolve({ ip: '', via: 'error', error: e?.message || String(e) }); });
  });
}

function probeDirect() {
  return new Promise((resolve) => {
    const req = http.get('http://api.ipify.org/', { timeout: SOCKET_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        const ip = String(body || '').match(/\d+\.\d+\.\d+\.\d+/)?.[0] || '';
        resolve({ ip, via: 'direct' });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ip: '', via: 'error', error: '直连探测超时' }); });
    req.on('error', (e) => resolve({ ip: '', via: 'error', error: e.message }));
  });
}

module.exports = { probeExitIp };
