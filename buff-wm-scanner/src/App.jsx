import React, { useEffect, useMemo, useState } from "react";
import {
  Search,
  ArrowUpDown,
  TrendingUp,
  Box,
  RefreshCw,
  Filter,
  ExternalLink,
} from "lucide-react";

const App = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [sortConfig, setSortConfig] = useState({ key: "spread", direction: "desc" });
  const [loading, setLoading] = useState(false);

  const [items, setItems] = useState([]);
  const [fx, setFx] = useState(0.14);

  // ✅ Upgrade #1
  const [hideZeroBuyOrders, setHideZeroBuyOrders] = useState(true);
  // ✅ Upgrade #2
  const [onlyProfitable, setOnlyProfitable] = useState(false);

  const [apiStatus, setApiStatus] = useState({
    buff: "—",
    wm: "—",
    lastError: "",
  });

  const calculateMetrics = (item) => {
    const profit = (item.wmPrice || 0) - (item.buffPrice || 0);
    const spread =
      item.buffPrice > 0 ? ((item.wmPrice - item.buffPrice) / item.buffPrice) * 100 : 0;
    return { ...item, profit, spread };
  };

  const processedData = useMemo(() => {
    let data = (items || []).map(calculateMetrics);

    // Filtering (search)
    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      data = data.filter(
        (i) =>
          (i.name || "").toLowerCase().includes(lower) ||
          (i.wear || "").toLowerCase().includes(lower)
      );
    }

    // ✅ Upgrade #1: Hide $0 buy offers
    if (hideZeroBuyOrders) {
      data = data.filter((i) => Number(i.wmPrice || 0) > 0);
    }

    // ✅ Upgrade #2: Only profitable
    if (onlyProfitable) {
      data = data.filter((i) => Number(i.profit || 0) > 0);
    }

    // Sorting
    if (sortConfig.key) {
      data.sort((a, b) => {
        const av = a[sortConfig.key];
        const bv = b[sortConfig.key];
        if (av < bv) return sortConfig.direction === "asc" ? -1 : 1;
        if (av > bv) return sortConfig.direction === "asc" ? 1 : -1;
        return 0;
      });
    }

    return data;
  }, [items, searchTerm, sortConfig, hideZeroBuyOrders, onlyProfitable]);

  const handleSort = (key) => {
    let direction = "desc";
    if (sortConfig.key === key && sortConfig.direction === "desc") direction = "asc";
    setSortConfig({ key, direction });
  };

  async function loadData() {
    setLoading(true);
    setApiStatus((s) => ({ ...s, lastError: "" }));

    try {
      const res = await fetch(`/.netlify/functions/scan?limit=30`, { cache: "no-store" });
      const json = await res.json();

      if (!json.ok) {
        setApiStatus((s) => ({
          ...s,
          buff: "—",
          wm: "—",
          lastError: json.error || "Unknown error",
        }));
        setItems([]);
        setFx(0.14);
        return;
      }

      setFx(Number(json.fx || 0.14));
      setItems(Array.isArray(json.items) ? json.items : []);

      // If function returned ok, we assume both ran server-side
      setApiStatus((s) => ({ ...s, buff: "Online", wm: "Online", lastError: "" }));
    } catch (e) {
      setApiStatus((s) => ({
        ...s,
        buff: "—",
        wm: "—",
        lastError: `fetch failed`,
      }));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const StatCard = ({ label, value, icon, color }) => (
    <div className="bg-[#1a1b1e] p-4 rounded-xl border border-gray-800 flex items-center justify-between hover:border-gray-700 transition-colors">
      <div>
        <p className="text-gray-500 text-xs font-medium uppercase tracking-wider">{label}</p>
        <p className={`text-2xl font-bold mt-1 ${color || "text-white"}`}>{value}</p>
      </div>
      <div className={`p-3 rounded-lg bg-opacity-10 ${color ? color.replace("text-", "bg-") : "bg-gray-700"} ${color}`}>
        {icon}
      </div>
    </div>
  );

  const Th = ({ label, sortKey, align = "left" }) => {
    const isActive = sortConfig.key === sortKey;
    return (
      <th
        scope="col"
        className={`px-6 py-4 text-${align} text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-indigo-400 transition-colors select-none group`}
        onClick={() => handleSort(sortKey)}
      >
        <div
          className={`flex items-center gap-2 ${
            align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start"
          }`}
        >
          {label}
          <span className={`transform transition-opacity ${isActive ? "opacity-100" : "opacity-0 group-hover:opacity-50"}`}>
            <ArrowUpDown size={14} className={isActive && sortConfig.direction === "asc" ? "transform rotate-180" : ""} />
          </span>
        </div>
      </th>
    );
  };

  return (
    <div className="min-h-screen bg-[#121212] text-gray-200 font-sans selection:bg-indigo-500 selection:text-white">
      {/* Navbar */}
      <nav className="border-b border-gray-800 bg-[#1a1b1e] sticky top-0 z-10 shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="bg-indigo-600 p-2 rounded-lg">
                <TrendingUp size={20} className="text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight">
                  Arbitrage<span className="text-indigo-400">Scanner</span>
                </h1>
                <p className="text-xs text-gray-500">Buff163 to WhiteMarket</p>
              </div>
            </div>

            <div className="hidden md:flex items-center gap-6 text-sm text-gray-400">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${apiStatus.buff === "Online" ? "bg-green-500 animate-pulse" : "bg-gray-600"}`}></span>
                Buff163 API: {apiStatus.buff}
              </div>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${apiStatus.wm === "Online" ? "bg-green-500 animate-pulse" : "bg-gray-600"}`}></span>
                WhiteMarket API: {apiStatus.wm}
              </div>
            </div>
          </div>
        </div>
      </nav>

      {/* Main */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <StatCard
            label="Profitable Flips"
            value={processedData.filter((i) => i.profit > 0).length}
            icon={<TrendingUp size={18} />}
            color="text-green-400"
          />
          <StatCard
            label="Avg. Spread"
            value={`${(
              processedData.reduce((acc, cur) => acc + (cur.spread || 0), 0) / (processedData.length || 1)
            ).toFixed(2)}%`}
            icon={<Box size={18} />}
            color="text-blue-400"
          />
          <StatCard
            label="Total Volume"
            value={processedData.reduce((acc, cur) => acc + (cur.quantity || 0), 0)}
            icon={<Filter size={18} />}
            color="text-purple-400"
          />
          <div
            className="bg-[#1a1b1e] p-4 rounded-xl border border-gray-800 flex items-center justify-between hover:border-gray-700 transition-colors cursor-pointer group"
            onClick={loadData}
          >
            <div>
              <p className="text-gray-500 text-xs font-medium uppercase tracking-wider">Data Status</p>
              <p className="text-xl font-bold text-white mt-1 group-hover:text-indigo-400 transition-colors">
                {loading ? "Updating..." : "Up to Date"}
              </p>
              <p className="text-[10px] text-gray-500 mt-1">FX CNY→USD: {fx}</p>
            </div>
            <RefreshCw size={24} className={`text-gray-500 group-hover:text-indigo-400 transition-all ${loading ? "animate-spin" : ""}`} />
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 mb-3">
          <div className="relative flex-grow">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search size={18} className="text-gray-500" />
            </div>
            <input
              type="text"
              className="block w-full pl-10 pr-3 py-3 border border-gray-800 rounded-xl leading-5 bg-[#1a1b1e] text-gray-300 placeholder-gray-500 focus:outline-none focus:bg-[#202124] focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 sm:text-sm transition-all shadow-sm"
              placeholder="Search skin name (e.g. Redline)..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          <button className="flex items-center justify-center gap-2 px-6 py-3 border border-gray-800 text-sm font-medium rounded-xl text-gray-300 bg-[#1a1b1e] hover:bg-[#25262b] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 focus:ring-offset-[#121212] transition-colors">
            <Filter size={18} />
            Advanced Filters
          </button>
        </div>

        {/* ✅ Upgrades row */}
        <div className="flex items-center gap-6 mb-6 text-sm text-gray-300">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hideZeroBuyOrders}
              onChange={(e) => setHideZeroBuyOrders(e.target.checked)}
            />
            Hide $0 buy orders
          </label>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onlyProfitable}
              onChange={(e) => setOnlyProfitable(e.target.checked)}
            />
            Only profitable
          </label>

          {apiStatus.lastError ? (
            <span className="text-red-400 ml-auto">Scan failed: {apiStatus.lastError}</span>
          ) : null}
        </div>

        {/* Table */}
        <div className="bg-[#1a1b1e] rounded-xl border border-gray-800 shadow-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-800">
              <thead className="bg-[#151619]">
                <tr>
                  <Th label="Item Details" sortKey="name" align="left" />
                  <Th label="Buff163 Price" sortKey="buffPrice" align="right" />
                  <Th label="WM Buy Offer" sortKey="wmPrice" align="right" />
                  <Th label="Spread" sortKey="spread" align="right" />
                  <Th label="Net Profit" sortKey="profit" align="right" />
                  <Th label="Quantity" sortKey="quantity" align="center" />
                  <th className="px-6 py-4 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {processedData.length > 0 ? (
                  processedData.map((item) => (
                    <tr key={item.id} className="hover:bg-[#202124] transition-colors group">
                      {/* Item */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="flex-shrink-0 h-12 w-16 relative bg-gray-800 rounded-md flex items-center justify-center overflow-hidden border border-gray-700">
                            {item.image ? (
                              <img
                                className="h-full object-contain transform group-hover:scale-110 transition-transform duration-300"
                                src={item.image}
                                alt=""
                              />
                            ) : null}
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-medium text-white">{item.name}</div>
                            <div className="text-xs text-gray-500 flex items-center gap-2">{item.wear || "-"}</div>
                          </div>
                        </div>
                      </td>

                      {/* Buff */}
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end text-sm text-gray-300 font-mono">
                          <span className="text-xs text-gray-600 mr-1">$</span>
                          {Number(item.buffPrice || 0).toFixed(2)}
                        </div>
                        <div className="text-[10px] text-gray-500">Listing</div>
                      </td>

                      {/* WM Buy Offer */}
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end text-sm text-gray-300 font-mono">
                          <span className="text-xs text-gray-600 mr-1">$</span>
                          {Number(item.wmPrice || 0).toFixed(2)}
                        </div>
                        <div className="text-[10px] text-gray-500">Buy Offer</div>
                      </td>

                      {/* Spread */}
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <span
                          className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-md ${
                            item.spread > 0
                              ? "bg-green-900/30 text-green-400 border border-green-900"
                              : "bg-red-900/30 text-red-400 border border-red-900"
                          }`}
                        >
                          {item.spread > 0 ? "+" : ""}
                          {Number(item.spread || 0).toFixed(2)}%
                        </span>
                      </td>

                      {/* Profit */}
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <div className={`text-sm font-mono font-bold ${item.profit > 0 ? "text-green-400" : "text-red-400"}`}>
                          ${Number(item.profit || 0).toFixed(2)}
                        </div>
                      </td>

                      {/* Quantity */}
                      <td className="px-6 py-4 whitespace-nowrap text-center">
                        <div className="text-sm text-gray-300">{item.quantity || 0}</div>
                        <div className="w-full bg-gray-800 rounded-full h-1 mt-1">
                          <div className="bg-indigo-500 h-1 rounded-full" style={{ width: `${Math.min((item.quantity || 0) * 2, 100)}%` }}></div>
                        </div>
                      </td>

                      {/* Actions */}
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <a
                          href={item.wmUrl || "https://white.market/"}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex text-indigo-400 hover:text-indigo-300 bg-indigo-900/20 p-2 rounded-lg hover:bg-indigo-900/40 transition-colors"
                          title="Open on White.Market"
                        >
                          <ExternalLink size={16} />
                        </a>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="7" className="px-6 py-12 text-center text-gray-500">
                      <div className="flex flex-col items-center justify-center">
                        <Search size={48} className="text-gray-700 mb-4" />
                        <p className="text-lg font-medium">No items found</p>
                        <p className="text-sm">Try adjusting your search terms / filters</p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="bg-[#151619] px-4 py-3 border-t border-gray-800 flex items-center justify-between sm:px-6">
            <p className="text-sm text-gray-500">
              Showing <span className="font-medium text-gray-300">{processedData.length}</span> of{" "}
              <span className="font-medium text-gray-300">{items.length}</span> results
            </p>
            <button
              onClick={loadData}
              className="px-4 py-2 border border-gray-700 bg-[#1a1b1e] text-sm font-medium text-gray-300 hover:bg-[#25262b] rounded-lg"
            >
              Refresh
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
