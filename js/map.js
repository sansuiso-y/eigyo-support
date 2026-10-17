/* MapKit: 画面で使う地図の共通ヘルパー
 *   Google Maps(サーバーから鍵が来たとき)を優先し、鍵がない・読み込めないときは Leaflet + OpenStreetMap に自動で切り替える。
 *   使い方:
 *     const m = await MapKit.create(el, { scrollWheelZoom:false });
 *     const mk = m.marker({lat,lng}, { text:'1', color:'#1f6fdb', popup: HTMLElement });
 *     m.line([[lat,lng],...], { color, weight, dashed });
 *     m.fit([[lat,lng],...]);  m.setView([lat,lng], zoom);  m.clear();  m.invalidate();  mk.openPopup();
 *   鍵は Sync が /api/status から受け取って MapKit.setKey() で渡す(ブラウザ用の鍵。使えるサイトと API は Google Cloud 側で制限済み)。
 */
(function(){
  const LS = 'sales.mapsKey';
  let key = ''; try { key = localStorage.getItem(LS) || ''; } catch(e){}   // 前回の鍵を覚えておき、サーバー応答を待たずに使う
  let googleLoad = null; // Promise<boolean>
  let resolveKey; const keyKnown = new Promise(r=>{ resolveKey = r; });    // Sync が /api/status を受け取って setKey() するまで待つ(最大4秒)

  function setKey(k){
    const nk = String(k||'');
    if (nk !== key){ key = nk; googleLoad = null; }
    try { if (nk) localStorage.setItem(LS, nk); else localStorage.removeItem(LS); } catch(e){}
    resolveKey();
  }
  function provider(){ return key ? 'google' : 'leaflet'; }

  function loadGoogle(){
    if (googleLoad) return googleLoad;
    googleLoad = new Promise(resolve=>{
      if (!key){ resolve(false); return; }
      if (window.google && google.maps && google.maps.Map){ resolve(true); return; }
      const cb = '__mapkitGoogleReady';
      const timer = setTimeout(()=>{ console.warn('Google Maps の読み込みが時間内に終わりませんでした'); resolve(false); }, 12000);
      window[cb] = ()=>{ clearTimeout(timer); resolve(!!(window.google && google.maps && google.maps.Map)); };
      const s = document.createElement('script');
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=ja&region=JP&loading=async&callback=${cb}`;
      s.async = true;
      s.onerror = ()=>{ clearTimeout(timer); console.warn('Google Maps を読み込めませんでした(鍵・ネットワーク)'); resolve(false); };
      document.head.appendChild(s);
    });
    return googleLoad;
  }

  /* ---------- Google 実装 ---------- */
  function googleMap(el, opt){
    const map = new google.maps.Map(el, {
      center: {lat:36.5, lng:137.8}, zoom: 5,
      mapTypeControl:false, streetViewControl:false, fullscreenControl:true, clickableIcons:false,
      gestureHandling: opt.scrollWheelZoom ? 'greedy' : 'cooperative'
    });
    let items = []; let openInfo = null;
    const latlng = p => Array.isArray(p) ? {lat:Number(p[0]), lng:Number(p[1])} : {lat:Number(p.lat), lng:Number(p.lng)};
    return {
      provider:'google', raw: map,
      marker(p, o={}){
        const color = o.color || (o.cls === 'start' ? '#2e9e5b' : '#1f6fdb');
        const mk = new google.maps.Marker({ map, position: latlng(p), zIndex: o.cls === 'start' ? 10 : 5,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 13, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
          label: o.text !== undefined && o.text !== null ? { text: String(o.text), color:'#fff', fontWeight:'700', fontSize:'12px' } : null });
        let info = null;
        if (o.popup){ info = new google.maps.InfoWindow({ content: o.popup }); mk.addListener('click', ()=>{ if (openInfo) openInfo.close(); info.open({ map, anchor: mk }); openInfo = info; }); }
        const handle = { raw: mk, openPopup(){ if (info){ if (openInfo) openInfo.close(); info.open({ map, anchor: mk }); openInfo = info; } } };
        items.push(mk); return handle;
      },
      line(points, o={}){
        const pl = new google.maps.Polyline({ map, path: points.map(latlng), strokeColor: o.color || '#1f6fdb', strokeWeight: o.dashed ? 0 : (o.weight || 4), strokeOpacity: o.dashed ? 0 : (o.opacity ?? .8),
          icons: o.dashed ? [{ icon: { path:'M 0,-1 0,1', strokeOpacity: o.opacity ?? .8, strokeColor: o.color || '#1f6fdb', scale: (o.weight || 4) }, offset:'0', repeat:'14px' }] : null });
        items.push(pl); return pl;
      },
      clear(){ items.forEach(i=>i.setMap(null)); items = []; if (openInfo){ openInfo.close(); openInfo = null; } },
      fit(points, pad=30){ if (!points.length) return; if (points.length === 1){ map.setCenter(latlng(points[0])); map.setZoom(14); return; } const b = new google.maps.LatLngBounds(); points.forEach(p=>b.extend(latlng(p))); map.fitBounds(b, pad); },
      setView(p, zoom){ map.setCenter(latlng(p)); if (zoom) map.setZoom(zoom); },
      invalidate(){ try { google.maps.event.trigger(map, 'resize'); } catch(e){} }
    };
  }

  /* ---------- Leaflet 実装 ---------- */
  function leafletMap(el, opt){
    const map = L.map(el, { scrollWheelZoom: !!opt.scrollWheelZoom });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'&copy; OpenStreetMap contributors', maxZoom:19 }).addTo(map);
    const layer = L.layerGroup().addTo(map);
    map.setView([36.5, 137.8], 5);
    const ll = p => Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p.lat), Number(p.lng)];
    return {
      provider:'leaflet', raw: map,
      marker(p, o={}){
        const html = o.color && o.cls !== 'start' ? `<span style="background:${o.color}">${o.text ?? ''}</span>` : String(o.text ?? '');
        const mk = L.marker(ll(p), { icon: L.divIcon({ className:'num-marker'+(o.cls?' '+o.cls:''), html, iconSize:[26,26], iconAnchor:[13,13], popupAnchor:[0,-12] }) });
        if (o.popup) mk.bindPopup(o.popup);
        layer.addLayer(mk);
        return { raw: mk, openPopup(){ mk.openPopup(); } };
      },
      line(points, o={}){ const pl = L.polyline(points.map(ll), { color: o.color || '#1f6fdb', weight: o.weight || 4, opacity: o.opacity ?? .8, dashArray: o.dashed ? '8 8' : null }); layer.addLayer(pl); return pl; },
      clear(){ layer.clearLayers(); },
      fit(points, pad=30){ if (!points.length) return; if (points.length === 1) map.setView(ll(points[0]), 14); else map.fitBounds(L.latLngBounds(points.map(ll)), { padding:[pad,pad] }); },
      setView(p, zoom){ map.setView(ll(p), zoom || map.getZoom()); },
      invalidate(){ try { map.invalidateSize(); } catch(e){} }
    };
  }

  /* 地図を作る。Google が使えなければ Leaflet。どちらも無理なら null */
  async function create(el, opt={}){
    if (!key) await Promise.race([keyKnown, new Promise(r=>setTimeout(r, 4000))]); // 初回は鍵の有無が分かるまで少し待つ
    if (key && await loadGoogle()){
      try { return googleMap(el, opt); } catch(e){ console.warn('Google Maps init failed, fallback to Leaflet', e); }
    }
    if (typeof L !== 'undefined'){ try { return leafletMap(el, opt); } catch(e){ console.warn('Leaflet init failed', e); } }
    return null;
  }
  function available(){ return !!key || typeof L !== 'undefined'; }

  window.MapKit = { setKey, provider, create, available };
})();
