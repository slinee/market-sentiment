"""Route contracts use an isolated database; no live keys or downloads."""
import pytest
from fastapi import HTTPException
from server import Import, upload, overview, simulation, signals

@pytest.fixture(autouse=True)
def isolated_db(tmp_path, monkeypatch):
    monkeypatch.setenv('SIGNAL_DB_PATH', str(tmp_path / 'routes.duckdb'))

def test_csv_bom_dedup_and_overview_refresh():
    body = Import(csv='\ufeffticker,text,source,kind\nNVDA,Excellent profits,Research,news\n')
    assert upload(body) == {'inserted': 1, 'processed': 1, 'duplicates': 0}
    assert upload(body) == {'inserted': 0, 'processed': 1, 'duplicates': 1}
    assert overview()['totals']['records'] == 1
    assert signals()[0]['ticker'] == 'NVDA'

@pytest.mark.parametrize('text', ['ticker,text\nNVDA,\n', 'hello,world\n1,2\n',
    'ticker,text\nNVDA,first,extra\n', 'ticker,text\nNVDA,"unterminated'])
def test_csv_returns_clear_400(text):
    with pytest.raises(HTTPException) as error:
        upload(Import(csv=text))
    assert error.value.status_code == 400
    assert overview()['totals']['records'] == 0

def test_html_like_evidence_stored_as_text():
    upload(Import(csv='ticker,text,source\nNVDA,<img src=x onerror=alert(1)>,<script>\n'))
    from storage import evidence
    assert evidence()[0]['text'] == '<img src=x onerror=alert(1)>'

def test_bad_simulation_returns_400():
    with pytest.raises(HTTPException) as error:
        simulation(threshold=-1)
    assert error.value.status_code == 400
