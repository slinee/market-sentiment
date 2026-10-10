import duckdb
import pytest
import storage
from engine import ingest
from server import upload, Import

@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    path=tmp_path/'workspace.duckdb'
    monkeypatch.setenv('SIGNAL_DB_PATH',str(path))
    return path

def test_fresh_workspace_has_no_fabricated_data():
    result=storage.overview()
    assert result['totals']['records']==0
    assert result['totals']['score'] is None and result['totals']['risk'] is None
    assert result['history']==result['evidence']==result['signals']==result['watchlist']==[]
    assert result['synthetic'] is False

def test_old_imports_migrate_without_exposing_synthetic_rows(isolated_store):
    db=duckdb.connect(str(isolated_store))
    db.execute('CREATE TABLE evidence (id VARCHAR PRIMARY KEY,ticker VARCHAR,text VARCHAR,source VARCHAR,kind VARCHAR,sentiment DOUBLE,created VARCHAR,synthetic BOOLEAN)')
    db.execute("INSERT INTO evidence VALUES ('real','NVDA','Real text','Owner','news',0.5,'2026-10-10T10:00:00',false),('demo','T001','Authored test','Synthetic','news',0.9,'2026-10-10T10:00:00',true)")
    db.close()
    result=storage.overview()
    assert result['totals']['records']==1 and result['evidence'][0]['text']=='Real text'
    assert result['signals'][0]['ticker']=='NVDA'
    with storage.open_db() as db:
        assert db.execute('SELECT count(*) FROM evidence').fetchone()[0]==2

def test_workspaces_isolate_evidence_watchlist_and_dedup():
    second=storage.create_workspace('Second')['id']
    rows=[{'ticker':'NVDA','text':'Actual report of growth'}]
    assert ingest(rows)==1 and ingest(rows)==0
    assert ingest(rows,workspace=second)==1
    storage.follow(second,'NVDA','NVIDIA','Technology')
    assert storage.overview()['watchlist']==[]
    assert storage.overview(second)['watchlist'][0]['name']=='NVIDIA'
    assert storage.evidence(second)[0]['id']!=storage.evidence()[0]['id']
    storage.unfollow(second,'NVDA')
    assert storage.overview(second)['watchlist']==[]
    assert storage.overview(second)['totals']['records']==1

def test_archive_restore_preserves_records_and_refuses_last_workspace():
    other=storage.create_workspace('Other')['id']
    ingest([{'ticker':'AAPL','text':'Owner notes'}],workspace=other)
    storage.edit_workspace(other,archived=True)
    with pytest.raises(KeyError):storage.overview(other)
    with pytest.raises(KeyError):ingest([{'ticker':'AAPL','text':'Later notes'}],workspace=other)
    with pytest.raises(ValueError):storage.edit_workspace('default',archived=True)
    storage.edit_workspace(other,name='Restored',archived=False)
    assert storage.overview(other)['totals']['records']==1
    assert storage.overview(other)['workspace']['name']=='Restored'

def test_profile_persists_and_followed_ticker_does_not_fabricate_a_score():
    assert storage.profile({'name':'Ava Chen','role':'Analyst'})=={'name':'Ava Chen','role':'Analyst'}
    assert storage.profile()['name']=='Ava Chen'
    storage.follow('default','ABC','Company','Industrials')
    ticker=storage.overview()['watchlist'][0]
    assert ticker['score'] is None and ticker['mentions']==0

def test_timeline_uses_real_dates_and_import_follow_is_explicit():
    body=Import(csv='ticker,text,published_at\nNVDA,Strong growth,2026-10-01\nNVDA,Weak demand,2026-10-03',follow=False)
    upload(body)
    result=storage.overview()
    assert [row['day'] for row in result['history']]==['2026-10-01','2026-10-03']
    assert result['watchlist']==[]
    upload(Import(csv='ticker,text\nAAPL,Steady guidance',follow=True))
    assert storage.overview()['watchlist'][0]['ticker']=='AAPL'

def test_synthetic_and_real_identical_text_do_not_collide():
    record=[{'ticker':'ABC','text':'Same text'}]
    assert ingest(record,synthetic=True)==1
    assert ingest(record)==1
    assert storage.overview()['totals']['records']==1
