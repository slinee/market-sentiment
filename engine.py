"""Text analysis, real evidence ingestion, and explicit simulation utilities."""
import hashlib, json, math, os, random, re, time
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from storage import LOCK
import duckdb
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

ROOT=Path(__file__).parent
TICKERS=[('NVDA','NVIDIA','Technology',84,34),('AAPL','Apple','Technology',68,23),('MSFT','Microsoft','Technology',76,21),('AMZN','Amazon','Consumer',71,32),('GOOGL','Alphabet','Technology',64,27),('META','Meta Platforms','Technology',73,38),('TSLA','Tesla','Consumer',39,72),('JPM','JPMorgan Chase','Financials',62,25),('V','Visa','Financials',67,19),('XOM','Exxon Mobil','Energy',43,51),('UNH','UnitedHealth','Healthcare',55,42),('LLY','Eli Lilly','Healthcare',79,31)]
LEXICON=SentimentIntensityAnalyzer()
WRITE_LOCK=LOCK

def retry(fn, attempts=3, delay=.05):
    """Three retries after the initial attempt, exponential backoff."""
    for i in range(attempts+1):
        try: return fn()
        except (TimeoutError, ConnectionError, OSError):
            if i==attempts: raise
            time.sleep(delay*2**i)

@lru_cache(maxsize=32768)
def sentiment(text, engine='vader'):
    if engine not in {'vader','finbert'}:
        raise ValueError('SENTIMENT_ENGINE must be vader or finbert')
    if engine=='finbert':
        values=model('sentiment-analysis','ProsusAI/finbert')(text[:2000],truncation=True)[0]
        return values['score']*({'positive':1,'negative':-1}.get(values['label'],0))
    return LEXICON.polarity_scores(text)['compound']

@lru_cache(maxsize=2)
def model(task, name):
    from transformers import pipeline
    return pipeline(task, model=name)

def entities(text, use_bert=False):
    if use_bert:
        return model('ner','dslim/bert-base-NER')(text, aggregation_strategy='simple')
    return [t[0] for t in TICKERS if re.search(r'\b'+re.escape(t[0])+r'\b',text,re.I) or re.search(r'\b'+re.escape(t[1])+r'\b',text,re.I)]

def openai_summary(text):
    """Optional server-only OpenAI evidence summary. No credentials are exposed."""
    import urllib.request
    key=os.getenv('OPENAI_API_KEY')
    if not key: raise ValueError('Set OPENAI_API_KEY to enable this adapter')
    body=json.dumps({'model':'gpt-4.1-mini','messages':[{'role':'user','content':'Summarize evidence and uncertainty, without investment recommendations: '+text[:12000]}]}).encode()
    request=urllib.request.Request('https://api.openai.com/v1/chat/completions',body,{'Authorization':'Bearer '+key,'Content-Type':'application/json'})
    return retry(lambda: json.loads(urllib.request.urlopen(request,timeout=30).read()))['choices'][0]['message']['content']

def news_api(query):
    import urllib.request, urllib.parse
    key=os.getenv('NEWS_API_KEY')
    if not key: raise ValueError('Set NEWS_API_KEY to enable live ingestion')
    url='https://newsapi.org/v2/everything?'+urllib.parse.urlencode({'q':query,'apiKey':key,'pageSize':100})
    payload=retry(lambda: json.loads(urllib.request.urlopen(url,timeout=20).read()))
    if payload.get('status')!='ok': raise ValueError(payload.get('message','News provider failed'))
    return [{'ticker':query,'text':a['title'], 'source':(a.get('source') or {}).get('name') or 'NewsAPI','kind':'news','published_at':a.get('publishedAt')} for a in payload['articles'] if a.get('title') and a['title'].strip()]

def connect(path=None):
    from storage import open_db
    return open_db(path)

