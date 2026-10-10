"""Local workspaces and evidence queries. Workspaces organize data, not accounts."""
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
import os
import uuid
import duckdb

ROOT = Path(__file__).parent
LOCK = RLock()


def now():
    return datetime.now(timezone.utc).isoformat()


def open_db(path=None):
    target = Path(path or os.getenv('SIGNAL_DB_PATH') or ROOT / 'data/research.duckdb')
    target.parent.mkdir(parents=True, exist_ok=True)
    with LOCK:
        db = duckdb.connect(str(target))
        db.execute('CREATE TABLE IF NOT EXISTS evidence (id VARCHAR PRIMARY KEY,ticker VARCHAR,text VARCHAR,source VARCHAR,kind VARCHAR,sentiment DOUBLE,created VARCHAR,synthetic BOOLEAN)')
        columns = {row[1] for row in db.execute("PRAGMA table_info('evidence')").fetchall()}
        if 'workspace_id' not in columns:
            db.execute("ALTER TABLE evidence ADD COLUMN workspace_id VARCHAR DEFAULT 'default'")
        if 'published_at' not in columns:
            db.execute('ALTER TABLE evidence ADD COLUMN published_at VARCHAR')
        db.execute('CREATE TABLE IF NOT EXISTS workspaces (id VARCHAR PRIMARY KEY,name VARCHAR NOT NULL,created VARCHAR,archived BOOLEAN DEFAULT FALSE)')
        db.execute("INSERT INTO workspaces (id,name,created) VALUES ('default','My workspace',?) ON CONFLICT DO NOTHING", [now()])
        db.execute('CREATE TABLE IF NOT EXISTS watchlist (workspace_id VARCHAR,ticker VARCHAR,name VARCHAR,sector VARCHAR,created VARCHAR,PRIMARY KEY(workspace_id,ticker))')
        db.execute('CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY,name VARCHAR,role VARCHAR)')
        db.execute("INSERT INTO profile VALUES (1,'Researcher','Independent research') ON CONFLICT DO NOTHING")
        db.execute('CREATE TABLE IF NOT EXISTS activity (id VARCHAR PRIMARY KEY,workspace_id VARCHAR,message VARCHAR,created VARCHAR)')
    return db


def require_workspace(db, workspace):
    row = db.execute('SELECT id,name,created FROM workspaces WHERE id=? AND NOT archived', [workspace]).fetchone()
    if not row:
        raise KeyError('Workspace not found')
    return dict(zip(['id', 'name', 'created'], row))


def workspaces():
    with open_db() as db:
        rows = db.execute('SELECT w.id,w.name,w.created,w.archived,count(e.id) FROM workspaces w LEFT JOIN evidence e ON e.workspace_id=w.id AND NOT coalesce(e.synthetic,false) GROUP BY w.id,w.name,w.created,w.archived ORDER BY w.created').fetchall()
        return [dict(zip(['id', 'name', 'created', 'archived', 'records'], row)) for row in rows]


def create_workspace(name):
    with LOCK, open_db() as db:
        item = {'id': str(uuid.uuid4()), 'name': name, 'created': now(), 'archived': False, 'records': 0}
        db.execute('INSERT INTO workspaces VALUES (?,?,?,false)', [item['id'], name, item['created']])
        return item


def edit_workspace(workspace, name=None, archived=None):
    with LOCK, open_db() as db:
        if not db.execute('SELECT id FROM workspaces WHERE id=?', [workspace]).fetchone():
            raise KeyError('Workspace not found')
        if archived and db.execute('SELECT count(*) FROM workspaces WHERE NOT archived AND id<>?', [workspace]).fetchone()[0] == 0:
            raise ValueError('Keep at least one active workspace. Create another workspace first.')
        if name is not None:
            db.execute('UPDATE workspaces SET name=? WHERE id=?', [name, workspace])
        if archived is not None:
            db.execute('UPDATE workspaces SET archived=? WHERE id=?', [archived, workspace])
    return {'ok': True}


def profile(values=None):
    with LOCK, open_db() as db:
        if values:
            db.execute('UPDATE profile SET name=?,role=? WHERE id=1', [values['name'], values['role']])
        row = db.execute('SELECT name,role FROM profile WHERE id=1').fetchone()
        return dict(zip(['name', 'role'], row))


