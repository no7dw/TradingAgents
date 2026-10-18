"""Searchable U.S. listings from Nasdaq Trader's public symbol directories."""
import csv
import io
import json
import re
import tempfile
import threading
import time
from pathlib import Path

import httpx

SOURCES = [
    'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt',
    'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt',
]
EXCHANGES = {'N': 'NYSE', 'A': 'NYSE American', 'P': 'NYSE Arca', 'Z': 'Cboe BZX', 'V': 'IEX'}


def parse_directory(text, nasdaq=False):
    reader = csv.DictReader(io.StringIO(text), delimiter='|')
    key = 'Symbol' if nasdaq else 'ACT Symbol'
    required = {key, 'Security Name', 'ETF', 'Test Issue'}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError('Unexpected Nasdaq symbol directory format')
    stocks = []
    for row in reader:
        if row.get('Test Issue') != 'N' or row.get('ETF') != 'N':
            continue
        source_symbol = row[key].strip()
        symbol = source_symbol.replace('.', '-')  # Yahoo's share-class notation.
        name = (row.get('Security Name') or '').strip()
        if not name or not re.fullmatch(r'[A-Z][A-Z0-9.-]{0,39}', symbol):
            continue
        stocks.append(dict(symbol=symbol, name=name, exchange='NASDAQ' if nasdaq else EXCHANGES.get(row.get('Exchange'), row.get('Exchange', '')), source_symbol=source_symbol))
    if not stocks:
        raise ValueError('Symbol directory contains no stock listings')
    return stocks


class SymbolDirectory:
    def __init__(self, root, fetch=None, clock=time.time):
        self.path = Path(root) / 'us_symbols.json'
        self.fetch = fetch or self.download
        self.clock = clock
        self.lock = threading.Lock()
        self.cached = None
        self.retry_after = 0

    @staticmethod
    def download(url):
        response = httpx.get(url, timeout=20, follow_redirects=True)
        response.raise_for_status()
        return response.text

    def load(self):
        with self.lock:
            if self.cached is None and self.path.exists():
                try:
                    payload = json.loads(self.path.read_text())
                    if isinstance(payload.get('stocks'), list) and payload['stocks'] and all(isinstance(s, dict) and all(isinstance(s.get(k), str) for k in ('symbol', 'name', 'exchange')) for s in payload['stocks']) and isinstance(payload.get('fetched_at'), (int, float)):
                        self.cached = payload
                except (ValueError, OSError, TypeError, AttributeError):
                    pass
            stale = self.cached is None or self.clock() - self.cached['fetched_at'] >= 86400
            if stale and self.clock() >= self.retry_after:
                try:
                    stocks = {}
                    for index, url in enumerate(SOURCES):
                        for item in parse_directory(self.fetch(url), nasdaq=index == 0):
                            stocks.setdefault(item['symbol'], item)
                    payload = dict(fetched_at=self.clock(), stocks=sorted(stocks.values(), key=lambda s:s['symbol']))
                    self.path.parent.mkdir(parents=True, exist_ok=True)
                    with tempfile.NamedTemporaryFile(mode='w', dir=self.path.parent, delete=False) as file:
                        json.dump(payload, file)
                        temporary = Path(file.name)
                    try:
                        temporary.replace(self.path)
                    finally:
                        temporary.unlink(missing_ok=True)
                    self.cached = payload
                    stale = False
                except (httpx.HTTPError, ValueError, OSError):
                    self.retry_after = self.clock() + 300
            if self.cached is None:
                raise ValueError('Stock list is temporarily unavailable. You can still select a custom symbol.')
            return self.cached, stale



def export_catalog(directory, targets):
    payload, stale = directory.load()
    for target in targets:
        target = Path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode='w', dir=target.parent, delete=False) as file:
            json.dump(payload, file)
            temporary = Path(file.name)
        try:
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return len(payload['stocks'])


def prepare_catalog():
    root = Path(__file__).resolve().parents[1]
    try:
        return export_catalog(SymbolDirectory(Path.home()/'.tradingagents/webui'), [root/'web/public/assets/us-symbols.json', root/'web/dist/assets/us-symbols.json'])
    except (ValueError, OSError):
        print('U.S. stock catalog unavailable; custom symbol entry remains available.')
        return 0


if __name__ == '__main__':
    print(f'Exported {prepare_catalog()} U.S. stock listings.')