def validate_records(records):
    """Validate a complete batch before writing any rows."""
    result=[]
    for index, record in enumerate(records, start=2):
        ticker=str(record.get('ticker') or '').strip().upper()
        text=str(record.get('text') or '').strip()
        kind=str(record.get('kind') or 'news').strip().lower()
        if not re.fullmatch(r'[A-Z0-9.\-]{1,10}',ticker):
            raise ValueError(f'Row {index}: ticker must contain 1–10 letters, digits, dots or hyphens')
        if not text or len(text)>20000:
            raise ValueError(f'Row {index}: text must contain 1–20,000 characters')
        if kind not in {'news','social'}:
            raise ValueError(f'Row {index}: kind must be news or social')
        source=str(record.get('source') or 'CSV import').strip()
        if len(source)>200: raise ValueError(f'Row {index}: source must be at most 200 characters')
        published=str(record.get('published_at') or '').strip()
        if published:
            try: published=datetime.fromisoformat(published.replace('Z','+00:00')).isoformat()
            except ValueError: raise ValueError(f'Row {index}: published_at must be an ISO 8601 date or timestamp')
        result.append(dict(ticker=ticker,text=text,kind=kind,source=source,published_at=published or None))
    return result

def ingest(records, db=None, synthetic=False, workspace="default"):
    with WRITE_LOCK:
        return _ingest(records, db, synthetic, workspace)

def _ingest(records, db=None, synthetic=False, workspace="default"):
    records=validate_records(records)
    own=db is None; db=db or connect(); accepted=0; started=False
    try:
        from storage import require_workspace
        require_workspace(db,workspace)
        db.execute('BEGIN TRANSACTION'); started=True
        for record in records:
            text=record['text']; ticker=record['ticker']
            digest=hashlib.sha256(json.dumps([workspace,ticker,text,synthetic],ensure_ascii=False).encode()).hexdigest()
            existing=db.execute('SELECT 1 FROM evidence WHERE workspace_id=? AND ticker=? AND text=? AND coalesce(synthetic,false)=?',[workspace,ticker,text,synthetic]).fetchone()
            if existing: continue
            db.execute('INSERT INTO evidence (id,ticker,text,source,kind,sentiment,created,synthetic,workspace_id,published_at) VALUES (?,?,?,?,?,?,?,?,?,?)',[digest,ticker,text,record['source'],record['kind'],sentiment(text,os.getenv('SENTIMENT_ENGINE','vader')),datetime.now(timezone.utc).isoformat(),synthetic,workspace,record['published_at']]); accepted+=1
        db.execute('COMMIT')
    except Exception:
        if started: db.execute('ROLLBACK')
        raise
    finally:
        if own: db.close()
    return accepted

@lru_cache(maxsize=16)
def sample(seed=42):
    rng=random.Random(seed)
    ticker_data=[]
    for symbol,name,sector,score,risk in TICKERS:
        ticker_data.append(dict(symbol=symbol,name=name,sector=sector,score=score,risk=risk,change=round((score-50)/20,2),mentions=rng.randint(260,1900),spark=[round(score+math.sin(i/3)*5+rng.uniform(-3,3),1) for i in range(20)]))
    titles=[('NVDA','AI infrastructure spending fuels an optimistic outlook','Earnings & guidance','positive'),('MSFT','Cloud growth accelerates as enterprise demand strengthens','Cloud computing','positive'),('TSLA','Margin pressure raises questions about the next quarter','Earnings & guidance','negative'),('AAPL','Services revenue provides a steady counterweight','Consumer demand','positive'),('JPM','Banking sector holds steady amid rate uncertainty','Interest rates','neutral'),('XOM','Energy outlook softens as demand forecasts cool','Energy transition','negative'),('LLY','Clinical milestone lifts confidence in product pipeline','Healthcare innovation','positive'),('AMZN','Retail efficiency gains support improving cash flow','Consumer demand','positive')]
    news=[dict(ticker=t,title=title,topic=topic,tone=tone,source=['MarketWire','Financial Daily','Investor Journal'][i%3],minutes=8+i*13,score=round(sentiment(title)*100),synthetic=True) for i,(t,title,topic,tone) in enumerate(titles)]
    history=[dict(day=(datetime(2026,7,10)+timedelta(days=i)).strftime('%b %d'),score=round(42+i*.28+math.sin(i*.3)*3.3,1),volume=rng.randint(200,580)) for i in range(93)]
    return dict(tickers=ticker_data,news=news,history=history,synthetic=True,updated='Oct 10, 2026 · 16:00 UTC',news_count=15000,social_count=500,universe=100)