def add_activity(workspace, message):
    with LOCK, open_db() as db:
        db.execute('INSERT INTO activity VALUES (?,?,?,?)', [str(uuid.uuid4()), workspace, message, now()])


def get_activity(workspace):
    with open_db() as db:
        require_workspace(db, workspace)
        rows = db.execute('SELECT id,message,created FROM activity WHERE workspace_id=? ORDER BY created DESC LIMIT 50', [workspace]).fetchall()
        return [dict(zip(['id', 'message', 'created'], row)) for row in rows]


def follow(workspace, ticker, name='', sector='Unclassified'):
    with LOCK, open_db() as db:
        require_workspace(db, workspace)
        db.execute('INSERT INTO watchlist VALUES (?,?,?,?,?) ON CONFLICT (workspace_id,ticker) DO UPDATE SET name=excluded.name,sector=excluded.sector', [workspace, ticker, name or ticker, sector or 'Unclassified', now()])
    return {'ok': True}


def unfollow(workspace, ticker):
    with LOCK, open_db() as db:
        require_workspace(db, workspace)
        db.execute('DELETE FROM watchlist WHERE workspace_id=? AND ticker=?', [workspace, ticker])
    return {'ok': True}


def evidence(workspace='default', ticker=None, limit=100, offset=0):
    with open_db() as db:
        require_workspace(db, workspace)
        clause = 'workspace_id=? AND NOT coalesce(synthetic,false)'
        params = [workspace]
        if ticker:
            clause += ' AND ticker=?'
            params.append(ticker)
        rows = db.execute(f'SELECT id,ticker,text,source,kind,sentiment,created,coalesce(published_at,created) FROM evidence WHERE {clause} ORDER BY created DESC,id LIMIT ? OFFSET ?', params + [limit, offset]).fetchall()
        return [dict(zip(['id', 'ticker', 'text', 'source', 'kind', 'sentiment', 'created', 'published_at'], row)) for row in rows]


def overview(workspace='default'):
    with open_db() as db:
        ws = require_workspace(db, workspace)
        base = 'workspace_id=? AND NOT coalesce(synthetic,false)'
        row = db.execute(f"SELECT count(*),count(DISTINCT ticker),count(*) FILTER (WHERE kind='news'),count(*) FILTER (WHERE kind='social'),max(created),round(50+50*avg(sentiment),1),CASE WHEN count(*)>0 THEN round(least(100,100*stddev_pop(sentiment)),1) END FROM evidence WHERE {base}", [workspace]).fetchone()
        totals = dict(zip(['records', 'tickers', 'news', 'social', 'updated', 'score', 'risk'], row))
        rows = db.execute(f'SELECT ticker,round(greatest(0,least(100,50+50*avg(sentiment))),1),round(greatest(0,least(100,100*stddev_pop(sentiment))),1),count(*),max(created) FROM evidence WHERE {base} GROUP BY ticker ORDER BY count(*) DESC,ticker', [workspace]).fetchall()
        signals = [dict(zip(['ticker', 'score', 'risk', 'mentions', 'updated'], r)) for r in rows]
        tracked = {r[0]: {'ticker': r[0], 'name': r[1], 'sector': r[2]} for r in db.execute('SELECT ticker,name,sector FROM watchlist WHERE workspace_id=? ORDER BY created,ticker', [workspace]).fetchall()}
        for signal in signals:
            signal.update(tracked.get(signal['ticker'], {'name': signal['ticker'], 'sector': 'Unclassified'}))
            signal['followed'] = signal['ticker'] in tracked
        measured = {r['ticker']: r for r in signals}
        watches = [measured.get(ticker, {**meta, 'score': None, 'risk': None, 'mentions': 0, 'updated': None, 'followed': True}) for ticker, meta in tracked.items()]
        history = db.execute(f'SELECT substr(coalesce(published_at,created),1,10) AS day,round(50+50*avg(sentiment),1),count(*) FROM evidence WHERE {base} GROUP BY day ORDER BY day', [workspace]).fetchall()
        return {'workspace': ws, 'totals': totals, 'signals': signals, 'watchlist': watches, 'history': [dict(zip(['day', 'score', 'count'], r)) for r in history], 'evidence': evidence(workspace), 'synthetic': False}
