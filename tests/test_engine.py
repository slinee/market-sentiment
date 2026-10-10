import pytest
from engine import sentiment, ingest, connect, backtest, retry, sample, stored_snapshot


def test_vader_tone_and_cache():
    assert sentiment('Excellent growth and strong profit') > 0
    assert sentiment('Terrible losses and bankruptcy') < 0
    sentiment('Excellent growth and strong profit')
    assert sentiment.cache_info().hits > 0


def test_ingest_dedup_and_sql(tmp_path):
    db = connect(tmp_path / 'test.duckdb')
    records = [{'ticker': 'NVDA', 'text': 'Strong profit growth'}, {'ticker': 'NVDA', 'text': 'Severe losses'}]
    assert ingest(records, db, True) == 2
    assert ingest(records, db, True) == 0
    assert db.execute('SELECT count(*),bool_and(synthetic) FROM evidence').fetchone() == (2, True)
    db.close()


def test_invalid_batch_cannot_partially_write(tmp_path):
    db = connect(tmp_path / 'test.duckdb')
    with pytest.raises(ValueError, match='Row 3'):
        ingest([{'ticker': 'NVDA', 'text': 'Good'}, {'text': 'missing ticker'}], db)
    assert db.execute('SELECT count(*) FROM evidence').fetchone()[0] == 0
    db.close()


def test_nlp_failure_rolls_back_batch(tmp_path, monkeypatch):
    import engine
    db = connect(tmp_path / 'test.duckdb')
    def fail_second(text, mode):
        if text == 'second':
            raise RuntimeError('model unavailable')
        return 0.5
    monkeypatch.setattr(engine, 'sentiment', fail_second)
    with pytest.raises(RuntimeError):
        ingest([{'ticker': 'NVDA', 'text': 'first'}, {'ticker': 'NVDA', 'text': 'second'}], db)
    assert db.execute('SELECT count(*) FROM evidence').fetchone()[0] == 0
    db.close()


@pytest.mark.parametrize('record', [
    {'ticker': '<script>', 'text': 'Good'},
    {'ticker': 'NVDA', 'text': None},
    {'ticker': 'NVDA', 'text': 'Good', 'kind': 'other'},
])
def test_invalid_record_rejected(record):
    with pytest.raises(ValueError):
        ingest([record])


def test_stored_snapshot_counts_and_bounds(tmp_path, monkeypatch):
    monkeypatch.setenv('SIGNAL_DB_PATH', str(tmp_path / 'snapshot.duckdb'))
    ingest([{'ticker': 'NVDA', 'text': 'Excellent profit growth', 'kind': 'news'},
            {'ticker': 'NVDA', 'text': 'Terrible losses', 'kind': 'social'}])
    ingest([{'ticker': 'T001', 'text': 'Flat outlook'}], synthetic=True)
    d = stored_snapshot()
    assert (d['records'], d['tickers'], d['news'], d['social'], d['imported']) == (3, 2, 2, 1, 2)
    assert all(0 <= row['score'] <= 100 and 0 <= row['risk'] <= 100 for row in d['signals'])
    assert d['signals'][0]['mentions'] == 2


def test_retry_recovers_and_exhausts():
    calls = []
    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise TimeoutError()
        return 'ok'
    assert retry(flaky, delay=0) == 'ok'
    calls.clear()
    def failed():
        calls.append(1)
        raise ConnectionError()
    with pytest.raises(ConnectionError):
        retry(failed, delay=0)
    assert len(calls) == 4


def test_backtest_prior_signal_no_lookahead_and_costs():
    low = backtest(0, 0, 90)
    costly = backtest(0, 100, 90)
    assert low['series'][0]['position'] == 1
    assert costly['total_return'] < low['total_return']
    cash = backtest(100, 0, 90)
    assert cash['total_return'] == 0 and cash['trades'] == 0
    assert cash['series'][0]['position'] == 0
    run = backtest(60, 10, 90)
    assert run == backtest(60, 10, 90)
    assert all(row['position'] == int(previous['signal'] >= 60)
               for previous, row in zip(run['series'], run['series'][1:]))
    assert all(0 <= row['signal'] <= 100 for row in low['series'])


def test_backtest_parameter_bounds():
    with pytest.raises(ValueError):
        backtest(101, 10, 90)


def test_sample_explicitly_synthetic_and_continuous_window():
    d = sample()
    assert d['synthetic'] and all(n['synthetic'] for n in d['news'])
    assert len(d['tickers']) == 12
    assert len(d['history']) == len({row['day'] for row in d['history']}) == 93
