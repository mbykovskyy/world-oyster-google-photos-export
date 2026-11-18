// Runs in the page's MAIN world (needs window.WIZ_global_data for the session tokens).
// Bridges Google Photos' internal batchexecute RPC to content.js via window.postMessage.
(() => {
  const ALLOWED = new Set(['fDcn4b', 'lcxiM']); // photo details, library items by date

  async function rpc(rpcid, args) {
    const W = window.WIZ_global_data;
    if (!W?.SNlM0e) throw new Error('Google Photos session tokens not found');
    const base = location.pathname.match(/^\/u\/\d+/)?.[0] || '';
    const params = new URLSearchParams({
      rpcids: rpcid,
      'source-path': location.pathname,
      'f.sid': W.FdrFJe,
      bl: W.cfb2h,
      hl: 'en',
      _reqid: String(100000 + Math.floor(Math.random() * 900000)),
      rt: 'c',
    });
    const body = new URLSearchParams({
      'f.req': JSON.stringify([[[rpcid, JSON.stringify(args), null, 'generic']]]),
      at: W.SNlM0e,
    });
    const res = await fetch(`${base}/_/PhotosUi/data/batchexecute?${params}`, {
      method: 'POST',
      body,
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    for (const line of (await res.text()).split('\n')) {
      if (!line.includes('"wrb.fr"')) continue;
      for (const entry of JSON.parse(line)) {
        if (entry[0] === 'wrb.fr' && entry[1] === rpcid) return entry[2] == null ? null : JSON.parse(entry[2]);
      }
    }
    throw new Error('RPC response had no payload');
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.source !== 'wo-rpc-req' || !ALLOWED.has(e.data.rpcid)) return;
    const { reqId, rpcid, args } = e.data;
    try {
      window.postMessage({ source: 'wo-rpc-res', reqId, result: await rpc(rpcid, args) }, location.origin);
    } catch (err) {
      window.postMessage({ source: 'wo-rpc-res', reqId, error: String(err?.message || err) }, location.origin);
    }
  });
})();
