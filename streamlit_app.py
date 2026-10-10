"""Optional Streamlit companion. Uses the same real, scoped evidence store."""
import io
import csv
import pandas as pd
import plotly.express as px
import streamlit as st
from engine import ingest, backtest
import storage

st.set_page_config(page_title='Signal · Research', page_icon='▥', layout='wide')
st.title('Signal · Research')
choices = [item for item in storage.workspaces() if not item['archived']]
selected = st.sidebar.selectbox('Workspace', choices, format_func=lambda item: item['name'])
workspace = selected['id']
st.sidebar.caption('Local data organization. No authentication or shared accounts.')
if st.sidebar.button('Refresh evidence'):
    st.rerun()
data = storage.overview(workspace)
st.caption(f"{selected['name']} · {data['totals']['records']:,} stored records")
overview, feed, sources, simulation = st.tabs(['Overview', 'Evidence', 'Import CSV', 'Simulation lab'])
with overview:
    if data['totals']['records']:
        c1, c2, c3 = st.columns(3)
        c1.metric('Sentiment / 100', data['totals']['score'])
        c2.metric('Evidence records', data['totals']['records'])
        c3.metric('Disagreement / 100', data['totals']['risk'])
        st.plotly_chart(px.line(pd.DataFrame(data['history']), x='day', y='score', markers=True, range_y=[0,100], title='Mean sentiment by evidence date'), width='stretch')
        st.dataframe(pd.DataFrame(data['signals']), width='stretch', hide_index=True)
    else:
        st.info('This workspace has no evidence. Import your own CSV to calculate signals.')
    st.subheader('Watchlist')
    if data['watchlist']:
        st.dataframe(pd.DataFrame(data['watchlist']), width='stretch', hide_index=True)
    else:
        st.caption('No tickers followed. Manage your watchlist in the main Signal app.')
with feed:
    if data['evidence']:
        st.dataframe(pd.DataFrame(data['evidence']).drop(columns='id'), width='stretch', hide_index=True)
        st.caption('Most recent 100 records. Export all records in the main app.')
    else:
        st.info('No imported evidence in this workspace.')
with sources:
    st.write('Required columns: ticker,text. Optional: source,kind,published_at.')
    uploaded = st.file_uploader('Choose your evidence CSV', type=['csv'])
    if st.button('Import & analyze', disabled=uploaded is None):
        try:
            if uploaded.size > 2_000_000:
                raise ValueError('CSV must be smaller than 2 MB.')
            rows = list(csv.DictReader(io.StringIO(uploaded.getvalue().decode('utf-8-sig')), strict=True))
            if not rows or not {'ticker','text'}.issubset(rows[0]) or any(None in row for row in rows):
                raise ValueError('Use ticker,text columns and quote commas inside text.')
            count = ingest(rows, workspace=workspace)
            storage.add_activity(workspace, f'Streamlit import: {count} new records.')
            st.success(f'{count} new records imported. Refresh evidence to update the overview.')
        except Exception as error:
            st.error(str(error))
with simulation:
    st.warning('Hypothetical prices and signals. This does not use your imported evidence or historical market prices.')
    with st.form('simulation'):
        threshold = st.slider('Entry threshold', 0, 100, 60)
        costs = st.slider('Transaction cost (bps)', 0, 100, 10)
        days = st.selectbox('Simulation days', [90,180,365])
        run = st.form_submit_button('Run hypothetical simulation')
    if run:
        result = backtest(threshold,costs,days)
        st.plotly_chart(px.line(pd.DataFrame(result['series']), x='day', y=['equity','benchmark'], title='Hypothetical equity · initial value 100'), width='stretch')
        st.write({key:result[key] for key in ['total_return','benchmark_return','max_drawdown','trades']})
        st.caption(result['method'])
