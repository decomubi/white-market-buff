import React, { useState, useEffect, useMemo } from 'react';
import { Search, ArrowUpDown, TrendingUp, DollarSign, Box, RefreshCw, Filter, ExternalLink } from 'lucide-react';

export default function App() {
  const [items, setItems] = useState([]);
  const [detailsOpen, setDetailsOpen] = useState({});
  const [detailsById, setDetailsById] = useState({});
  const [detailsLoading, setDetailsLoading] = useState({});
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [fxRate, setFxRate] = useState(0.14);

  const [scanLimit, setScanLimit] = useState(30);
  const [searchTerm, setSearchTerm] = useState('');
  const [showOnlyProfitable, setShowOnlyProfitable] = useState(false);
  const [hideZeroBuyOffers, setHideZeroBuyOffers] = useState(false);

  const [sortConfig, setSortConfig] = useState({ key: 'spread', direction: 'desc' });

  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const [minSpread, setMinSpread] = useState(5);
  const [minProfit, setMinProfit] = useState(1);
  const [maxBuffPrice, setMaxBuffPrice] = useState(999999);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/.netlify/functions/scan?limit=${encodeURIComponent(scanLimit)}`);
      const data = await res.json();
      if (data?.ok) {
        setItems(data.items || []);
        setFxRate(data.fx || 0.14);
        setLastUpdated(new Date());
      } else {
        console.error(data?.error || 'Scan failed');
        setItems([]);
      }
    } catch (err) {
      console.error(err);
      setItems([]);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchDetails = async (item) => {
    try {
      setDetailsLoading((p) => ({ ...p, [item.id]: true }));
      const url = `/.netlify/functions/scan?goods_id=${encodeURIComponent(item.id)}&hash_name=${encodeURIComponent(item.name)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data?.ok) {
        setDetailsById((p) => ({ ...p, [item.id]: data }));
      } else {
        setDetailsById((p) => ({ ...p, [item.id]: { ok: false, error: data?.error || "Failed to load details" } }));
      }
    } catch (e) {
      setDetailsById((p) => ({ ...p, [item.id]: { ok: false, error: e?.message || String(e) } }));
    } finally {
      setDetailsLoading((p) => ({ ...p, [item.id]: false }));
    }
  };

  const toggleDetails = (item) => {
    setDetailsOpen((p) => {
      const next = { ...p, [item.id]: !p[item.id] };
      return next;
    });
    const willOpen = !detailsOpen[item.id];
    if (willOpen && !detailsById[item.id] && !detailsLoading[item.id]) {
      fetchDetails(item);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const processedData = useMemo(() => {
    const processed = items.map(item => {
      const buffUsd = (Number(item.buffPrice || 0) * (Number(item.fx || fxRate) || fxRate));
      const mcBuy = Number(item.wmPrice || 0);

      const spread = buffUsd > 0 ? ((mcBuy - buffUsd) / buffUsd) * 100 : 0;
      const netProfit = mcBuy - buffUsd;

      return {
        ...item,
        buffUsd,
        mcBuy,
        spread,
        netProfit
      };
    });

    let filtered = processed.filter(item =>
      item.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    if (hideZeroBuyOffers) filtered = filtered.filter(item => item.mcBuy > 0);
    if (showOnlyProfitable) filtered = filtered.filter(item => item.netProfit > 0);

    filtered = filtered.filter(item =>
      item.spread >= minSpread &&
      item.netProfit >= minProfit &&
      item.buffUsd <= maxBuffPrice
    );

    if (sortConfig.key) {
      filtered.sort((a, b) => {
        const aVal = a[sortConfig.key];
        const bVal = b[sortConfig.key];
        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return filtered;
  }, [items, searchTerm, showOnlyProfitable, hideZeroBuyOffers, sortConfig, minSpread, minProfit, maxBuffPrice, fxRate]);

  const stats = useMemo(() => {
    const profitable = processedData.filter(item => item.netProfit > 0).length;
    const avgSpread = processedData.length > 0
      ? processedData.reduce((sum, item) => sum + item.spread, 0) / processedData.length
      : 0;
    const totalVolume = processedData.reduce((sum, item) => sum + (Number(item.quantity || 0)), 0);
    return { profitable, avgSpread, totalVolume };
  }, [processedData]);

  const requestSort = (key) => {
    let direction = 'desc';
    if (sortConfig.key === key && sortConfig.direction === 'desc') direction = 'asc';
    setSortConfig({ key, direction });
  };

  return (
    <div className="min-h-screen bg-[#0b0e14] text-gray-100">
      <div className="max-w-6xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500/40 to-purple-500/30 flex items-center justify-center border border-indigo-500/20">
              <TrendingUp className="w-5 h-5 text-indigo-200" />
            </div>
            <div>
              <div className="text-xl font-bold tracking-tight">ArbitrageScanner</div>
              <div className="text-sm text-gray-400">Buff163 to MarketCSGO</div>
            </div>
          </div>

          <div className="flex items-center gap-3 text-sm text-gray-300">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
              Buff163 API: Server-side
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
              MarketCSGO API: Server-side
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div className="rounded-2xl bg-[#121318] border border-gray-800 p-4">
            <div className="text-xs text-gray-400 mb-2">PROFITABLE FLIPS</div>
            <div className="flex items-center justify-between">
              <div className="text-2xl font-bold text-green-400">{stats.profitable}</div>
              <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center border border-green-500/20">
                <TrendingUp className="w-5 h-5 text-green-300" />
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-[#121318] border border-gray-800 p-4">
            <div className="text-xs text-gray-400 mb-2">AVG. SPREAD</div>
            <div className="flex items-center justify-between">
              <div className={`text-2xl font-bold ${stats.avgSpread > 0 ? 'text-green-400' : 'text-red-400'}`}>
                {stats.avgSpread.toFixed(2)}%
              </div>
              <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center border border-blue-500/20">
                <ArrowUpDown className="w-5 h-5 text-blue-300" />
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-[#121318] border border-gray-800 p-4">
            <div className="text-xs text-gray-400 mb-2">TOTAL VOLUME</div>
            <div className="flex items-center justify-between">
              <div className="text-2xl font-bold text-indigo-300">{stats.totalVolume}</div>
              <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20">
                <Box className="w-5 h-5 text-indigo-300" />
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-[#121318] border border-gray-800 p-4">
            <div className="text-xs text-gray-400 mb-2">DATA STATUS</div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-bold">Up to Date</div>
                <div className="text-xs text-gray-500">FX CNY→USD: {fxRate}</div>
              </div>
              <button
                onClick={fetchData}
                disabled={isLoading}
                className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center border border-purple-500/20 hover:bg-purple-500/20 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-5 h-5 text-purple-300 ${isLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search skin name (e.g. Redline)..."
              className="w-full bg-[#121318] border border-gray-800 rounded-2xl pl-11 pr-4 py-3 text-sm outline-none focus:border-indigo-500/40"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsFiltersOpen(!isFiltersOpen)}
              className="flex items-center gap-2 bg-[#121318] border border-gray-800 rounded-2xl px-4 py-3 text-sm hover:border-gray-700 transition-colors"
            >
              <Filter className="w-4 h-4" />
              Advanced Filters
            </button>

            <input
              type="number"
              value={scanLimit}
              onChange={(e) => setScanLimit(Number(e.target.value))}
              className="w-20 bg-[#121318] border border-gray-800 rounded-2xl px-4 py-3 text-sm outline-none focus:border-indigo-500/40 text-center"
              min={1}
              max={60}
            />

            <button
              onClick={fetchData}
              disabled={isLoading}
              className="bg-indigo-600 hover:bg-indigo-700 rounded-2xl px-6 py-3 text-sm font-medium transition-colors disabled:opacity-50"
            >
              {isLoading ? 'Scanning...' : 'Scan'}
            </button>
          </div>
        </div>

        {isFiltersOpen && (
          <div className="rounded-2xl bg-[#121318] border border-gray-800 p-6 mb-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
              <div>
                <label className="block text-sm font-medium mb-2">Min Spread (%)</label>
                <input
                  type="number"
                  value={minSpread}
                  onChange={(e) => setMinSpread(Number(e.target.value))}
                  className="w-full bg-[#0b0e14] border border-gray-800 rounded-xl px-4 py-2 text-sm outline-none focus:border-indigo-500/40"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Min Profit ($)</label>
                <input
                  type="number"
                  value={minProfit}
                  onChange={(e) => setMinProfit(Number(e.target.value))}
                  className="w-full bg-[#0b0e14] border border-gray-800 rounded-xl px-4 py-2 text-sm outline-none focus:border-indigo-500/40"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Max BUFF Price ($)</label>
                <input
                  type="number"
                  value={maxBuffPrice}
                  onChange={(e) => setMaxBuffPrice(Number(e.target.value))}
                  className="w-full bg-[#0b0e14] border border-gray-800 rounded-xl px-4 py-2 text-sm outline-none focus:border-indigo-500/40"
                />
              </div>
            </div>

            <div className="flex flex-col md:flex-row gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hideZeroBuyOffers}
                  onChange={(e) => setHideZeroBuyOffers(e.target.checked)}
                  className="rounded"
                />
                <span className="text-sm">Hide $0 buy offers</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showOnlyProfitable}
                  onChange={(e) => setShowOnlyProfitable(e.target.checked)}
                  className="rounded"
                />
                <span className="text-sm">Only profitable</span>
              </label>
            </div>
          </div>
        )}

        <div className="rounded-2xl bg-[#121318] border border-gray-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-[#0f1016] border-b border-gray-800">
                <tr>
                  <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase">Item Details</th>
                  <th onClick={() => requestSort('buffUsd')} className="px-6 py-4 text-right text-xs font-medium text-gray-400 uppercase cursor-pointer">BUFF163 Price</th>
                  <th onClick={() => requestSort('mcBuy')} className="px-6 py-4 text-right text-xs font-medium text-gray-400 uppercase cursor-pointer">MCSGO Buy Order</th>
                  <th onClick={() => requestSort('spread')} className="px-6 py-4 text-right text-xs font-medium text-gray-400 uppercase cursor-pointer">Spread</th>
                  <th onClick={() => requestSort('netProfit')} className="px-6 py-4 text-right text-xs font-medium text-gray-400 uppercase cursor-pointer">Net Profit</th>
                  <th className="px-6 py-4 text-right text-xs font-medium text-gray-400 uppercase">Quantity</th>
                  <th className="px-6 py-4 text-right text-xs font-medium text-gray-400 uppercase">Actions</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-800">
                {processedData.length > 0 ? (
                  processedData.map((item) => (
                    <React.Fragment key={item.id}>
                      <tr className="hover:bg-[#151720] transition-colors">
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-4">
                            <div className="w-12 h-12 rounded-xl bg-[#0b0e14] border border-gray-800 flex items-center justify-center overflow-hidden">
                              {item.image ? (
                                <img src={item.image} alt={item.name} className="w-full h-full object-contain" />
                              ) : null}
                            </div>
                            <div>
                              <div className="font-medium text-sm">{item.name}</div>
                              {item.wmErr ? (
                                <div className="text-xs text-amber-400 mt-1">API: {item.wmErr}</div>
                              ) : null}
                            </div>
                          </div>
                        </td>

                        <td className="px-6 py-4 text-right">
                          <div className="text-sm font-medium">¥ {Number(item.buffPrice || 0).toFixed(2)}</div>
                          <div className="text-xs text-gray-500">$ {Number(item.buffUsd || 0).toFixed(2)} (FX)</div>
                        </td>

                        <td className="px-6 py-4 text-right">
                          <div className="text-sm font-medium">$ {Number(item.mcBuy || 0).toFixed(2)}</div>
                          <div className="text-xs text-gray-500">{item.wmBuyQty || 0} orders</div>
                        </td>

                        <td className="px-6 py-4 text-right">
                          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${item.spread > 0 ? 'bg-green-500/10 text-green-300 border border-green-500/20' : 'bg-red-500/10 text-red-300 border border-red-500/20'}`}>
                            {item.spread.toFixed(2)}%
                          </span>
                        </td>

                        <td className="px-6 py-4 text-right">
                          <div className={`text-sm font-medium ${item.netProfit > 0 ? 'text-green-400' : 'text-red-400'}`}>
                            ${item.netProfit.toFixed(2)}
                          </div>
                        </td>

                        <td className="px-6 py-4 text-right">
                          <div className="text-sm font-medium">{item.quantity}</div>
                          <div className="w-20 h-1.5 bg-gray-800 rounded-full ml-auto mt-2">
                            <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.min(100, (item.quantity / 1500) * 100)}%` }} />
                          </div>
                        </td>

                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                          <button
                            onClick={() => toggleDetails(item)}
                            className="inline-flex items-center px-3 py-1.5 mr-2 rounded-lg bg-[#2a2d35] hover:bg-[#343845] text-gray-200 transition-colors text-xs"
                          >
                            Details
                          </button>

                          <a
                            href={item.wmUrl || `https://market.csgo.com/en/?search=${encodeURIComponent(item.name)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-indigo-500/10 border border-indigo-500/20 hover:bg-indigo-500/20 transition-colors"
                          >
                            <ExternalLink className="w-4 h-4 text-indigo-300" />
                          </a>
                        </td>
                      </tr>

                      {detailsOpen[item.id] && (
                        <tr className="bg-[#16181d]">
                          <td colSpan={7} className="px-6 py-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div className="rounded-xl border border-gray-800 bg-[#121318] p-4">
                                <div className="text-sm font-semibold text-gray-100 mb-2">BUFF lowest 5 listings</div>
                                {detailsLoading[item.id] && !detailsById[item.id] ? (
                                  <div className="text-sm text-gray-400">Loading…</div>
                                ) : detailsById[item.id]?.ok ? (
                                  <div className="space-y-2">
                                    {(detailsById[item.id]?.buff?.listings || []).map((l, idx) => (
                                      <div key={idx} className="flex items-center justify-between text-sm">
                                        <div className="text-gray-300">#{idx + 1}</div>
                                        <div className="text-gray-200">¥ {Number(l.priceCny).toFixed(2)}</div>
                                        <div className="text-gray-400">float: {l.float ?? "—"}</div>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="text-sm text-amber-400">{detailsById[item.id]?.error || "Click Details to load"}</div>
                                )}
                              </div>

                              <div className="rounded-xl border border-gray-800 bg-[#121318] p-4">
                                <div className="text-sm font-semibold text-gray-100 mb-2">MarketCSGO</div>
                                {detailsById[item.id]?.ok ? (
                                  <div className="space-y-2 text-sm">
                                    <div className="flex items-center justify-between">
                                      <span className="text-gray-400">Best buy order</span>
                                      <span className="text-gray-200">$ {Number(detailsById[item.id]?.mc?.bestBuy || 0).toFixed(2)}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-gray-400">Buy order qty</span>
                                      <span className="text-gray-200">{detailsById[item.id]?.mc?.bestBuyQty || 0}</span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                      <span className="text-gray-400">Best sell</span>
                                      <span className="text-gray-200">$ {Number(detailsById[item.id]?.mc?.bestSell || 0).toFixed(2)}</span>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="text-sm text-amber-400">{detailsById[item.id]?.error || "No details yet"}</div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                      No items found. Click "Scan".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="px-6 py-4 border-t border-gray-800 text-xs text-gray-500 flex items-center justify-between">
            <div>Showing {processedData.length} results</div>
            <div>{lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString()}` : ""}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
