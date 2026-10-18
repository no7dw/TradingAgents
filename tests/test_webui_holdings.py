"""Holdings validation, opt-in run snapshots and agent grounding without paid APIs."""
from datetime import date
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from webui.holdings import parse_holdings, portfolio_context
from webui.server import create_app

DAY = date(2026, 1, 1)
CSV = '\ufeffsymbol,shares,avg_cost,market_value,currency\naapl,10.5,180,2200,USD\nNVDA,5,,700,USD\n'


def test_normalizes_aliases_and_preserves_decimal_values():
    snapshot = parse_holdings(CSV, DAY)
    assert snapshot['positions'][0] == dict(ticker='AAPL', quantity='10.5', avg_cost='180', market_value='2200', currency='USD')
    assert 'avg_cost' not in snapshot['positions'][1]
    assert parse_holdings('ticker,quantity\nAMD,1\n', DAY)['positions'][0]['currency'] == 'USD'


@pytest.mark.parametrize('csv', [
    '', 'ticker,cost\nAMD,1', 'ticker,quantity,shares\nAMD,1,2',
    'ticker,quantity\nAMD,1\namd,2', 'ticker,quantity\nBAD NAME,1',
    'ticker,quantity\nAMD,-2', 'ticker,quantity\nAMD,0',
    'ticker,quantity\nAMD,NaN', 'ticker,quantity\nAMD,Infinity',
    'ticker,quantity\nAMD,1e-999999', 'ticker,quantity\nAMD,1e999999',
    'ticker,quantity\nAMD,1,2', 'ticker,quantity\nAMD',
    'ticker,quantity,market_value\nAMD,2,-1',
    'ticker,quantity,currency\nAMD,2,US Dollars',
])
def test_invalid_rows_rejected(csv):
    with pytest.raises(ValueError):
        parse_holdings(csv, DAY)


def test_size_and_position_limits():
    with pytest.raises(ValueError, match='1 MB'):
        parse_holdings('x' * 1_000_001, DAY)
    with pytest.raises(ValueError, match='500'):
        parse_holdings('ticker,quantity\n' + '\n'.join(f'T{i},1' for i in range(501)), DAY)


def test_context_is_bounded_target_included_and_no_fx_or_invented_weights():
    snapshot = parse_holdings('ticker,quantity,market_value,currency\n' + '\n'.join(f'T{i},1,{i},USD' for i in range(25)) + '\nOTHER,3,,EUR', DAY)
    text = portfolio_context(snapshot, 'T0', DAY)
    assert '"target_position": {"ticker": "T0"' in text
    assert '"omitted_position_count": 6' in text
    assert '"reported_market_value_by_currency": {"USD": "300"}' in text
    assert '"all_positions_have_market_value": false' in text
    assert 'Do not infer portfolio weights' in text
    assert len(text) < 6000
    with pytest.raises(ValueError, match='after the analysis date'):
        portfolio_context(snapshot, 'T0', date(2025, 1, 1))


def test_snapshot_change_in_omitted_position_invalidates_context():
    snapshot = parse_holdings('ticker,quantity\n' + '\n'.join(f'T{i:03},1' for i in range(30)), DAY)
    original = portfolio_context(snapshot, 'T000', DAY)
    snapshot['positions'][-1]['quantity'] = '2'
    assert portfolio_context(snapshot, 'T000', DAY) != original


