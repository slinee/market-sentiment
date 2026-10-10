"""Signal local API. Every evidence read and write is workspace-scoped."""
import csv
import io
import logging
import os
from pathlib import Path
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from engine import backtest, ingest, news_api
import storage

app = FastAPI(title='Signal / Research workspace')
ROOT = Path(__file__).parent
app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')


@app.exception_handler(KeyError)
async def missing_workspace(request, exc):
    return JSONResponse(status_code=404, content={'detail': 'Workspace not found. Choose an active workspace.'})


@app.exception_handler(ValueError)
async def invalid_value(request, exc):
    return JSONResponse(status_code=400, content={'detail': str(exc)})


@app.exception_handler(Exception)
async def unexpected_error(request, exc):
    logging.getLogger('signal').error('Request failed: %s', request.url.path, exc_info=exc)
    return JSONResponse(status_code=500, content={'detail': 'The local engine could not complete the request. Check its configuration and retry.'})


@app.get('/')
def home():
    return FileResponse(ROOT / 'static/index.html', headers={'Cache-Control': 'no-store'})


@app.get('/api/status')
def status():
    return {'engine': os.getenv('SENTIMENT_ENGINE', 'vader'), 'news_configured': bool(os.getenv('NEWS_API_KEY')), 'openai_configured': bool(os.getenv('OPENAI_API_KEY')), 'storage': 'Local DuckDB'}


@app.get('/api/workspaces')
def workspaces():
    return storage.workspaces()


class WorkspaceName(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    @field_validator('name')
    @classmethod
    def clean_name(cls, value):
        if not value.strip():
            raise ValueError('Workspace name cannot be blank')
        return value.strip()


class WorkspaceEdit(WorkspaceName):
    archived: bool = False


@app.post('/api/workspaces', status_code=201)
def create_workspace(body: WorkspaceName):
    return storage.create_workspace(body.name)


@app.patch('/api/workspaces/{workspace}')
def edit_workspace(workspace: str, body: WorkspaceEdit):
    return storage.edit_workspace(workspace, body.name, body.archived)


@app.delete('/api/workspaces/{workspace}')
def archive_workspace(workspace: str):
    """Archive, preserving all evidence. Restore with PATCH archived=false."""
    return storage.edit_workspace(workspace, archived=True)


class Profile(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    role: str = Field(max_length=80)
    @field_validator('name', 'role')
    @classmethod
    def trim(cls, value):
        return value.strip()


@app.get('/api/profile')
def get_profile():
    return storage.profile()


@app.patch('/api/profile')
def edit_profile(body: Profile):
    if not body.name:
        raise HTTPException(400, 'Enter your name')
    return storage.profile(body.model_dump())


@app.get('/api/overview')
def overview(workspace: str = 'default'):
    return storage.overview(workspace)


@app.get('/api/evidence')
def evidence(workspace: str = 'default', ticker: str | None = None, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    return storage.evidence(workspace, ticker.upper() if ticker else None, limit, offset)


@app.get('/api/signals')
def signals(workspace: str = 'default'):
    return storage.overview(workspace)['signals']


@app.get('/api/activity')
def activity(workspace: str = 'default'):
    return storage.get_activity(workspace)


class Watch(BaseModel):
    ticker: str = Field(min_length=1, max_length=10, pattern=r'^[A-Za-z0-9.\-]+$')
    name: str = Field(default='', max_length=80)
    sector: str = Field(default='Unclassified', max_length=50)


@app.post('/api/watchlist')
def follow(body: Watch, workspace: str = 'default'):
    return storage.follow(workspace, body.ticker.upper(), body.name.strip(), body.sector.strip())


@app.delete('/api/watchlist/{ticker}')
def unfollow(ticker: str, workspace: str = 'default'):
    return storage.unfollow(workspace, ticker.upper())


class Import(BaseModel):
    csv: str = Field(max_length=2000000)
    follow: bool = False


@app.post('/api/ingest')
def upload(body: Import, workspace: str = 'default'):
    try:
        reader = csv.DictReader(io.StringIO(body.csv.lstrip('\ufeff')), strict=True)
        rows = list(reader)
        if not rows or not {'ticker', 'text'}.issubset(reader.fieldnames or []):
            raise ValueError('CSV requires ticker,text columns and at least one record')
        if len(rows) > 20000:
            raise ValueError('Import at most 20,000 records per batch')
        if any(None in row for row in rows):
            raise ValueError('CSV has extra values: quote text containing commas')
        inserted = ingest(rows, workspace=workspace)
        if body.follow:
            existing = {r['ticker'] for r in storage.overview(workspace)['watchlist']}
            for ticker in {r['ticker'].strip().upper() for r in rows} - existing:
                storage.follow(workspace, ticker)
        storage.add_activity(workspace, f'CSV import: {inserted} new records; {len(rows) - inserted} duplicates skipped.')
        return {'inserted': inserted, 'processed': len(rows), 'duplicates': len(rows) - inserted}
    except (ValueError, csv.Error) as exc:
        raise HTTPException(400, str(exc)) from exc


class LiveRequest(BaseModel):
    ticker: str = Field(min_length=1, max_length=10, pattern=r'^[A-Za-z0-9.\-]+$')
    follow: bool = False


@app.post('/api/live-news')
def live_news(body: LiveRequest, workspace: str = 'default'):
    with storage.open_db() as db:
        storage.require_workspace(db, workspace)
    try:
        rows = news_api(body.ticker.upper())
        inserted = ingest(rows, workspace=workspace)
        if body.follow and body.ticker.upper() not in {row['ticker'] for row in storage.overview(workspace)['watchlist']}:
            storage.follow(workspace, body.ticker.upper())
        storage.add_activity(workspace, f'NewsAPI: {inserted} new articles for {body.ticker.upper()}.')
        return {'inserted': inserted, 'processed': len(rows)}
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except (OSError, TimeoutError, ConnectionError) as exc:
        raise HTTPException(502, 'News provider unavailable after retry attempts') from exc


@app.get('/api/backtest')
def simulation(threshold: int = 60, cost_bps: int = 10, days: int = 90):
    if not 0 <= threshold <= 100 or not 0 <= cost_bps <= 100 or not 30 <= days <= 365:
        raise HTTPException(400, 'Invalid simulation parameters')
    return backtest(threshold, cost_bps, days)