def run_sample(news_count=15000,social_count=500,universe=100):
    """Exercise genuine 15K+/500/100 ingestion, dedup, NLP and SQL aggregation."""
    if not 1 <= universe <= 1000 or min(news_count,social_count)<0 or news_count+social_count>100000: raise ValueError('Run exceeds configured local limits')
    words=['strong growth and record profit','losses and weak demand','stable outlook and unchanged guidance']
    records=[dict(ticker=f'T{i%universe:03}',text=f'Synthetic article {i}: {words[i%3]}',source='Synthetic feed',kind='news' if i<news_count else 'social') for i in range(news_count+social_count)]
    start=time.perf_counter(); n=ingest(records,synthetic=True)
    db=connect()
    count=db.execute('SELECT count(DISTINCT ticker) FROM evidence WHERE synthetic').fetchone()[0]; db.close()
    return dict(inserted=n,processed=len(records),tickers=count,elapsed=round(time.perf_counter()-start,2),synthetic=True)

def backtest(threshold=60,cost_bps=10,days=90,seed=42):
    """Signals at t-1 determine exposure at t; fees on position transitions."""
    if not 0<=threshold<=100 or not 0<=cost_bps<=100 or not 30<=days<=365:
        raise ValueError('Simulation requires threshold/cost 0–100 and days 30–365')
    rng=random.Random(seed); equity=benchmark=100.; position=0; previous_signal=50; results=[]; returns=[]; trades=0; peak=100.; drawdown=0
    for i in range(days):
        signal=50+22*math.sin(i/8)+rng.uniform(-12,12)
        daily=rng.gauss(.0003,.012)
        next_position=int(previous_signal>=threshold)
        fee=abs(next_position-position)*cost_bps/10000
        net=next_position*daily-fee
        equity*=1+net; benchmark*=1+daily; peak=max(peak,equity); drawdown=min(drawdown,equity/peak-1)
        trades+=abs(next_position-position); position=next_position; previous_signal=signal; returns.append(net)
        results.append(dict(day=i+1,equity=round(equity,3),benchmark=round(benchmark,3),signal=round(signal,1),position=position))
    return dict(series=results,total_return=round(equity-100,2),benchmark_return=round(benchmark-100,2),max_drawdown=round(drawdown*100,2),trades=trades,cost_bps=cost_bps,synthetic=True,method='Prior-day signal; long/cash; fees on each position transition; seeded synthetic prices independent of signals.')

def stored_snapshot():
    db=connect()
    try:
        rows=db.execute('SELECT count(*),count(DISTINCT ticker),count(*) FILTER (WHERE kind=\'news\'),count(*) FILTER (WHERE kind=\'social\'),count(*) FILTER (WHERE NOT synthetic),max(created) FROM evidence').fetchone()
        signals=db.execute('SELECT ticker,round(greatest(0,least(100,50+50*avg(sentiment))),1),round(greatest(0,least(100,100*stddev_pop(sentiment))),1),count(*),bool_and(synthetic) FROM evidence GROUP BY ticker ORDER BY count(*) DESC,ticker LIMIT 100').fetchall()
        return dict(zip(['records','tickers','news','social','imported','updated'],rows)) | {'signals':[dict(zip(['ticker','score','risk','mentions','synthetic'],row)) for row in signals]}
    finally:
        db.close()
