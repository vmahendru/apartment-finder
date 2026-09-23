const UA = 'sidewalk-map/0.1 (personal apartment search)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nominatim(q) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q); url.searchParams.set('format', 'json'); url.searchParams.set('limit', '1');
  const j = await (await fetch(url, { headers: { 'user-agent': UA } })).json();
  await sleep(1200);
  return j.length ? { lat: +j[0].lat, lng: +j[0].lon, name: j[0].display_name } : null;
}

// Nominatim is unreliable for intersections; Overpass can find the shared node
// of two named ways directly, which is exact.
async function crossing(a, b) {
  const q = `[out:json][timeout:60];
way["name"="${a}"](47.48,-122.44,47.75,-122.22)->.a;
way["name"="${b}"](47.48,-122.44,47.75,-122.22)->.b;
node(w.a)(w.b);
out;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: new URLSearchParams({ data: q }),
  });
  const j = await res.json();
  await sleep(1200);
  return j.elements?.length ? { lat: j.elements[0].lat, lng: j.elements[0].lon, name: `${a} x ${b}` } : null;
}

for (const q of ['Fremont, Seattle, WA', 'Queen Anne, Seattle, WA']) {
  const r = await nominatim(q);
  console.log(`${q.padEnd(36)} ${r ? `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}  ${r.name.slice(0, 50)}` : 'NOT FOUND'}`);
}
for (const [a, b] of [
  ['15th Avenue East', 'East Mercer Street'],
  ['East Pike Street', '11th Avenue'],
  ['North 36th Street', 'Fremont Avenue North'],
  ['Queen Anne Avenue North', 'West McGraw Street'],
]) {
  const r = await crossing(a, b);
  console.log(`${`${a} x ${b}`.padEnd(56)} ${r ? `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}` : 'NOT FOUND'}`);
}
