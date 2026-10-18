import json

import pytest
from webui.symbols import SymbolDirectory, parse_directory

NASDAQ = 'Symbol|Security Name|ETF|Test Issue\nAAPL|Apple Inc. - Common Stock|N|N\nNVDA|NVIDIA Corporation - Common Stock|N|N\nTEST|Test issue|N|Y\nETF|An ETF|Y|N\nFile Creation Time: test|||\n'
OTHER = 'ACT Symbol|Security Name|ETF|Test Issue|Exchange\nBRK.B|Berkshire Hathaway Class B|N|N|N\nIBM|International Business Machines|N|N|N\n'


def test_directory_excludes_etfs_tests_and_normalizes_share_classes():
    assert [r['symbol'] for r in parse_directory(NASDAQ, True)] == ['AAPL','NVDA']
    item=parse_directory(OTHER)[0]
    assert item['symbol']=='BRK-B'
    assert item['source_symbol']=='BRK.B'
    assert item['name']=='Berkshire Hathaway Class B'
    assert item['exchange']=='NYSE'
    with pytest.raises(ValueError):
        parse_directory('<html>Unavailable</html>')


def test_search_names_symbols_and_durable_cache(tmp_path):
    fetched=[]
    def fetch(url):
        fetched.append(url)
        return NASDAQ if 'nasdaqlisted' in url else OTHER
    directory=SymbolDirectory(tmp_path,fetch=fetch,clock=lambda:100000)
    payload,_=directory.load()
    assert {s['symbol'] for s in payload['stocks']}=={'AAPL','NVDA','BRK-B','IBM'}
    directory.load()
    assert len(fetched)==2
    assert SymbolDirectory(tmp_path,fetch=lambda url:pytest.fail('fresh cache must avoid network'),clock=lambda:100010).load()[0]==payload


def test_failed_refresh_keeps_existing_cache_and_retries_later(tmp_path):
    SymbolDirectory(tmp_path,fetch=lambda url:NASDAQ if 'nasdaqlisted' in url else OTHER,clock=lambda:1).load()
    original=(tmp_path/'us_symbols.json').read_text()
    calls=[]
    def bad_fetch(url):
        calls.append(url)
        return '<html>broken upstream</html>'
    stale=SymbolDirectory(tmp_path,fetch=bad_fetch,clock=lambda:100000)
    assert stale.load()[1] is True
    assert stale.load()[0]['stocks'][0]['symbol']=='AAPL'
    assert len(calls)==1
    assert (tmp_path/'us_symbols.json').read_text()==original
    (tmp_path/'us_symbols.json').unlink()
    with pytest.raises(ValueError,match='temporarily unavailable'):
        SymbolDirectory(tmp_path,fetch=bad_fetch).load()


def test_export_catalog_for_browser_search(tmp_path):
    from webui.symbols import export_catalog
    directory=SymbolDirectory(tmp_path/'cache',fetch=lambda url:NASDAQ if 'nasdaqlisted' in url else OTHER)
    target=tmp_path/'assets/us-symbols.json'
    assert export_catalog(directory,[target])==4
    exported=json.loads(target.read_text())
    assert any(s['symbol']=='AAPL' and 'Apple' in s['name'] for s in exported['stocks'])
    assert exported['fetched_at']>0
