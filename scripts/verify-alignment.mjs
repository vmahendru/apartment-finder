import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
await p.goto('http://localhost:8790/fixture.html', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(10000);
console.log('verdict:', (await p.textContent('#verdict')).replace(/\s+/g,' '));
// Pan and zoom, then re-measure: a projection bug often only shows off-centre.
await p.evaluate(() => map.easeTo({ center: [-122.36, 47.68], zoom: 13.4, duration: 0 }));
await p.waitForTimeout(3500);
console.log('after pan:', (await p.textContent('#verdict')).replace(/\s+/g,' '));
await p.screenshot({ path: '/tmp/shot-align.png' });
await p.evaluate(() => map.easeTo({ center: [-122.30, 47.55], zoom: 11.2, duration: 0 }));
await p.waitForTimeout(3500);
console.log('after zoom out:', (await p.textContent('#verdict')).replace(/\s+/g,' '));
console.log('errors:', errs.length ? errs.slice(0,4) : 'none');
await b.close();
