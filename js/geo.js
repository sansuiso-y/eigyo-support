/* Geo: geocoding (Nominatim), routing (OSRM), route optimization */
(function(){
  let geoCache = {};
  try { geoCache = JSON.parse(localStorage.getItem('sales.geocache')||'{}') || {}; } catch(e){ geoCache = {}; }
  function saveCache(){ try{ localStorage.setItem('sales.geocache', JSON.stringify(geoCache)); }catch(e){} }
  let lastNominatim = 0;
  async function throttle(){ const wait = 1100 - (Date.now()-lastNominatim); if (wait>0) await new Promise(r=>setTimeout(r,wait)); lastNominatim = Date.now(); }

  async function geocode(address){
    address = (address||'').trim();
    if (!address) return null;
    if (geoCache[address]) return geoCache[address];
    await throttle();
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=jp&accept-language=ja&q=${encodeURIComponent(address)}`;
    const res = await fetch(url, {headers:{'Accept':'application/json'}});
    if (!res.ok) throw new Error('住所検索に失敗しました ('+res.status+')');
    const arr = await res.json();
    if (!arr.length) return null;
    const r = { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), display: arr[0].display_name };
    geoCache[address] = r; saveCache();
    return r;
  }
  async function reverse(lat,lng){
    await throttle();
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=ja&lat=${lat}&lon=${lng}`);
    if (!res.ok) return null;
    const j = await res.json();
    return j.display_name || null;
  }

  function haversineKm(a,b){
    const R=6371, toR=x=>x*Math.PI/180;
    const dLat=toR(b.lat-a.lat), dLng=toR(b.lng-a.lng);
    const s=Math.sin(dLat/2)**2+Math.cos(toR(a.lat))*Math.cos(toR(b.lat))*Math.sin(dLng/2)**2;
    return 2*R*Math.asin(Math.sqrt(s));
  }
  function estimate(points){
    let km=0; for(let i=1;i<points.length;i++) km += haversineKm(points[i-1],points[i])*1.3;
    return { distanceKm: km, durationMin: km/35*60, geometry: points.map(p=>[p.lat,p.lng]), estimated:true, legs: null };
  }
  /* points: [{lat,lng}] -> {distanceKm,durationMin,geometry:[[lat,lng]],legs:[{distanceKm,durationMin}]} */
  async function route(points){
    if (!points || points.length<2) return { distanceKm:0, durationMin:0, geometry:[], legs:[] };
    const coords = points.map(p=>`${p.lng},${p.lat}`).join(';');
    try {
      const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), 12000);
      const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`, {signal:ctrl.signal});
      clearTimeout(t);
      if (!res.ok) throw new Error('OSRM '+res.status);
      const j = await res.json();
      if (j.code!=='Ok' || !j.routes?.length) throw new Error('経路なし');
      const r = j.routes[0];
      return { distanceKm: r.distance/1000, durationMin: r.duration/60,
        geometry: r.geometry.coordinates.map(c=>[c[1],c[0]]),
        legs: r.legs.map(l=>({distanceKm:l.distance/1000, durationMin:l.duration/60})), estimated:false };
    } catch(e){
      console.warn('OSRM failed, using estimate', e);
      const est = estimate(points);
      est.legs = []; for(let i=1;i<points.length;i++){ const km=haversineKm(points[i-1],points[i])*1.3; est.legs.push({distanceKm:km, durationMin:km/35*60}); }
      return est;
    }
  }
  /* Table of pairwise durations (minutes) via OSRM table; fallback haversine */
  async function matrix(points){
    const n = points.length;
    const fallback = ()=> points.map(a=>points.map(b=>haversineKm(a,b)*1.3/35*60));
    if (n<2) return [[0]];
    try {
      const coords = points.map(p=>`${p.lng},${p.lat}`).join(';');
      const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), 12000);
      const res = await fetch(`https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`, {signal:ctrl.signal});
      clearTimeout(t);
      if (!res.ok) throw new Error('table '+res.status);
      const j = await res.json();
      if (j.code!=='Ok') throw new Error('table');
      return j.durations.map(row=>row.map(v=> v==null ? 1e6 : v/60));
    } catch(e){ console.warn('OSRM table failed', e); return fallback(); }
  }
  /* Optimize visiting order. start: {lat,lng}; stops: [{lat,lng,...}]; returns {order:[idx], stops:[...]}.
     Nearest neighbor + 2-opt on time matrix. If roundTrip, returns to start. */
  async function optimize(start, stops, {roundTrip=false, fixedLast=false}={}){
    if (!stops.length) return { order:[], stops:[] };
    const pts = [start, ...stops];
    const M = await matrix(pts);
    const n = stops.length;
    const cost = (order)=>{ let c=M[0][order[0]+1]; for(let i=1;i<order.length;i++) c+=M[order[i-1]+1][order[i]+1]; if(roundTrip) c+=M[order[order.length-1]+1][0]; return c; };
    // nearest neighbor
    let remaining = Array.from({length:n},(_,i)=>i);
    let last = null;
    if (fixedLast && n>1){ last = n-1; remaining = remaining.filter(i=>i!==last); }
    let cur = 0, order = [];
    while (remaining.length){
      let best=-1, bd=Infinity;
      for (const i of remaining){ const d=M[cur][i+1]; if(d<bd){bd=d;best=i;} }
      order.push(best); remaining = remaining.filter(i=>i!==best); cur = best+1;
    }
    if (last!==null) order.push(last);
    // 2-opt
    const lim = fixedLast ? order.length-1 : order.length;
    let improved = true, iter=0;
    while (improved && iter<200){
      improved=false; iter++;
      for (let i=0;i<lim-1;i++) for (let k=i+1;k<lim;k++){
        const cand = order.slice(0,i).concat(order.slice(i,k+1).reverse(), order.slice(k+1));
        if (cost(cand) < cost(order)-1e-9){ order=cand; improved=true; }
      }
    }
    return { order, stops: order.map(i=>stops[i]), matrix:M };
  }
  function gmapsUrl(points){
    // points: [{lat,lng}] or address strings
    const enc = p => typeof p==='string' ? encodeURIComponent(p) : `${p.lat},${p.lng}`;
    if (points.length===1) return `https://www.google.com/maps/search/?api=1&query=${enc(points[0])}`;
    const origin = enc(points[0]), dest = enc(points[points.length-1]);
    const way = points.slice(1,-1).map(enc).join('|');
    return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}${way?'&waypoints='+way:''}&travelmode=driving`;
  }
  function currentPosition(){
    return new Promise((res,rej)=>{
      if (!navigator.geolocation) return rej(new Error('位置情報が使えません'));
      navigator.geolocation.getCurrentPosition(p=>res({lat:p.coords.latitude,lng:p.coords.longitude}), e=>rej(new Error('現在地を取得できませんでした')), {timeout:8000});
    });
  }
  window.Geo = { geocode, reverse, haversineKm, route, matrix, optimize, gmapsUrl, currentPosition, estimate };
})();