def test_import_preview_save_restart_invalid_import_and_clear(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        body = dict(csv=CSV, as_of=str(DAY))
        assert client.get('/api/holdings').json() is None
        assert client.post('/api/holdings/preview', json=body).status_code == 200
        assert client.get('/api/holdings').json() is None
        saved = client.put('/api/holdings', json=body).json()
        assert client.put('/api/holdings', json={**body, 'csv': 'wrong'}).status_code == 422
        assert client.get('/api/holdings').json() == saved
    with TestClient(create_app(tmp_path)) as client:
        assert client.get('/api/holdings').json() == saved
        body = dict(ticker='AAPL', day=str(DAY), analysts=['market'], provider='deepseek', quick='deepseek-v4-flash', deep='deepseek-v4-flash', use_holdings=True)
        assert client.put('/api/setup', json=body).status_code == 200
        assert client.delete('/api/holdings').status_code == 200
        assert client.get('/api/holdings').json() is None
        assert client.get('/api/config').json()['setup']['use_holdings'] is False


def test_optional_holdings_frozen_per_run_and_available_in_chat(tmp_path):
    import time
    captured = []
    class Graph:
        def __init__(self, analysts, config, callbacks):
            captured.append(config)
        def propagate(self, ticker, day, **kwargs):
            return {'final_trade_decision': 'Hold'}, 'Hold'
        def save_reports(self, *args):
            return tmp_path / 'reports'
    class LLM:
        async def astream(self, messages):
            assert '10.5' in messages[0][1] and 'portfolio_context' in messages[0][1]
            yield type('Chunk', (), {'content': 'Known holdings.'})()
    class Client:
        def get_llm(self):
            return LLM()
    app = create_app(tmp_path, graph_factory=Graph, llm_factory=lambda **kw: Client())
    body = dict(ticker='AAPL', day=str(DAY), analysts=['market'], provider='deepseek', quick='deepseek-v4-flash', deep='deepseek-v4-flash')
    with TestClient(app) as client:
        assert client.post('/api/runs', json={**body, 'use_holdings': True}).status_code == 422
        client.put('/api/holdings', json={'csv': CSV, 'as_of': str(DAY)})
        assert client.post('/api/runs', json={**body, 'day': '2025-01-01', 'use_holdings': True}).status_code == 422
        for enabled in (False, True):
            response = client.post('/api/runs', json={**body, 'use_holdings': enabled})
            assert response.status_code == 200
            run_id = response.json()['id']
            for _ in range(100):
                record = client.get(f'/api/runs/{run_id}').json()
                if record['status'] != 'running': break
                time.sleep(.01)
            assert record['status'] == 'completed'
            assert bool(captured[-1].get('portfolio_context')) == enabled
            assert bool(record['state'].get('portfolio_context')) == enabled
        client.put('/api/holdings', json={'csv': 'ticker,quantity\nAAPL,99', 'as_of': str(DAY)})
        client.delete('/api/holdings')
        original = client.get(f'/api/runs/{run_id}').json()
        assert original['holdings_snapshot']['positions'][0]['quantity'] == '10.5'
        assert 'holdings_snapshot' not in client.get('/api/runs').json()[0]
        response = client.post(f'/api/runs/{run_id}/chat', json={'message': 'What do I own?', 'request_id': 'holdings-chat'})
        assert 'Known holdings.' in response.text


def test_holdings_reach_trader_all_risk_agents_and_portfolio_manager():
    from tradingagents.agents.trader.trader import create_trader
    from tradingagents.agents.managers.portfolio_manager import create_portfolio_manager
    from tradingagents.agents.risk_mgmt.aggressive_debator import create_aggressive_debator
    from tradingagents.agents.risk_mgmt.conservative_debator import create_conservative_debator
    from tradingagents.agents.risk_mgmt.neutral_debator import create_neutral_debator
    from tradingagents.graph.propagation import Propagator
    context = portfolio_context(parse_holdings(CSV, DAY), 'AAPL', DAY)
    state = Propagator().create_initial_state('AAPL', str(DAY), portfolio_context=context)
    state.update(investment_plan='Research', trader_investment_plan='Proposal')
    for factory in (create_trader, create_aggressive_debator, create_conservative_debator, create_neutral_debator, create_portfolio_manager):
        llm = MagicMock()
        # Use supported free-text fallback to capture the actual LLM input.
        llm.with_structured_output.side_effect = NotImplementedError
        llm.invoke.return_value.content = 'Hold'
        factory(llm)(state)
        prompt = llm.invoke.call_args.args[0]
        text = prompt if isinstance(prompt, str) else '\n'.join(message['content'] for message in prompt)
        assert context in text, factory.__name__
    from tradingagents.graph.trading_graph import TradingAgentsGraph
    graph = object.__new__(TradingAgentsGraph)
    graph.selected_analysts = ['market']
    graph.config = dict(max_debate_rounds=1, max_risk_discuss_rounds=1)
    baseline = graph._run_signature('stock')
    graph.config['portfolio_context'] = context
    assert graph._run_signature('stock') != baseline
    graph.config['portfolio_context'] = ''
    assert graph._run_signature('stock') == baseline
