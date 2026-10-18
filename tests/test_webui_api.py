"""API contracts, durable chat, cancellation, and report grounding."""
import asyncio
import json

import pytest

pytest.importorskip('fastapi')
from fastapi.testclient import TestClient

from webui.server import ChatRequest, create_app


class FakeLLM:
    seen = []
    async def astream(self, messages):
        self.seen[:] = messages
        for text in ('Saved ', 'evidence.'):
            yield type('Chunk', (), {'content': text})()


class FakeClient:
    def get_llm(self):
        return FakeLLM()


def setup(tmp_path, **kwargs):
    app = create_app(tmp_path, llm_factory=lambda **kw: FakeClient(), **kwargs)
    store = app.state.store
    run_id = store.create('AMD', '2026-10-17', ['market'], {}, 'stock')
    store.update(run_id, state={'market_report': 'Evidence: RSI was 37 on the analysis date', 'final_trade_decision': 'Hold'}, status='completed')
    return app, store, run_id


def test_chat_stream_persists_and_grounds_in_selected_report(tmp_path):
    app, store, run_id = setup(tmp_path)
    with TestClient(app) as client:
        response = client.post(f'/api/runs/{run_id}/chat', json={'message':'Why Hold?', 'request_id':'turn-one'})
        events = [json.loads(line) for line in response.text.splitlines()]
        assert events[-1] == {'type':'done'}
        assert ''.join(e['text'] for e in events if e['type']=='delta') == 'Saved evidence.'
        assert 'RSI was 37' in FakeLLM.seen[0][1]
        assert 'no live market lookup' in FakeLLM.seen[0][1]
        history = client.get(f'/api/runs/{run_id}/chat').json()
        assert history[0]['answer'] == 'Saved evidence.'
        assert history[0]['status'] == 'completed'
        assert client.post(f'/api/runs/{run_id}/chat', json={'message':'Duplicate', 'request_id':'turn-one'}).status_code == 409
        client.post(f'/api/runs/{run_id}/chat', json={'message':'Explain more', 'request_id':'turn-two'})
        assert ('human', 'Why Hold?') in FakeLLM.seen
        assert ('ai', 'Saved evidence.') in FakeLLM.seen
    restarted = create_app(tmp_path)
    with TestClient(restarted) as client:
        assert len(client.get(f'/api/runs/{run_id}/chat').json()) == 2


def test_cancel_keeps_partial_answer_and_releases_lock(tmp_path):
    app, store, run_id = setup(tmp_path)
    endpoint = next(r.endpoint for r in app.routes if getattr(r, 'path', '')=='/api/runs/{run_id}/chat' and 'POST' in r.methods)
    async def cancel():
        response = endpoint(run_id, ChatRequest(message='Question', request_id='cancel-one'))
        await anext(response.body_iterator)
        await response.body_iterator.aclose()
    asyncio.run(cancel())
    assert store.chat(run_id)[0]['status'] == 'cancelled'
    assert store.chat(run_id)[0]['answer'] == 'Saved '
    with TestClient(app) as client:
        assert client.post(f'/api/runs/{run_id}/chat', json={'message':'Next', 'request_id':'cancel-two'}).status_code == 200


def test_portfolio_validation_origin_and_missing_run(tmp_path):
    app, store, run_id = setup(tmp_path)
    with TestClient(app) as client:
        assert client.put('/api/portfolio', json={'tickers':['msft','AMD','msft']}).json() == ['MSFT','AMD']
        assert client.put('/api/portfolio', json={'tickers':['bad symbol']}).status_code == 422
        assert client.get('/api/portfolio').json() == ['MSFT','AMD']
        assert client.put('/api/portfolio', json={'tickers':[]}, headers={'Origin':'https://untrusted.example'}).status_code == 403
        assert client.get('/api/runs/missing/chat').status_code == 404
        assert client.post(f'/api/runs/{run_id}/chat', json={'message':'  ', 'request_id':'blank'}).status_code == 422


def test_chat_error_redacts_credentials_and_recovers_on_restart(tmp_path, monkeypatch):
    secret = 'test-secret-do-not-log'
    monkeypatch.setenv('DEEPSEEK_API_KEY', secret)
    class BrokenClient:
        def get_llm(self):
            raise RuntimeError(secret)
    app = create_app(tmp_path, llm_factory=lambda **kw: BrokenClient())
    store = app.state.store
    run_id = store.create('AMD','2026-10-17',['market'],{},'stock')
    with TestClient(app) as client:
        response=client.post(f'/api/runs/{run_id}/chat',json={'message':'Question','request_id':'error-one'})
        assert secret not in response.text
        assert '[redacted]' in response.text
        assert store.chat(run_id)[0]['status']=='failed'
    store.begin_turn('interrupted', run_id, 'Unfinished')
    store.save_turn('interrupted', 'Partial answer')
    with TestClient(create_app(tmp_path)) as client:
        assert client.get(f'/api/runs/{run_id}/chat').json()[-1]['status']=='interrupted'


def test_analysis_endpoint_keeps_existing_graph_and_history(tmp_path):
    import time
    captured = {}
    class Graph:
        def __init__(self, analysts, config, callbacks):
            captured.update(analysts=analysts, config=config)
        def propagate(self, ticker, day, asset_type, on_update):
            state={'company_of_interest':ticker,'trade_date':day,'market_report':'Grounded report','final_trade_decision':'Hold'}
            on_update(state)
            return state, 'Hold'
        def save_reports(self, state, ticker):
            return tmp_path/'reports'
    app=create_app(tmp_path, graph_factory=Graph)
    with TestClient(app) as client:
        response=client.post('/api/runs',json={'ticker':'msft','day':'2026-10-17','analysts':['market'],'provider':'deepseek','quick':'deepseek-v4-flash','deep':'deepseek-v4-flash'})
        assert response.status_code==200
        run_id=response.json()['id']
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            record=client.get(f'/api/runs/{run_id}').json()
            if record['status']!='running':
                break
            time.sleep(.02)
        assert record['status']=='completed'
        assert record['ticker']=='MSFT'
        assert record['state']['market_report']=='Grounded report'
        assert captured['config']['llm_provider']=='deepseek'
        assert 'state' not in client.get('/api/runs').json()[0]
        assert 'DEEPSEEK_API_KEY' not in client.get('/api/config').text


def test_saved_analysis_setup_survives_restart(tmp_path):
    body={'ticker':'nvda','day':'2026-10-17','analysts':['market','news'],'provider':'deepseek','quick':'deepseek-v4-flash','deep':'deepseek-v4-flash','rounds':2,'language':'Chinese','asset_type':'stock'}
    with TestClient(create_app(tmp_path)) as client:
        assert client.get('/api/config').json()['setup'] is None
        response=client.put('/api/setup',json={**body,'api_key':'do-not-save'})
        assert response.status_code==200
        assert response.json()['ticker']=='NVDA'
        assert client.get('/api/runs').json()==[]
    with TestClient(create_app(tmp_path)) as client:
        saved=client.get('/api/config').json()['setup']
        assert saved['rounds']==2
        assert saved['language']=='Chinese'
        assert saved['analysts']==['market','news']
        assert 'api_key' not in saved
        assert client.put('/api/setup',json={**body,'provider':'missing'}).status_code==422
        assert client.get('/api/config').json()['setup']==saved
