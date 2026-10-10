# Signal

Market sentiment research with Python, DuckDB, VADER, FastAPI, and Streamlit. Import your evidence and manage separate workspaces.

Requires Python 3.12+.

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 3002
```

Open http://localhost:3002. Optional provider keys go in `.env`; see `.env.example`. Backtests use hypothetical prices.

Tests: `pytest -q` · Streamlit: `streamlit run streamlit_app.py`
