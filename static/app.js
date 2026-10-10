'use strict';
const $ = selector => document.querySelector(selector);
const page = $('#page');
const pages = {
  overview: ['Research overview', 'A measured view of the evidence in this workspace.'],
  watchlist: ['Watchlist', 'Follow tickers and organize them by sector.'],
  news: ['Evidence feed', 'Read the sources behind your sentiment signals.'],
  pipeline: ['Data sources', 'Import your research or connect a news provider.'],
  backtest: ['Simulation lab', 'Test strategy mechanics with explicitly simulated prices.']
};
const pageNames = {overview:'Overview',watchlist:'Watchlist',news:'Evidence feed',pipeline:'Data sources',backtest:'Simulation lab'};
let workspace = 'default', current = 'overview', data, profile, workspaces = [], status = {}, evidenceCache = new Map();
let query = '', sector = '', tone = '', kind = '', period = 'ALL', newsLimit = 100;
let lastFocus, toastTimer, loadVersion = 0, simulationResult = null;
try { workspace = localStorage.getItem('signal.activeWorkspace') || 'default'; } catch {}
if (pages[location.hash.slice(1)]) current = location.hash.slice(1);
const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const num = value => value == null ? '—' : Number(value).toLocaleString();
const initials = name => name.trim().split(/\s+/).slice(0,2).map(part => part[0] || '').join('').toUpperCase() || 'R';
const date = value => value ? new Date(value).toLocaleString(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : 'Not yet';
const toneOf = score => score > 55 ? 'positive' : score < 45 ? 'negative' : 'neutral';
const scoped = (path, id=workspace) => `${path}${path.includes('?')?'&':'?'}workspace=${encodeURIComponent(id)}`;
const json = body => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h10l4 4v14H5ZM14 3v5h5M8 12h8M8 16h5"/></svg>';

function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent=message; $('#toast').hidden=false;
  toastTimer=setTimeout(()=>$('#toast').hidden=true,6500);
}
async function api(url, options) {
  let response;
  try { response=await fetch(url,options); } catch { throw Error('Cannot reach the local engine. Check that the server is running.'); }
  let payload;
  try { payload=await response.json(); } catch { throw Error('The engine returned an unreadable response. Please retry.'); }
  if (!response.ok) {
    const detail=Array.isArray(payload.detail)?payload.detail.map(item=>item.msg).join('; '):payload.detail;
    throw Error(detail||'Request failed. Please retry.');
  }
  return payload;
}
function rememberWorkspace(id) { workspace=id; try { localStorage.setItem('signal.activeWorkspace',id); } catch {} }
function rememberEvidence(rows) { for(const row of rows) evidenceCache.set(row.id,row); }
function shell() {
  $('#workspaceName').textContent=data.workspace.name;
  $('#crumbWorkspace').textContent=data.workspace.name;
  $('#watchCount').textContent=data.watchlist.length;
  $('#profileName').textContent=profile.name; $('#profileRole').textContent=profile.role || 'Local researcher';
  $('#headerAvatar').textContent=initials(profile.name); $('#sidebarAvatar').textContent=initials(profile.name);
  $('#headerAvatar').setAttribute('aria-label',`Edit profile for ${profile.name}`);
  $('#engineLabel').textContent=`${status.engine?.toUpperCase() || 'Engine'} online`;
  $('.engine-status').classList.add('online');
  const groups={}; for(const ticker of data.watchlist) groups[ticker.sector]=(groups[ticker.sector]||0)+1;
  $('#collections').innerHTML=Object.keys(groups).length?Object.entries(groups).sort().map(([name,count])=>`<button class="collection ${sector===name?'active':''}" data-action="collection" data-sector="${safe(name)}"><i></i>${safe(name)}<b>${count}</b></button>`).join(''):'<span class="sidebar-hint">Follow a ticker to organize your research.</span>';
  $('#footerStatus').textContent=data.totals.records?`${num(data.totals.records)} stored records · Updated ${date(data.totals.updated)}`:'No evidence imported · Stored on this computer';
  document.title=`${pageNames[current]} — Signal`;
}
async function loadData() {
  const version=++loadVersion, selected=workspace;
  page.setAttribute('aria-busy','true');
  const [next, nextStatus]=await Promise.all([api(scoped('/api/overview',selected)),api('/api/status')]);
  if(version!==loadVersion || selected!==workspace) return;
  data=next; status=nextStatus; evidenceCache=new Map(); rememberEvidence(data.evidence);
  shell(); render(); page.setAttribute('aria-busy','false');
}
async function refresh() {
  const button=$('#refreshBtn'); button.disabled=true;
  try { if(!profile){[profile,workspaces]=await Promise.all([api('/api/profile'),api('/api/workspaces')]);if(!workspaces.some(item=>item.id===workspace&&!item.archived))rememberWorkspace(workspaces.find(item=>!item.archived).id);}await loadData(); toast('Workspace updated from local storage.'); }
  catch(error) { toast(error.message); }
  finally { button.disabled=false; page.setAttribute('aria-busy','false'); }
}
function go(next, collection='') {
  if(!pages[next]) return;
  current=next; query=''; tone=''; kind=''; newsLimit=100;sector=collection;
  closeModal(); history.replaceState(null,'',`#${next}`);
  if(data) { shell(); render(); }
  window.scrollTo(0,0);
}
function empty(title, description, action='') {
  return `<div class="empty">${icon}<h3>${safe(title)}</h3><p>${safe(description)}</p>${action}</div>`;
}
function score(value) {
  return value==null?'<span class="muted">No evidence</span>':`<span class="signal ${toneOf(value)}">${num(value)}</span>`;
}
function metrics() {
  const total=data.totals;
  return `<div class="stats">${[
    ['SENTIMENT',total.score,'/ 100',total.records?'Average text sentiment':'Awaiting evidence'],
    ['EVIDENCE',total.records,'',`${num(total.news)} news · ${num(total.social)} social`],
    ['TICKERS',total.tickers,'','With stored evidence'],
    ['DISAGREEMENT',total.risk,'/ 100',total.records?'Sentiment standard deviation':'Awaiting evidence'],
    ['FOLLOWING',data.watchlist.length,'','In your watchlist']
  ].map(([label,value,suffix,note])=>`<div class="stat"><span class="stat-label">${label}</span><div class="stat-value">${num(value)}<small>${suffix}</small></div><div class="stat-note">${note}</div></div>`).join('')}</div>`;
}
function filteredTickers(watched=false) {
  return (watched?data.watchlist:data.signals).filter(ticker=>(!sector||ticker.sector===sector)&&(`${ticker.ticker} ${ticker.name}`.toLowerCase().includes(query.toLowerCase())));
}
function table(watched=false, limit=0, unfollowed=false) {
  let rows=filteredTickers(watched);if(unfollowed)rows=rows.filter(row=>!row.followed); if(limit) rows=rows.slice(0,limit);
  return `<div class="table-scroll"><table><thead><tr><th>TICKER / COMPANY</th><th>SENTIMENT</th><th>DISAGREEMENT</th><th>RECORDS</th><th>SECTOR</th><th>ACTIONS</th></tr></thead><tbody>${rows.map(ticker=>`<tr><td><button class="ticker-button" data-action="ticker" data-ticker="${safe(ticker.ticker)}">${safe(ticker.ticker)}</button><span class="company-name">${safe(ticker.name!==ticker.ticker?ticker.name:'—')}</span></td><td>${score(ticker.score)}</td><td class="number">${num(ticker.risk)}</td><td class="number">${num(ticker.mentions)}</td><td>${safe(ticker.sector)}</td><td><div class="row-actions"><button class="icon-button ${ticker.followed?'followed':''}" data-action="${ticker.followed?'unfollow':'follow'}" data-ticker="${safe(ticker.ticker)}" aria-label="${ticker.followed?'Unfollow':'Follow'} ${safe(ticker.ticker)}" title="${ticker.followed?'Unfollow':'Follow'} ${safe(ticker.ticker)}">${ticker.followed?'★':'☆'}</button>${ticker.followed?`<button class="icon-button" data-action="edit-ticker" data-ticker="${safe(ticker.ticker)}" aria-label="Edit ${safe(ticker.ticker)}" title="Edit ticker">⋯</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>${rows.length?'':empty(watched?'No matching tickers':'No measured signals yet',watched?'Add a ticker, or adjust your filters. Scores appear when you import related evidence.':'Import evidence to calculate sentiment and disagreement by ticker.',`<button class="button" data-action="${watched?'add-ticker':'import'}">${watched?'Add ticker':'Import evidence'}</button>`)}<div class="panel-foot"><span>${rows.length} ${watched?'followed':'measured'} tickers${limit?' shown':''}</span><span>Scores use this workspace’s evidence</span></div>`;
}
function chart() {
  let rows=data.history;
  if(period!=='ALL' && rows.length) {
    const end=new Date(`${rows.at(-1).day}T00:00:00Z`), cutoff=new Date(end);
    cutoff.setUTCDate(end.getUTCDate()-Number(period)+1);
    rows=rows.filter(row=>new Date(`${row.day}T00:00:00Z`)>=cutoff);
  }
  if(!rows.length) return `<div class="chart-empty">${empty('No timeline yet','Import dated evidence to see sentiment over time.')}</div>`;
  const width=640, height=166, start=Date.parse(rows[0].day), span=Date.parse(rows.at(-1).day)-start;
  const x=(row,index)=>span?(Date.parse(row.day)-start)/span*width:width/2;
  const y=value=>height-value/100*height;
  const points=rows.map((row,index)=>`${x(row,index)},${y(row.score)}`).join(' ');
  const labels=rows.length<=4?rows:rows.filter((_,index)=>[0,Math.floor(rows.length/3),Math.floor(2*rows.length/3),rows.length-1].includes(index));
  return `<div class="chart-area"><svg viewBox="0 0 700 216" role="img" aria-label="Mean sentiment by evidence date; ${rows.length} measured dates"><g transform="translate(35 10)">${[0,25,50,75,100].map(value=>`<line x1="0" x2="640" y1="${y(value)}" y2="${y(value)}" stroke="${value===50?'#ccd7e8':'#eaf0f7'}" ${value===50?'stroke-dasharray="3 4"':''}/><text x="-10" y="${y(value)+3}" text-anchor="end">${value}</text>`).join('')}<polyline points="${points}" fill="none" stroke="#3d6ccd" stroke-width="2"/>${rows.map((row,index)=>`<circle cx="${x(row,index)}" cy="${y(row.score)}" r="${rows.length<20?3:1.5}" fill="#4773cf"><title>${safe(row.day)}: ${row.score}/100 · ${row.count} records</title></circle>`).join('')}${labels.map(row=>`<text x="${x(row)}" y="191" text-anchor="${x(row)===0?'start':x(row)===640?'end':'middle'}">${safe(row.day.slice(5))}</text>`).join('')}</g></svg></div>`;
}
function evidenceItem(row) {
  const label=toneOf(50+50*row.sentiment);
  return `<button class="evidence-row" data-action="evidence" data-id="${safe(row.id)}"><div class="evidence-meta"><span class="ticker-tag">${safe(row.ticker)}</span><span>${safe(row.source)}</span><span>· ${date(row.published_at)}</span></div><h3>${safe(row.text.length>180?row.text.slice(0,180)+'…':row.text)}</h3><div class="evidence-end"><span class="tone ${label}">${label[0].toUpperCase()+label.slice(1)} · ${Math.round(row.sentiment*100)}</span><span>${safe(row.kind)} <span aria-hidden="true">↗</span></span></div></button>`;
}
function emptyWorkspace() {
  return `<section class="panel empty-workspace"><div class="empty-main"><span class="empty-label">WORKSPACE READY / NO DATA</span><h2>Start with your evidence.</h2><p>Import headlines, research notes or social posts. Signal will calculate sentiment, group your tickers and keep the original sources available for review.</p><div class="empty-actions"><button class="button primary" data-page="pipeline">Import a dataset ↗</button><button class="button" data-action="add-ticker">Build a watchlist</button></div></div><div class="empty-steps"><div class="step"><span>01</span><div><h3>Choose a source</h3><p>Upload CSV, paste your records, or configure NewsAPI.</p></div></div><div class="step"><span>02</span><div><h3>Inspect the evidence</h3><p>Every score links back to the text that produced it.</p></div></div><div class="step"><span>03</span><div><h3>Follow what matters</h3><p>Track your own tickers. Keep separate research in separate workspaces.</p></div></div></div></section>`;
}
function overview() {
  const sources={}; for(const row of data.evidence) sources[row.source]=(sources[row.source]||0)+1;
  const sourceRows=Object.entries(sources).sort((a,b)=>b[1]-a[1]).slice(0,5);
  return `${data.totals.records?metrics():emptyWorkspace()}<div class="dashboard-grid"><section class="panel"><div class="panel-head"><div><h2>Sentiment timeline</h2><p>Mean score by evidence date</p></div><div class="periods">${[['7','7D'],['30','30D'],['ALL','ALL']].map(([value,label])=>`<button data-action="period" data-period="${value}" aria-pressed="${period===value}" class="${period===value?'selected':''}">${label}</button>`).join('')}</div></div>${chart()}<div class="panel-foot"><span>0 negative · 50 neutral · 100 positive</span><span>${data.history.length} measured dates</span></div></section><section class="panel"><div class="panel-head"><div><h2>Source coverage</h2><p>Most recent ${data.evidence.length} records</p></div><button class="text-button" data-page="news">Inspect ↗</button></div>${sourceRows.length?`<div class="source-list">${sourceRows.map(([name,count])=>`<div class="source-row"><div><span>${safe(name)}</span><b>${count}</b></div><div class="bar-track"><i style="width:${count/data.evidence.length*100}%"></i></div></div>`).join('')}</div>`:empty('No sources connected','Your source names will appear here after an import.', '<button class="button" data-page="pipeline">Add a source</button>')}<div class="panel-foot"><span>${status.engine?.toUpperCase()||'VADER'} text analysis</span><span>Local storage</span></div></section></div><div class="dashboard-lower"><section class="panel"><div class="panel-head"><div><h2>Ticker signals</h2><p>Measured from your stored evidence</p></div><button class="text-button" data-page="watchlist">Watchlist ↗</button></div>${table(false,6)}</section><section class="panel"><div class="panel-head"><div><h2>Latest evidence</h2><p>Original text, with sentiment attached</p></div><button class="text-button" data-page="news">View feed ↗</button></div>${data.evidence.length?data.evidence.slice(0,4).map(evidenceItem).join(''):empty('Your feed is empty','Imported headlines and research notes will appear here.')}</section></div>`;
}
function watchlist() {
  const sectors=[...new Set(data.watchlist.map(row=>row.sector))].sort();
  return `<section class="panel"><div class="panel-head"><div><h2>Following ${data.watchlist.length} tickers</h2><p>${sector?safe(sector)+' collection':'Manage your research universe'}</p></div><button class="button primary" data-action="add-ticker">+ Add ticker</button></div><div class="table-tools"><input id="tickerSearch" class="search" data-filter="query" value="${safe(query)}" placeholder="Search ticker or company" aria-label="Search watchlist"><select id="sectorFilter" data-filter="sector" aria-label="Filter sector"><option value="">All sectors</option>${sectors.map(item=>`<option value="${safe(item)}" ${sector===item?'selected':''}>${safe(item)}</option>`).join('')}</select>${sector?'<button class="text-button" data-action="clear-filters">Clear filter</button>':''}<span class="result-count">${filteredTickers(true).length} results</span></div>${table(true)}</section>${data.signals.some(row=>!row.followed)?`<section class="panel" style="margin-top:20px"><div class="panel-head"><div><h2>Available in your evidence</h2><p>Follow a ticker using the star control</p></div><span class="overline">${data.signals.filter(row=>!row.followed).length} UNFOLLOWED</span></div>${table(false,0,true)}</section>`:''}`;
}
function filteredEvidence() {
  return data.evidence.filter(row=>(!query||`${row.ticker} ${row.text} ${row.source}`.toLowerCase().includes(query.toLowerCase()))&&(!tone||toneOf(50+50*row.sentiment)===tone)&&(!kind||row.kind===kind));
}
function news() {
  const rows=filteredEvidence();
  return `<div class="evidence-page"><section class="panel"><div class="table-tools"><input id="newsSearch" class="search" data-filter="query" value="${safe(query)}" placeholder="Search text, source or ticker" aria-label="Search evidence"><select id="toneFilter" data-filter="tone" aria-label="Filter sentiment"><option value="">All sentiment</option>${['positive','neutral','negative'].map(value=>`<option value="${value}" ${tone===value?'selected':''}>${value[0].toUpperCase()+value.slice(1)}</option>`).join('')}</select><select id="kindFilter" data-filter="kind" aria-label="Filter source kind"><option value="">All types</option><option ${kind==='news'?'selected':''} value="news">News</option><option ${kind==='social'?'selected':''} value="social">Social</option></select></div>${rows.length?rows.map(evidenceItem).join(''):empty(data.totals.records?'No matches in loaded evidence':'No evidence yet',data.totals.records?'Adjust your filters or load more records.':'Import a CSV or connect a provider to populate your feed.',data.totals.records?'<button class="button" data-action="clear-filters">Clear filters</button>':'<button class="button primary" data-page="pipeline">Import evidence</button>')}${data.evidence.length<data.totals.records?'<button class="load-more" data-action="load-more">Load next 100 records ↓</button>':''}<div class="panel-foot"><span>${rows.length} matching / ${data.evidence.length} loaded</span><span>${num(data.totals.records)} total records</span></div></section><aside class="panel evidence-sidebar"><div class="eyebrow">EVIDENCE INDEX</div><h3>${safe(data.workspace.name)}</h3><div class="summary-pair"><span>News records</span><b>${num(data.totals.news)}</b></div><div class="summary-pair"><span>Social records</span><b>${num(data.totals.social)}</b></div><div class="summary-pair"><span>Tickers measured</span><b>${num(data.totals.tickers)}</b></div><p style="margin-top:20px">Scores describe text sentiment. They do not validate a source’s claims or predict investment returns.</p><button class="text-button" data-action="method" style="margin-top:15px">Read methodology ↗</button></aside></div>`;
}
function pipeline() {
  return `<div class="source-grid"><section class="panel"><div class="panel-head"><div><h2>Import CSV</h2><p>Bring your own headlines, notes and social posts</p></div><span class="status-tag ready">AVAILABLE</span></div><div class="source-body"><p>Required columns: <b>ticker,text</b>. Optional: <b>source,kind,published_at</b>. Each valid row becomes traceable evidence in this workspace.</p><button class="text-button" data-action="template">Download an empty CSV template ↓</button><form data-form="import" id="importForm"><div class="upload-zone" id="uploadZone"><input id="csvFile" type="file" accept=".csv,text/csv" aria-label="Choose evidence CSV"><p>Drop a CSV here · Up to 2 MB · 20,000 records per import</p></div><label>Or paste CSV<textarea id="csvText" name="csv" rows="6" required placeholder="ticker,text,source,kind,published_at" spellcheck="false"></textarea></label><label class="checkbox"><input type="checkbox" name="follow" checked>Add imported tickers to this workspace’s watchlist</label><div class="form-actions"><button class="button primary" type="submit">Import & analyze</button><span class="form-status">${num(data.totals.records)} records currently stored</span></div><div class="form-error" role="alert"></div></form></div><div class="source-note">Duplicates are skipped within this workspace. If any row is invalid, nothing is imported. Dates use publication time when provided; otherwise import time.</div></section><section class="panel"><div class="panel-head"><div><h2>NewsAPI</h2><p>Fetch published news for a ticker</p></div><span class="status-tag ${status.news_configured?'ready':''}">${status.news_configured?'CONNECTED':'NOT CONNECTED'}</span></div><div class="source-body"><p>${status.news_configured?'Fetch up to 100 available articles per request. Provider coverage and access depend on your NewsAPI plan.':'Connect a NewsAPI key to retrieve real news. No feed is loaded until you connect and explicitly fetch a ticker.'}</p><div class="connection"><b>Provider credentials</b><span>${status.news_configured?'Configured on this server':'Not configured'}</span></div>${status.news_configured?`<form data-form="live-news"><div class="field-row"><label>Ticker<input name="ticker" required maxlength="10" pattern="[A-Za-z0-9.\\-]+" placeholder="Ticker symbol" autocapitalize="characters"></label><button class="button primary" type="submit">Fetch headlines</button></div><label class="checkbox"><input name="follow" type="checkbox" checked>Follow this ticker</label><div class="form-error" role="alert"></div></form>`:'<button class="button" data-action="settings">Connection settings ↗</button>'}<div class="divider"></div><h3>Local evidence store</h3><p>${num(data.totals.records)} records across ${num(data.totals.tickers)} tickers. Your other workspaces have separate evidence and watchlists.</p><div class="form-actions"><button class="button" data-action="export-all" ${data.totals.records?'':'disabled'}>Export all evidence</button><button class="text-button" data-page="news">Inspect evidence ↗</button></div></div><div class="source-note">Current NLP engine: ${safe(status.engine?.toUpperCase())}. Provider keys remain on the server. Profile and workspace organization are local; no sign-in is required.</div></section></div>`;
}
function simulation() {
  return `<div class="simulation-warning"><b>Hypothetical simulation — opt in to run.</b> This lab generates reproducible prices and signals. It uses no historical prices and does not measure the predictive quality of your imported evidence.</div><section class="panel"><div class="panel-head"><div><h2>Long / cash strategy</h2><p>Prior-day signal · Transaction fees on position changes</p></div><span class="status-tag">SIMULATED DATA</span></div><form class="sim-controls" data-form="simulate"><label>Entry threshold<input name="threshold" type="number" min="0" max="100" value="60" required></label><label>Fees, basis points<input name="cost" type="number" min="0" max="100" value="10" required></label><label>Simulation window<select name="days"><option value="90">90 days</option><option value="180">180 days</option><option value="365">365 days</option></select></label><button class="button primary" type="submit">Run hypothetical simulation ↗</button><div class="form-error" role="alert"></div></form><div class="simulation-results" id="simulationResults">${simulationResult?simulationChart(simulationResult):empty('No simulation has been run','Choose your assumptions, then explicitly run the simulation.')}</div></section>`;
}
function simulationChart(result) {
  const series=result.series, values=series.flatMap(row=>[row.equity,row.benchmark]);
  const min=Math.floor(Math.min(...values)/10)*10-5, max=Math.ceil(Math.max(...values)/10)*10+5;
  const points=key=>series.map((row,index)=>`${index/(series.length-1)*640},${180-(row[key]-min)/(max-min)*180}`).join(' ');
  return `<div class="stats">${[['Strategy return',result.total_return+'%'],['Benchmark return',result.benchmark_return+'%'],['Max drawdown',result.max_drawdown+'%'],['Position changes',result.trades]].map(([label,value])=>`<div class="stat"><span class="stat-label">${label}</span><div class="stat-value">${value}</div></div>`).join('')}</div><div class="chart-area"><svg viewBox="0 0 700 228" role="img" aria-label="Hypothetical strategy and benchmark equity"><g transform="translate(35 10)">${[0,.25,.5,.75,1].map(f=>`<line x1="0" x2="640" y1="${180-f*180}" y2="${180-f*180}" stroke="#e8eef6"/><text x="-8" y="${183-f*180}" text-anchor="end">${Math.round(min+f*(max-min))}</text>`).join('')}<polyline points="${points('benchmark')}" fill="none" stroke="#a8b6cb" stroke-width="1.7"/><polyline points="${points('equity')}" fill="none" stroke="#426dd3" stroke-width="2"/><text x="0" y="205">DAY 1</text><text x="640" y="205" text-anchor="end">DAY ${series.length}</text></g></svg></div><div class="chart-legend"><span><i></i>Hypothetical strategy</span><span class="benchmark"><i></i>Buy & hold benchmark</span></div><div class="source-note">Initial equity: 100. Seed: 42. Signal and price returns are independent. No leverage, short selling, or forced final liquidation. Fees are deducted on every change in exposure.</div>`;
}
function render() {
  $('#pageTitle').textContent=pages[current][0]; $('#pageSubtitle').textContent=pages[current][1];
  $('#pageEyebrow').textContent=`RESEARCH / ${pageNames[current].toUpperCase()}`;
  $('#pageSelector').innerHTML=`${pageNames[current]} <span>⌄</span>`;
  document.querySelectorAll('nav [data-page]').forEach(button=>{button.classList.toggle('active',button.dataset.page===current);button.setAttribute('aria-current',button.dataset.page===current?'page':'false');});
  $('#exportBtn').textContent=current==='news'?'Export displayed':current==='backtest'?'Export simulation':'Export CSV';
  $('#exportBtn').disabled=current==='backtest'?!simulationResult:current==='watchlist'?!data.watchlist.length:!data.totals.records;
  page.innerHTML=({overview,watchlist,news,pipeline,backtest:simulation})[current]();
  bindUpload();
}

function modal(html) {
  if($('#modal').hidden) lastFocus=document.activeElement;
  $('#modalContent').innerHTML=html; $('#modal').hidden=false;
  document.body.classList.add('modal-open');
  for(const selector of ['#appHeader','#sidebar','#mainContent']) $(selector).inert=true;
  $('#modalContent h2')?.setAttribute('id','dialogTitle');
  $('#modalContent input:not([type=checkbox]), #modalContent select, #modal .close')?.focus();
}
function closeModal() {
  if($('#modal').hidden) return;
  $('#modal').hidden=true; document.body.classList.remove('modal-open');
  for(const selector of ['#appHeader','#sidebar','#mainContent']) $(selector).inert=false;
  if(lastFocus?.isConnected) lastFocus.focus();
}
function profileModal() {
  modal(`<div class="eyebrow">LOCAL IDENTITY</div><h2>Your researcher profile</h2><p class="description">Personalize the name and role shown in this app. This is a local profile, shared across your workspaces on this computer.</p><div class="profile-preview"><span class="avatar">${safe(initials(profile.name))}</span><div><b>${safe(profile.name)}</b><small>${safe(profile.role)}</small></div></div><form data-form="profile"><label>Display name<input name="name" value="${safe(profile.name)}" maxlength="60" required autocomplete="name"></label><label>Role or organization<input name="role" value="${safe(profile.role)}" maxlength="80" placeholder="Independent research" autocomplete="organization-title"></label><div class="form-actions"><button class="button primary" type="submit">Save profile</button><button class="button" type="button" data-action="close">Cancel</button></div><div class="form-error" role="alert"></div></form>`);
}
async function workspaceModal() {
  workspaces=await api('/api/workspaces');
  modal(`<div class="eyebrow">WORKSPACE MANAGEMENT</div><h2>Your workspaces</h2><p class="description">Each workspace has its own evidence and watchlist. Switching does not move or delete records.</p>${workspaces.filter(item=>!item.archived).map(item=>`<button class="workspace-row ${item.id===workspace?'active':''}" data-action="switch-workspace" data-id="${safe(item.id)}"><span class="workspace-icon">${safe(item.name[0].toUpperCase())}</span><span><b>${safe(item.name)}</b><small>${num(item.records)} records</small></span><span>${item.id===workspace?'Current':'Open →'}</span></button>`).join('')}<div class="section-title">CREATE WORKSPACE</div><form class="compact-form" data-form="create-workspace"><label>Name<input name="name" required maxlength="60" placeholder="e.g. European equities"></label><button class="button primary" type="submit">Create</button><div class="form-error" role="alert"></div></form><div class="workspace-edit"><h3>Current workspace</h3><form class="compact-form" data-form="rename-workspace"><label>Name<input name="name" value="${safe(data.workspace.name)}" required maxlength="60"></label><button class="button" type="submit">Rename</button><div class="form-error" role="alert"></div></form><p>Archiving removes a workspace from the switcher and preserves its data. Archived workspaces can be restored below.</p><button class="text-button" data-action="archive-workspace" style="color:#b1444b;margin-top:8px">Archive this workspace</button></div>${workspaces.some(item=>item.archived)?`<div class="section-title">ARCHIVED WORKSPACES</div>${workspaces.filter(item=>item.archived).map(item=>`<button class="workspace-row archived" data-action="restore-workspace" data-id="${safe(item.id)}"><span><b>${safe(item.name)}</b><small>${num(item.records)} records preserved</small></span><span>Restore ↗</span></button>`).join('')}`:''}`);
}
async function switchWorkspace(id) {
  rememberWorkspace(id); query=''; sector=''; tone=''; kind=''; simulationResult=null;
  closeModal(); await loadData(); toast(`Opened ${data.workspace.name}.`);
}
function addTicker(symbol='') {
  const ticker=data.watchlist.find(item=>item.ticker===symbol);
  modal(`<div class="eyebrow">WATCHLIST</div><h2>${ticker?'Edit ticker':'Follow a ticker'}</h2><p class="description">A ticker can be followed before it has evidence. Scores stay empty until related text is imported.</p><form data-form="watchlist"><label>Ticker symbol<input name="ticker" required maxlength="10" pattern="[A-Za-z0-9.\\-]+" value="${safe(symbol)}" ${ticker?'readonly':''} placeholder="Ticker" autocapitalize="characters"></label><label>Company name<input name="name" maxlength="80" value="${safe(ticker?.name===symbol?'':ticker?.name||'')}" placeholder="Optional display name"></label><label>Sector / collection<input name="sector" maxlength="50" value="${safe(ticker?.sector==='Unclassified'?'':ticker?.sector||'')}" placeholder="e.g. Technology"></label><div class="form-actions"><button class="button primary" type="submit">${ticker?'Save changes':'Follow ticker'}</button><button class="button" type="button" data-action="close">Cancel</button></div><div class="form-error" role="alert"></div></form>`);
}
async function tickerModal(symbol) {
  const ws=workspace, ticker=data.signals.find(row=>row.ticker===symbol)||data.watchlist.find(row=>row.ticker===symbol);
  if(!ticker) return;
  const rows=await api(scoped(`/api/evidence?ticker=${encodeURIComponent(symbol)}&limit=50`,ws));
  if(ws!==workspace) return;
  rememberEvidence(rows);
  modal(`<div class="eyebrow">TICKER / ${safe(ticker.sector)}</div><h2>${safe(symbol)}${ticker.name!==symbol?' · '+safe(ticker.name):''}</h2><p class="description">Measured from ${num(ticker.mentions)} records in ${safe(data.workspace.name)}.</p><div class="detail-stats"><div><span>Sentiment / 100</span><b>${num(ticker.score)}</b></div><div><span>Disagreement / 100</span><b>${num(ticker.risk)}</b></div><div><span>Evidence records</span><b>${num(ticker.mentions)}</b></div></div><button class="button" data-action="${ticker.followed?'edit-ticker':'follow'}" data-ticker="${safe(symbol)}">${ticker.followed?'Edit watchlist details':'Follow ticker'}</button><div class="section-title">RECENT EVIDENCE</div>${rows.length?rows.map(evidenceItem).join(''):empty('No evidence for this ticker','Import records with this symbol to calculate its signal.')}<p class="helper" style="margin-top:20px">Disagreement measures dispersion in text sentiment, not the probability of financial loss.</p>`);
}
function evidenceModal(id) {
  const row=evidenceCache.get(id); if(!row) return;
  modal(`<div class="eyebrow">${safe(row.kind.toUpperCase())} / ${safe(row.ticker)}</div><h2>Source evidence</h2><p class="description">${safe(row.source)} · ${date(row.published_at)}</p><div class="detail-stats"><div><span>Text sentiment</span><b>${Math.round(row.sentiment*100)}</b></div><div><span>Scale</span><b>−100/+100</b></div><div><span>Source type</span><b style="font-size:15px">${safe(row.kind)}</b></div></div><div class="detail-copy">${safe(row.text)}</div><div class="divider"></div><p class="helper">Imported ${date(row.created)}. Text is preserved as provided; a sentiment score is not a fact check. Publication date defaults to import time when a source supplies no date.</p><div class="form-actions"><button class="button" data-action="copy-evidence" data-id="${safe(row.id)}">Copy text</button><button class="button" data-action="ticker" data-ticker="${safe(row.ticker)}">Open ticker ↗</button></div>`);
}
function settingsModal() {
  modal(`<div class="eyebrow">LOCAL ENGINE</div><h2>Connections & settings</h2><p class="description">Data and profile changes persist on this computer. Workspaces organize research; they are not separate authenticated accounts.</p><div class="settings-row"><div><b>Sentiment engine</b><small>Active model used for new imports</small></div><span class="status-tag ready">${safe(status.engine?.toUpperCase())}</span></div><div class="settings-row"><div><b>NewsAPI</b><small>Real news ingestion</small></div><span class="status-tag ${status.news_configured?'ready':''}">${status.news_configured?'CONFIGURED':'NOT CONFIGURED'}</span></div><div class="settings-row"><div><b>Evidence storage</b><small>Persistent local DuckDB database</small></div><span class="status-tag ready">LOCAL</span></div><div class="section-title">CONNECT A NEWS PROVIDER</div><p class="helper">Set your key in the project’s local .env file, then restart the server. Keys are never entered into the browser or shown here.</p><pre class="code-block">NEWS_API_KEY=your_provider_key\nSENTIMENT_ENGINE=vader</pre><p class="helper">Optional FinBERT requires separately installed transformers/torch packages and model weights. NewsAPI account access, licensing and rate limits apply.</p><div class="form-actions"><button class="button primary" data-page="pipeline">Open data sources</button><button class="button" data-action="profile">Edit profile</button><button class="button" data-action="workspaces">Manage workspaces</button></div>`);
}
function methodModal() {
  modal(`<div class="eyebrow">METHODOLOGY</div><h2>How scores are calculated</h2><p class="description">All overview and ticker measurements use non-synthetic evidence stored in the selected workspace.</p><table class="method-table"><tbody><tr><td>Sentiment</td><td>50 + 50 × average text sentiment, on a 0–100 scale. 50 is neutral.</td></tr><tr><td>Disagreement</td><td>100 × population standard deviation of text sentiment, capped at 100. This is not a loss probability.</td></tr><tr><td>Timeline</td><td>Average sentiment grouped by publication date, falling back to import time when no date is provided. No missing dates are filled with invented measurements.</td></tr><tr><td>Deduplication</td><td>The same ticker and text are counted once within a workspace. Different workspaces maintain separate records.</td></tr><tr><td>Confidence</td><td>These scores measure language tone, not source reliability, business fundamentals or expected returns.</td></tr></tbody></table><div class="divider"></div><p class="helper">The Simulation lab is separate. It generates hypothetical prices only when you run it explicitly; its results do not populate your research workspace.</p>`);
}
async function activityModal() {
  const ws=workspace, rows=await api(scoped('/api/activity'));
  if(ws!==workspace) return;
  modal(`<div class="eyebrow">${safe(data.workspace.name.toUpperCase())}</div><h2>Workspace activity</h2><p class="description">Completed imports and source fetches in this workspace.</p>${rows.length?rows.map(row=>`<div class="activity-item"><p>${safe(row.message)}</p><small>${date(row.created)}</small></div>`).join(''):'<div class="notification-empty">No activity yet. Import evidence to start your research history.</div>'}`);
}
function pagesModal() {
  modal(`<div class="eyebrow">NAVIGATION</div><h2>Open a page</h2><div class="page-menu">${Object.entries(pageNames).map(([id,name])=>`<button data-page="${id}">${name}<span>${id===current?'CURRENT':'→'}</span></button>`).join('')}</div>`);
}
function searchModal() {
  modal('<div class="eyebrow">QUICK NAVIGATION</div><h2>Search workspace</h2><input id="commandSearch" class="full-width" placeholder="Find a page or ticker…" aria-label="Search pages and tickers" autocomplete="off"><div id="commandResults" class="search-results"></div>');
  commandResults(''); $('#commandSearch').focus();
}
function commandResults(value) {
  const term=value.toLowerCase(), tickers=[...new Map([...data.watchlist,...data.signals].map(row=>[row.ticker,row])).values()];
  const html=Object.entries(pageNames).filter(([,name])=>name.toLowerCase().includes(term)).map(([id,name])=>`<button data-page="${id}"><b>${name}</b><small>PAGE →</small></button>`).join('')+tickers.filter(row=>`${row.ticker} ${row.name}`.toLowerCase().includes(term)).slice(0,20).map(row=>`<button data-action="ticker" data-ticker="${safe(row.ticker)}"><b>${safe(row.ticker)}</b><span>${safe(row.name)}</span><small>TICKER →</small></button>`).join('');
  $('#commandResults').innerHTML=html||'<div class="empty"><p>No matching pages or tickers.</p></div>';
}
function bindUpload() {
  const input=$('#csvFile'), zone=$('#uploadZone'); if(!input||!zone) return;
  input.onchange=()=>readFile(input.files[0]);
  zone.ondragover=event=>{event.preventDefault();zone.classList.add('dragging');};
  zone.ondragleave=()=>zone.classList.remove('dragging');
  zone.ondrop=event=>{event.preventDefault();zone.classList.remove('dragging');readFile(event.dataTransfer.files[0]);};
}
async function readFile(file) {
  if(!file) return;
  if(file.size>2000000) {toast('Choose a CSV smaller than 2 MB.');return;}
  if(!file.name.toLowerCase().endsWith('.csv')) {toast('Choose a .csv file.');return;}
  try { const text=await file.text(); if($('#csvText')) $('#csvText').value=text; toast(`${file.name} loaded. Review and import when ready.`); }
  catch { toast('The file could not be read.'); }
}
function csvCell(value) { let text=String(value??''); if(typeof value==='string'&&/^[=+@\-\t\r]/.test(text)) text="'"+text; return '"'+text.replaceAll('"','""')+'"'; }
function download(rows,filename) {
  const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function exportRows(all=false) {
  if(!data) return;
  let rows,filename='signal-'+current+'.csv';
  if(current==='backtest') {
    if(!simulationResult) {toast('Run a simulation before exporting.');return;}
    rows=[['day','hypothetical_equity','hypothetical_benchmark','signal','position'],...simulationResult.series.map(row=>[row.day,row.equity,row.benchmark,row.signal,row.position])];
  } else if(all || current==='news' || current==='pipeline') {
    let source=all?[]:filteredEvidence();
    if(all) {
      const ws=workspace,total=data.totals.records;
      for(let offset=0;offset<total;offset+=500) source.push(...await api(scoped(`/api/evidence?limit=500&offset=${offset}`,ws)));
    }
    rows=[['ticker','text','source','kind','sentiment','published_at','imported_at'],...source.map(row=>[row.ticker,row.text,row.source,row.kind,row.sentiment,row.published_at,row.created])];
    filename='signal-evidence.csv';
  } else {
    rows=[['ticker','company','sector','sentiment','disagreement','records','followed'],...filteredTickers(current==='watchlist').map(row=>[row.ticker,row.name,row.sector,row.score,row.risk,row.mentions,row.followed])];
  }
  if(rows.length===1) {toast('No matching records to export.');return;}
  download(rows,filename);toast(`Exported ${num(rows.length-1)} rows.`);
}

const actions = {
  close:closeModal, profile:profileModal, workspaces:workspaceModal, settings:settingsModal,
  method:methodModal, activity:activityModal, pages:pagesModal, search:searchModal,
  refresh, export:()=>exportRows(), 'export-all':()=>exportRows(true),
  import:()=>go('pipeline'), 'add-ticker':()=>addTicker(), 'edit-ticker':button=>addTicker(button.dataset.ticker),
  ticker:button=>tickerModal(button.dataset.ticker), evidence:button=>evidenceModal(button.dataset.id),
  period:button=>{period=button.dataset.period;render();},
  collection:button=>go('watchlist',button.dataset.sector),
  'clear-filters':()=>{query='';sector='';tone='';kind='';shell();render();},
  'switch-workspace':button=>switchWorkspace(button.dataset.id),
  'archive-workspace':()=>modal(`<div class="eyebrow">ARCHIVE WORKSPACE</div><h2>Archive ${safe(data.workspace.name)}?</h2><p class="description">All ${num(data.totals.records)} records and your watchlist will be preserved. You can restore this workspace from the workspace manager.</p><div class="form-actions"><button class="button danger" data-action="confirm-archive">Archive workspace</button><button class="button" data-action="workspaces">Cancel</button></div>`),
  'confirm-archive':async()=>{await api(`/api/workspaces/${encodeURIComponent(workspace)}`,{method:'DELETE'});workspaces=await api('/api/workspaces');await switchWorkspace(workspaces.find(item=>!item.archived).id);toast('Workspace archived. Its data is preserved.');},
  'restore-workspace':async button=>{const item=workspaces.find(row=>row.id===button.dataset.id);await api(`/api/workspaces/${encodeURIComponent(item.id)}`,{...json({name:item.name,archived:false}),method:'PATCH'});await workspaceModal();toast('Workspace restored.');},
  follow:async button=>{const ws=workspace;await api(scoped('/api/watchlist',ws),json({ticker:button.dataset.ticker}));if(ws===workspace){await loadData();closeModal();}toast('Ticker added to your watchlist.');},
  unfollow:async button=>{const ws=workspace;await api(scoped(`/api/watchlist/${encodeURIComponent(button.dataset.ticker)}`,ws),{method:'DELETE'});if(ws===workspace)await loadData();toast('Ticker removed from watchlist. Its evidence is preserved.');},
  template:()=>{download([['ticker','text','source','kind','published_at']],'signal-import-template.csv');toast('Empty CSV template downloaded.');},
  'load-more':async button=>{const ws=workspace;const rows=await api(scoped(`/api/evidence?offset=${data.evidence.length}&limit=100`,ws));if(ws!==workspace)return;data.evidence.push(...rows);rememberEvidence(rows);render();},
  'copy-evidence':async button=>{const row=evidenceCache.get(button.dataset.id);if(row){await navigator.clipboard.writeText(row.text);toast('Evidence text copied.');}}
};
async function submitForm(form) {
  const type=form.dataset.form, fields=new FormData(form), button=form.querySelector('button[type=submit]');
  const ws=workspace; if(button?.disabled) return; if(button)button.disabled=true;
  const errorBox=form.querySelector('.form-error'); if(errorBox)errorBox.innerHTML='';
  try {
    if(type==='profile') {
      profile=await api('/api/profile',{...json({name:fields.get('name').trim(),role:fields.get('role').trim()}),method:'PATCH'});shell();closeModal();toast('Profile saved.');
    } else if(type==='create-workspace') {
      const item=await api('/api/workspaces',json({name:fields.get('name').trim()}));await switchWorkspace(item.id);
    } else if(type==='rename-workspace') {
      await api(`/api/workspaces/${encodeURIComponent(ws)}`,{...json({name:fields.get('name').trim(),archived:false}),method:'PATCH'});await loadData();await workspaceModal();toast('Workspace renamed.');
    } else if(type==='watchlist') {
      await api(scoped('/api/watchlist',ws),json({ticker:fields.get('ticker').trim().toUpperCase(),name:fields.get('name').trim(),sector:fields.get('sector').trim()||'Unclassified'}));if(ws===workspace){await loadData();closeModal();}toast('Watchlist saved.');
    } else if(type==='import') {
      const result=await api(scoped('/api/ingest',ws),json({csv:fields.get('csv'),follow:fields.has('follow')}));if(ws===workspace)await loadData();toast(`${num(result.inserted)} records imported; ${num(result.duplicates)} duplicates skipped.`);
    } else if(type==='live-news') {
      const result=await api(scoped('/api/live-news',ws),json({ticker:fields.get('ticker').trim().toUpperCase(),follow:fields.has('follow')}));if(ws===workspace)await loadData();toast(`${num(result.inserted)} new articles imported from ${num(result.processed)} results.`);
    } else if(type==='simulate') {
      const result=await api(`/api/backtest?threshold=${encodeURIComponent(fields.get('threshold'))}&cost_bps=${encodeURIComponent(fields.get('cost'))}&days=${encodeURIComponent(fields.get('days'))}`);
      if(ws===workspace){simulationResult=result;if(current==='backtest'){$('#simulationResults').innerHTML=simulationChart(result);$('#exportBtn').disabled=false;}toast('Hypothetical simulation complete.');}
    }
  } catch(error) {
    if(errorBox?.isConnected)errorBox.innerHTML=`<p class="error">${safe(error.message)}</p>`;
    toast(error.message);
  } finally {if(button)button.disabled=false;}
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action],[data-page]');
  if(!button||button.disabled)return;
  if(button.dataset.page){event.preventDefault();go(button.dataset.page);return;}
  const action=actions[button.dataset.action];if(!action)return;
  event.preventDefault();
  try { const result=action(button); if(result?.then){button.disabled=true;await result;} }
  catch(error){toast(error.message);}
  finally{button.disabled=false;}
});
document.addEventListener('submit',event=>{const form=event.target.closest('form[data-form]');if(form){event.preventDefault();submitForm(form);}});
document.addEventListener('input',event=>{
  if(event.target.id==='commandSearch'){commandResults(event.target.value);return;}
  if(!event.target.dataset.filter || event.target.tagName==='SELECT')return;
  const input=event.target,id=input.id,position=input.selectionStart;
  query=input.value;render();const replacement=$('#'+id);replacement?.focus();replacement?.setSelectionRange(position,position);
});
document.addEventListener('change',event=>{
  const filter=event.target.dataset.filter;if(!filter)return;
  if(filter==='sector')sector=event.target.value;if(filter==='tone')tone=event.target.value;if(filter==='kind')kind=event.target.value;
  shell();render();
});
$('#modal').addEventListener('click',event=>{if(event.target===$('#modal'))closeModal();});
document.addEventListener('keydown',event=>{
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(data)searchModal();}
  if($('#modal').hidden)return;
  if(event.key==='Escape'){closeModal();return;}
  if(event.key==='Tab'){
    const nodes=[...$('#modal').querySelectorAll('button:not(:disabled),a[href],input:not([disabled]),select,textarea,[tabindex="0"]')].filter(node=>!node.hidden);
    const first=nodes[0],last=nodes.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
});
window.addEventListener('hashchange',()=>{const next=location.hash.slice(1);if(pages[next]&&next!==current)go(next);});
(async()=>{
  try {
    [profile,workspaces]=await Promise.all([api('/api/profile'),api('/api/workspaces')]);
    if(!workspaces.some(item=>item.id===workspace&&!item.archived))rememberWorkspace(workspaces.find(item=>!item.archived).id);
    await loadData();
  } catch(error) {
    page.setAttribute('aria-busy','false');page.innerHTML=`<section class="panel">${empty('The local engine is unavailable',error.message,'<button class="button primary" data-action="refresh">Try again</button>')}</section>`;
    $('#engineLabel').textContent='Engine offline';toast(error.message);
  }
})();
