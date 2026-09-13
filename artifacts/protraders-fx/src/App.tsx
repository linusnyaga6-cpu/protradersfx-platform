import { type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { LegacyAuthProvider, useAppAuth } from '@/auth';
import {
  ArrowUpRight,
  BarChart3,
  Bot,
  Crown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Copy,
  FileText,
  Flame,
  Gauge,
  Layers3,
  LineChart,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Upload,
  Zap,
  X,
} from 'lucide-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();
const DERIV_REFERRAL_URL = 'https://t.deriv.link?t=SSJBZ9FQTVP8';
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const PUBLIC_MARKET_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';

type MarketDefinition = {
  label: string;
  name: string;
  symbol: string;
  family: 'fx' | 'volatility';
};
type StreamStatus = 'connecting' | 'live' | 'closed' | 'error';
type MarketQuote = {
  status: StreamStatus;
  price: number | null;
  previousPrice: number | null;
  pipSize: number;
  ticks: number[];
  lastTickAt: number | null;
};

const ONE_SECOND_VOLATILITY_VALUES = [10, 15, 25, 30, 50, 75, 90, 100];
const R_VOLATILITY_VALUES = new Set([10, 25, 50, 75, 100]);
const VOLATILITY_DEFINITIONS: MarketDefinition[] = ONE_SECOND_VOLATILITY_VALUES.flatMap((value) => [
  { label: `VOL ${value} 1s`, name: `Volatility ${value} (1s) Index`, symbol: `1HZ${value}V`, family: 'volatility' as const },
  ...(R_VOLATILITY_VALUES.has(value)
    ? [{ label: `VOL ${value} R`, name: `Volatility ${value} R Index`, symbol: `R_${value}`, family: 'volatility' as const }]
    : []),
]);

const MARKET_DEFINITIONS: MarketDefinition[] = [
  { label: 'EUR/USD', name: 'EUR/USD', symbol: 'frxEURUSD', family: 'fx' },
  { label: 'GBP/USD', name: 'GBP/USD', symbol: 'frxGBPUSD', family: 'fx' },
  { label: 'USD/JPY', name: 'USD/JPY', symbol: 'frxUSDJPY', family: 'fx' },
  { label: 'AUD/USD', name: 'AUD/USD', symbol: 'frxAUDUSD', family: 'fx' },
  { label: 'USD/CAD', name: 'USD/CAD', symbol: 'frxUSDCAD', family: 'fx' },
  ...VOLATILITY_DEFINITIONS,
];
const DEFAULT_MARKET_LABEL = 'VOL 100 1s';
const MARKET_CACHE_KEY = 'protraders-fx:last-deriv-quotes';

function getMarketDefinition(label: string) {
  return MARKET_DEFINITIONS.find((market) => market.label === label) ?? VOLATILITY_DEFINITIONS.find((market) => market.label === DEFAULT_MARKET_LABEL)!;
}

function getVolatilityDefinition(name: string) {
  return VOLATILITY_DEFINITIONS.find((market) => market.name === name) ?? getMarketDefinition(DEFAULT_MARKET_LABEL);
}

function usePublicMarketBoard() {
  const [quotes, setQuotes] = useState<Record<string, MarketQuote>>(() => {
    let cached: Partial<Record<string, MarketQuote>> = {};
    try {
      cached = JSON.parse(window.localStorage.getItem(MARKET_CACHE_KEY) ?? '{}') as Partial<Record<string, MarketQuote>>;
    } catch {
      cached = {};
    }
    return Object.fromEntries(MARKET_DEFINITIONS.map(({ symbol }) => [
      symbol,
      cached[symbol] ?? { status: 'connecting', price: null, previousPrice: null, pipSize: 2, ticks: [], lastTickAt: null },
    ]));
  });
  useEffect(() => {
    try {
      const compact = Object.fromEntries(Object.entries(quotes).map(([symbol, quote]) => [symbol, { ...quote, ticks: quote.ticks.slice(-120) }]));
      window.localStorage.setItem(MARKET_CACHE_KEY, JSON.stringify(compact));
    } catch {
      // Storage is a convenience cache; the live stream remains the source of truth.
    }
  }, [quotes]);
  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let disposed = false;
    const liveSymbols = MARKET_DEFINITIONS.map(({ symbol }) => symbol);

    const updateQuote = (symbol: string, update: Partial<MarketQuote>) => {
      setQuotes((previous) => ({ ...previous, [symbol]: { ...previous[symbol], ...update } }));
    };

    const connect = () => {
      if (disposed) return;
      liveSymbols.forEach((symbol) => updateQuote(symbol, { status: 'connecting' }));
      socket = new WebSocket(PUBLIC_MARKET_WS);
      socket.onopen = () => {
        liveSymbols.forEach((symbol) => {
          socket?.send(JSON.stringify({ ticks_history: symbol, start: 0, end: 'latest', count: 120 }));
          socket?.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
        });
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            tick?: { quote?: number; pip_size?: number; symbol?: string };
            quote?: number;
            history?: { prices?: number[]; times?: number[] };
            error?: { code?: string; message?: string };
            echo_req?: { ticks?: string; ticks_history?: string };
          };
          const historySymbol = message.echo_req?.ticks_history;
          if (message.history && historySymbol) {
            const prices = (message.history.prices ?? []).filter((price): price is number => typeof price === 'number' && Number.isFinite(price));
            if (prices.length) {
              updateQuote(historySymbol, {
                status: 'live',
                price: prices.at(-1) ?? null,
                previousPrice: prices.at(-2) ?? prices.at(-1) ?? null,
                pipSize: message.tick?.pip_size ?? (historySymbol.startsWith('frx') ? 5 : 2),
                ticks: prices.slice(-120),
                lastTickAt: message.history.times?.at(-1) ?? null,
              });
            }
            return;
          }
          if (message.error) {
            const symbol = typeof message.echo_req?.ticks === 'string' ? message.echo_req.ticks : undefined;
            if (symbol) {
              updateQuote(symbol, {
                status: message.error.code === 'MarketIsClosed' ? 'closed' : 'error',
              });
            }
            return;
          }
          const quote = message.tick?.quote ?? message.quote;
          if (typeof quote !== 'number' || !Number.isFinite(quote)) return;
          const symbol = message.tick?.symbol;
          if (!symbol) return;
          setQuotes((previous) => {
            if (!previous[symbol]) return previous;
            return {
              ...previous,
              [symbol]: {
                ...previous[symbol],
                status: 'live',
                price: quote,
                previousPrice: previous[symbol].price ?? previous[symbol].previousPrice,
                pipSize: message.tick?.pip_size ?? 2,
                ticks: [...previous[symbol].ticks.slice(-59), quote],
                lastTickAt: Date.now(),
              },
            };
          });
        } catch {
          liveSymbols.forEach((symbol) => updateQuote(symbol, { status: 'error' }));
        }
      };
      socket.onerror = () => liveSymbols.forEach((symbol) => updateQuote(symbol, { status: 'error' }));
      socket.onclose = () => {
        if (!disposed) {
          liveSymbols.forEach((symbol) => updateQuote(symbol, { status: 'error' }));
          reconnectTimer = window.setTimeout(connect, 3000);
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  return quotes;
}

function formatMarketPrice(value: number | null, pipSize = 2) {
  return value === null ? '— —' : value.toFixed(pipSize);
}

function quoteTone(quote?: MarketQuote) {
  if (!quote || quote.price === null) return 'neutral';
  const previous = quote.previousPrice ?? quote.ticks.at(-2);
  if (previous === undefined || previous === null || quote.price === previous) return 'neutral';
  return quote.price > previous ? 'up' : 'down';
}

function quoteLastDigit(quote?: MarketQuote) {
  if (!quote || quote.price === null) return '—';
  const formatted = formatMarketPrice(quote.price, quote.pipSize);
  return formatted.replace(/\D/g, '').slice(-1) || '—';
}

type MarketAiResult = {
  definition: MarketDefinition;
  quote: MarketQuote;
  score: number;
  bias: 'RISE' | 'FALL' | 'WAIT';
};
type BulkScanResult = {
  definition: MarketDefinition;
  quote: MarketQuote;
  side: 'Even' | 'Odd' | 'Rise' | 'Fall' | 'Over' | 'Under';
  contractType: 'DIGITEVEN' | 'DIGITODD' | 'CALL' | 'PUT' | 'DIGITOVER' | 'DIGITUNDER';
  confidence: number;
  sampleSize: number;
  rationale: string;
  barrier?: number;
};

function FloatingMarketAI({ marketQuotes, draggable, openBulkScanner }: { marketQuotes: Record<string, MarketQuote>; draggable: boolean; openBulkScanner: boolean }) {
  const [open, setOpen] = useState(false);
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'complete'>('idle');
  const [liveMarketCount, setLiveMarketCount] = useState(0);
  const [position, setPosition] = useState(() => ({
    x: Math.max(16, window.innerWidth - 82),
    y: Math.max(100, window.innerHeight - 150),
  }));
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const movedRef = useRef(false);

  const clampPosition = (x: number, y: number) => ({
    x: Math.min(Math.max(12, x), Math.max(12, window.innerWidth - 68)),
    y: Math.min(Math.max(12, y), Math.max(12, window.innerHeight - 68)),
  });

  useEffect(() => {
    const handleResize = () => setPosition((current) => clampPosition(current.x, current.y));
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  useEffect(() => {
    const handleOpenRequest = () => {
      setOpen(true);
    };
    window.addEventListener('market-ai-open', handleOpenRequest);
    return () => window.removeEventListener('market-ai-open', handleOpenRequest);
  }, []);

  const scanMarkets = () => {
    setScanState('scanning');
    window.setTimeout(() => {
      setLiveMarketCount(MARKET_DEFINITIONS.filter((definition) => marketQuotes[definition.symbol]?.status === 'live').length);
      setScanState('complete');
    }, 650);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggable) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { offsetX: event.clientX - position.x, offsetY: event.clientY - position.y };
    movedRef.current = false;
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggable || !dragRef.current) return;
    const next = clampPosition(event.clientX - dragRef.current.offsetX, event.clientY - dragRef.current.offsetY);
    if (Math.abs(next.x - position.x) > 2 || Math.abs(next.y - position.y) > 2) movedRef.current = true;
    setPosition(next);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
  };

  const handleIconClick = () => {
    if (movedRef.current) {
      movedRef.current = false;
      return;
    }
    if (openBulkScanner) {
      window.dispatchEvent(new CustomEvent('bulk-ai-open'));
      return;
    }
    setOpen(true);
  };

  const panelLeft = Math.min(Math.max(12, position.x - 230), Math.max(12, window.innerWidth - 316));
  const panelTop = position.y > 320 ? position.y - 300 : position.y + 70;

  return (
    <>
      {open && (
        <section className="market-ai-panel" style={{ left: panelLeft, top: panelTop }} aria-label="Market AI scanner">
          <div className="market-ai-panel-header">
            <div><span className="market-ai-kicker">AI MARKET MATRIX</span><strong>Analysis Dashboard</strong></div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close Market AI">×</button>
          </div>
          <div className="market-ai-matrix-head">Digit Scanner <b>{scanState === 'complete' ? `${liveMarketCount} live markets` : 'Waiting for scan data...'}</b></div>
          <div className="market-ai-matrix-log">
            <span>[INFO] Authenticating AI market matrix...</span>
            <span>[OK] Synthetic stream linked</span>
            <span>[INFO] Reading digit clusters...</span>
            <span>[INFO] Signal pressure rising</span>
            <span>[INFO] Checking last digit sequence...</span>
          </div>
          <div className={`market-ai-matrix-status ${scanState === 'scanning' ? 'is-scanning' : ''}`}>
            <span>{scanState === 'complete' ? 'SCAN COMPLETE' : scanState === 'scanning' ? 'SCANNING' : 'STANDBY'}</span>
            <strong>{scanState === 'complete' ? 'Market matrix ready for bulk execution.' : 'Ready to scan for last-four digit pressure.'}</strong>
          </div>
          <button type="button" className="market-ai-scan" onClick={scanMarkets} disabled={scanState === 'scanning'}>
            <Sparkles size={14} /> {scanState === 'scanning' ? 'Scanning live markets…' : 'Scan for best market'}
          </button>
          <span className="market-ai-note">Open Bulk Trader to select the signal and execute a confirmed batch.</span>
        </section>
      )}
      <button
        type="button"
        className={`market-ai-fab ${open ? 'is-open' : ''} ${draggable && dragRef.current ? 'is-dragging' : ''} ${draggable ? 'is-draggable' : ''}`}
        style={{ left: position.x, top: position.y }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleIconClick}
        aria-label="Open Market AI scanner"
        title={draggable ? 'Drag or open AI market matrix' : 'Open AI market matrix'}
      >
        <Sparkles size={21} />
        <span>AI</span>
      </button>
    </>
  );
}

function Home() {
  const { isLoaded, isSignedIn, activeMode, balance, currency, switchMode } = useAppAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeMarket, setActiveMarket] = useState(DEFAULT_MARKET_LABEL);
  const [accountMode, setAccountMode] = useState<'DEMO' | 'REAL'>(activeMode === 'real' ? 'REAL' : 'DEMO');
  const [direction, setDirection] = useState<'RISE' | 'FALL'>('RISE');
  const [contractType, setContractType] = useState<'RISE/FALL' | 'OVER/UNDER' | 'ODD/EVEN'>('RISE/FALL');
  const [contractSide, setContractSide] = useState<'RISE' | 'FALL' | 'OVER' | 'UNDER' | 'ODD' | 'EVEN'>('RISE');
  const [stake, setStake] = useState('10');
  const [duration, setDuration] = useState('3%');
  const [takeProfitEnabled, setTakeProfitEnabled] = useState(false);
  const [reviewState, setReviewState] = useState('');
  const [activeTool, setActiveTool] = useState(() => {
    const view = new URLSearchParams(window.location.search).get('view');
    const viewLabels: Record<string, string> = {
      dashboard: 'Dashboard',
      'bot-builder': 'Bot Builder',
      'volt-ai': 'Volt AI',
      'auto-ai': 'Auto AI',
      'free-bots': 'Free Bots',
      'premium-ai-bots': 'Premium AI Bots',
      'quick-bot': 'Quick Bot',
      'signal-ai': 'Signal AI',
      'manual-trader': 'Manual Trader',
      'bulk-trader': 'Bulk Trader',
      'apex-bot': 'Apex Bot',
      'copy-trader': 'Copy Trader',
      'analysis-tools': 'Analysis Tools',
    };
    return (view && viewLabels[view]) || 'Manual Trader';
  });
  const terminalMainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const view = activeTool.toLowerCase().replace(/\s+/g, '-');
    const url = new URL(window.location.href);
    url.searchParams.set('view', view);
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    terminalMainRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [activeTool]);
  useEffect(() => {
    setAccountMode(activeMode === 'real' ? 'REAL' : 'DEMO');
  }, [activeMode]);
  const marketQuotes = usePublicMarketBoard();
  const activeDefinition = getMarketDefinition(activeMarket);
  const activeQuote = marketQuotes[activeDefinition.symbol];
  const chart = useMemo(() => {
    const values = activeQuote?.ticks.length ? activeQuote.ticks : activeQuote?.price === null ? [] : [activeQuote.price];
    if (!values.length) {
      return { path: '', fill: '', labels: ['—', '—', '—', '—', '—'], trend: 'WAITING FOR TICKS', delta: 0, lastPoint: null };
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(max - min, Math.max(max * 0.0005, 0.01));
    const path = values.map((value, index) => {
      const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 920;
      const y = 360 - ((value - min) / range) * 300;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    const delta = values[values.length - 1] - values[0];
    const lastX = values.length === 1 ? 0 : 920;
    const lastY = 360 - ((values[values.length - 1] - min) / range) * 300;
    const labels = [max, max - range * .25, max - range * .5, max - range * .75, min]
      .map((value) => formatMarketPrice(value, activeQuote?.pipSize ?? 2));
    return {
      path,
      fill: `${path} L 920 420 L 0 420 Z`,
      labels,
      trend: delta > 0 ? 'RISING' : delta < 0 ? 'FALLING' : 'FLAT',
      delta,
      lastPoint: { x: lastX, y: lastY },
    };
  }, [activeQuote]);
  if (!isLoaded) return <PublicLoadingView />;
  if (!isSignedIn) return <PublicLandingView />;

  const navItems = [
    { label: 'Dashboard', icon: Gauge },
    { label: 'Bot Builder', icon: Bot },
    { label: 'Volt AI', icon: Sparkles },
    { label: 'Auto AI', icon: Sparkles },
    { label: 'Free Bots', icon: Bot },
    { label: 'Premium AI Bots', icon: Flame },
    { label: 'Quick Bot', icon: Zap },
    { label: 'Signal AI', icon: BarChart3 },
    { label: 'Manual Trader', icon: LineChart },
    { label: 'Bulk Trader', icon: Layers3 },
    { label: 'Apex Bot', icon: Flame },
    { label: 'Copy Trader', icon: Copy },
    { label: 'Analysis Tools', icon: Search },
  ];

  function handleReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const proposalContractType = contractType === 'RISE/FALL'
      ? direction === 'RISE' ? 'CALL' : 'PUT'
      : contractType === 'OVER/UNDER'
        ? contractSide === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER'
        : contractSide === 'EVEN' ? 'DIGITEVEN' : 'DIGITODD';
    const amount = Number(stake);
    const durationTicks = Math.max(1, Number.parseInt(duration, 10) || 1);
    const barrier = contractType === 'OVER/UNDER' ? 4 : undefined;
    if (!Number.isFinite(amount) || amount < 0.35) {
      setReviewState('Enter a stake of at least USD 0.35.');
      return;
    }
    setReviewState(`Executing live ${contractSide} trade…`);
    void (async () => {
      try {
        const response = await fetch('/api/deriv/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: activeDefinition.symbol,
            contractType: proposalContractType,
            amount,
            duration: durationTicks,
            durationUnit: 't',
            currency: 'USD',
            barrier,
            mode: accountMode.toLowerCase(),
            confirm: true,
          }),
        });
        const payload = await response.json() as { error?: string; trade?: { contractId?: string | number; buyPrice?: number; currency?: string } };
        if (!response.ok || !payload.trade) throw new Error(payload.error ?? 'Deriv did not execute the contract.');
        setReviewState(`${contractSide} live trade opened · contract ${payload.trade.contractId ?? 'confirmed'} · buy ${payload.trade.buyPrice ?? '—'} ${payload.trade.currency ?? 'USD'}`);
      } catch (error) {
        setReviewState(error instanceof Error ? error.message : 'Unable to execute the Deriv contract.');
      }
    })();
  }

  async function handleAccountMode(nextMode: 'DEMO' | 'REAL') {
    setAccountMode(nextMode);
    try {
      await switchMode(nextMode.toLowerCase() as 'demo' | 'real');
    } catch (error) {
      setAccountMode(accountMode);
      setReviewState(error instanceof Error ? error.message : `Unable to switch to ${nextMode} mode.`);
    }
  }

  return (
    <div className={`terminal-shell ${activeTool === 'Manual Trader' ? 'is-manual-mode' : ''} ${activeTool === 'Dashboard' ? 'is-dashboard-mode' : ''} ${['Bot Builder', 'Free Bots', 'Premium AI Bots', 'Bulk Trader', 'Quick Bot', 'Analysis Tools', 'Volt AI', 'Auto AI', 'Signal AI', 'Apex Bot', 'Copy Trader'].includes(activeTool) ? 'is-reference-mode' : ''}`}>
      <header className="terminal-header">
        <a href={basePath || '/'} className="terminal-brand" aria-label="ProTraders FX home">
          <span className="terminal-brand-mark"><BarChart3 size={17} /></span>
          <span><strong>PROTRADERS FX</strong><small>POWERED BY DERIV</small></span>
        </a>
        <div className="terminal-header-actions">
          <a href={`${basePath}/account`} className="terminal-header-link"><FileText size={13} /> Reports</a>
          <div className="account-switcher">
            <button type="button" className={accountMode === 'DEMO' ? 'is-selected' : ''} onClick={() => void handleAccountMode('DEMO')}>DEMO</button>
            <button type="button" className={accountMode === 'REAL' ? 'is-selected' : ''} onClick={() => void handleAccountMode('REAL')}>REAL</button>
          </div>
          <div className="terminal-balance"><CircleDollarSign size={15} /><strong>{balance === null ? '—' : `${currency} ${balance.toFixed(2)}`}</strong><ChevronDown size={13} /></div>
          <a href={`${basePath}/account`} className="account-button">Account</a>
          <a href={DERIV_REFERRAL_URL} target="_blank" rel="noopener noreferrer" className="get-started">Get Started</a>
          <button type="button" className="terminal-mobile-toggle" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label="Toggle trading navigation">
            {mobileMenuOpen ? <X size={19} /> : <Menu size={19} />}
          </button>
        </div>
      </header>

      <nav className={`terminal-nav ${mobileMenuOpen ? 'is-open' : ''}`} aria-label="Trading products" role="tablist">
        <div className="terminal-nav-scroll">
          {navItems.map(({ label, icon: Icon }) => (
            <button key={label} type="button" role="tab" aria-selected={activeTool === label} className={`terminal-nav-item ${activeTool === label ? 'is-active' : ''}`} onClick={() => { setActiveTool(label); setMobileMenuOpen(false); }}>
              <Icon size={13} /> <span>{label}</span>
            </button>
          ))}
        </div>
      </nav>

      <div className="market-strip" aria-label="Markets">
        <div className="market-live"><i /> LIVE</div>
        {MARKET_DEFINITIONS.map(({ label, symbol }) => {
          const quote = marketQuotes[symbol];
          return (
          <button key={label} type="button" className={`market-tab ${activeMarket === label ? 'is-active' : ''} ${quote?.status === 'live' ? 'is-live' : ''}`} onClick={() => setActiveMarket(label)}>
            <span>{label}</span><small className={`market-price ${quoteTone(quote)}`}>{formatMarketPrice(quote?.price ?? null, quote?.pipSize ?? 2)} <b>{quoteLastDigit(quote)}</b></small>
          </button>
          );
        })}
      </div>

      <main ref={terminalMainRef} id="trading-workspace-panel" className={`terminal-main ${activeTool === 'Manual Trader' ? 'manual-main' : ''}`} role="tabpanel" aria-label={`${activeTool} workspace`}>
        {activeTool === 'Dashboard' ? <DashboardView accountMode={accountMode} marketQuotes={marketQuotes} onNavigate={setActiveTool} /> : activeTool === 'Quick Bot' ? <QuickBotView activeMarket={activeMarket} marketQuotes={marketQuotes} onNavigate={setActiveTool} /> : activeTool === 'Bulk Trader' ? <BulkTraderView accountMode={accountMode} activeMarket={activeMarket} setActiveMarket={setActiveMarket} marketQuotes={marketQuotes} /> : activeTool === 'Analysis Tools' ? <AnalysisToolsView marketQuotes={marketQuotes} /> : activeTool === 'Volt AI' ? <VoltAiView activeMarket={activeMarket} setActiveMarket={setActiveMarket} marketQuotes={marketQuotes} onNavigate={setActiveTool} /> : activeTool === 'Auto AI' ? <AutoAiView activeMarket={activeMarket} setActiveMarket={setActiveMarket} marketQuotes={marketQuotes} onNavigate={setActiveTool} /> : activeTool === 'Signal AI' ? <SignalAiView activeMarket={activeMarket} setActiveMarket={setActiveMarket} marketQuotes={marketQuotes} onNavigate={setActiveTool} /> : activeTool === 'Apex Bot' ? <ApexBotView activeMarket={activeMarket} setActiveMarket={setActiveMarket} marketQuotes={marketQuotes} /> : activeTool === 'Copy Trader' ? <CopyTraderView activeMarket={activeMarket} marketQuotes={marketQuotes} /> : activeTool === 'Free Bots' ? <FreeBotsView accountMode={accountMode} activeMarket={activeMarket} marketQuotes={marketQuotes} /> : activeTool === 'Bot Builder' ? <RecoveryBotView accountMode={accountMode} activeMarket={activeMarket} marketQuotes={marketQuotes} /> : activeTool === 'Premium AI Bots' ? <PremiumBotsExcludedView onNavigate={setActiveTool} /> : activeTool === 'Manual Trader' ? (
        <>
        <div className="terminal-heading">
          <div>
            <p className="terminal-eyebrow">MANUAL TRADER</p>
            <h1>Execute with control</h1>
            <p>Choose a live market, select {contractType}, and send a verified Deriv proposal.</p>
          </div>
          <span className="mode-badge">{accountMode} MODE</span>
        </div>

        <div className="trading-workspace">
          <section className="chart-card" aria-label="Market chart">
            <div className="chart-card-header">
              <div className="manual-market-picker">
                <span className="chart-label">SELECTED MARKET / VOLATILITY</span>
                <select value={activeMarket} onChange={(event) => setActiveMarket(event.target.value)} aria-label="Select market">
                  <optgroup label="Forex">
                    {MARKET_DEFINITIONS.filter(({ family }) => family === 'fx').map(({ label, name }) => <option key={label} value={label}>{name}</option>)}
                  </optgroup>
                  <optgroup label="Volatility">
                    {MARKET_DEFINITIONS.filter(({ family }) => family === 'volatility').map(({ label, name }) => <option key={label} value={label}>{name}</option>)}
                  </optgroup>
                </select>
              </div>
              <div className="chart-tools">
                <button type="button" aria-label="Previous market"><ChevronLeft size={15} /></button>
                <span className={`chart-status status-${activeQuote?.status ?? 'connecting'} quote-${quoteTone(activeQuote)}`}><i /> {activeQuote?.status === 'live' ? 'Live feed' : activeQuote?.status === 'error' ? 'Reconnecting' : 'Last quote'}</span>
                <button type="button" aria-label="Chart settings"><Settings2 size={15} /></button>
              </div>
            </div>
            <div className="chart-stage">
              <div className="chart-grid" />
              <div className="chart-y-labels">{chart.labels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div>
               <svg viewBox="0 0 920 420" preserveAspectRatio="none" className="market-chart" role="img" aria-label={`${activeDefinition.name} live market chart`}>
                <defs>
                  <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="#8c989d" stopOpacity=".25" />
                    <stop offset="100%" stopColor="#8c989d" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {chart.fill && <path d={chart.fill} fill="url(#chart-fill)" />}
                 {chart.path && <path d={chart.path} fill="none" stroke="#4d555a" strokeWidth="2.2" />}
                 {chart.lastPoint && <circle cx={chart.lastPoint.x} cy={chart.lastPoint.y} r="5" fill="#1aa5b8" />}
              </svg>
              {activeQuote?.price !== null && <div className="price-tag">{formatMarketPrice(activeQuote?.price ?? null, activeQuote?.pipSize ?? 2)}</div>}
              {!chart.path && <div className="chart-empty-state">{activeQuote?.status === 'error' ? 'RECONNECTING TO MARKET' : 'WAITING FOR PRICE FEED'}</div>}
              <div className="chart-time-labels"><span>11:02:40</span><span>11:02:50</span><span>11:03:00</span><span>11:03:10</span><span>11:03:20</span></div>
              <div className="chart-rail" aria-label="Chart tools">
                <button type="button" aria-label="Chart type"><LineChart size={15} /></button>
                <button type="button" aria-label="Indicators"><BarChart3 size={15} /></button>
                <button type="button" aria-label="Drawing tools"><Settings2 size={15} /></button>
              </div>
            </div>
            <div className="chart-footer">
              <span><i className={activeQuote?.status === 'live' ? 'positive-dot' : 'status-dot-muted'} /> {activeQuote?.status === 'live' ? 'Live market feed' : 'Last quote available'}</span>
              <span>Tick stream · 1s</span>
              <span>{chart.trend} {activeQuote?.ticks.length ? `· ${Math.abs(chart.delta).toFixed(activeQuote.pipSize)} move` : ''}</span>
            </div>
          </section>

          <form className="trade-ticket" onSubmit={handleReview}>
            <div className="trade-ticket-header">
              <div><span className="chart-label">TRADE TICKET</span><h2>{contractType.replace('/', ' / ')}</h2></div>
              <span className="ticket-mode">{accountMode} MODE</span>
            </div>
             <div className="ticket-body manual-contract-body">
              <div className="manual-contract-help">Select market and contract type <span>ⓘ</span></div>
               <div className="manual-contract-card"><button type="button" aria-label="Previous contract">‹</button><span><strong>▰ Accumulators</strong><small>Growth contracts</small></span><button type="button" aria-label="Next contract">›</button></div>
               <div className="contract-type-tabs" aria-label="Contract type">
                 {(['RISE/FALL', 'OVER/UNDER', 'ODD/EVEN'] as const).map((type) => (
                   <button key={type} type="button" className={contractType === type ? 'is-selected' : ''} onClick={() => {
                     setContractType(type);
                     setContractSide(type === 'RISE/FALL' ? direction : type === 'OVER/UNDER' ? 'OVER' : 'EVEN');
                   }}>{type}</button>
                 ))}
               </div>
               <div className="manual-direction-tabs" aria-label={`${contractType} selection`}>
                 {(contractType === 'RISE/FALL' ? ['RISE', 'FALL'] : contractType === 'OVER/UNDER' ? ['OVER', 'UNDER'] : ['ODD', 'EVEN']).map((side) => (
                   <button key={side} type="button" className={contractSide === side ? `is-selected ${side === 'FALL' || side === 'UNDER' || side === 'ODD' ? 'is-fall' : ''}` : ''} onClick={() => {
                     setContractSide(side as typeof contractSide);
                     if (side === 'RISE' || side === 'FALL') setDirection(side);
                   }}>{side} <small>{contractType === 'RISE/FALL' ? (side === 'RISE' ? 'CALL' : 'PUT') : 'SELECT'}</small></button>
                 ))}
               </div>
               <label className="field-label" htmlFor="growth-rate">GROWTH RATE <span>ⓘ</span></label>
               <div className="growth-rate-grid" id="growth-rate">
                 {[1, 2, 3, 4, 5].map((rate) => <button key={rate} type="button" className={duration === `${rate}%` ? 'is-selected' : ''} onClick={() => setDuration(`${rate}%`)}>{rate}%</button>)}
               </div>
               <label className="field-label" htmlFor="stake">STAKE</label>
               <div className="manual-number-row"><button type="button" onClick={() => setStake(String(Math.max(1, Number(stake || 0) - 1)))} aria-label="Decrease stake">−</button><input id="stake" inputMode="decimal" value={stake} onChange={(event) => setStake(event.target.value)} /><span>USD</span><button type="button" onClick={() => setStake(String(Number(stake || 0) + 1))} aria-label="Increase stake">+</button><button type="button" className="manual-direction-button" onClick={() => {
                 const options = contractType === 'RISE/FALL' ? ['RISE', 'FALL'] : contractType === 'OVER/UNDER' ? ['OVER', 'UNDER'] : ['ODD', 'EVEN'];
                 const next = options[(options.indexOf(contractSide) + 1) % options.length] as typeof contractSide;
                 setContractSide(next);
                 if (next === 'RISE' || next === 'FALL') setDirection(next);
               }} aria-label="Toggle contract side">‹›</button></div>
               <label className="manual-check"><input type="checkbox" checked={takeProfitEnabled} onChange={(event) => setTakeProfitEnabled(event.target.checked)} /> <span>Take profit</span><small>ⓘ</small></label>
               <div className="manual-contract-stats"><span><strong>Max. payout</strong><b>{stake ? `${(Number(stake) * 600).toFixed(2)} USD` : '—'}</b></span><span><strong>Max. ticks</strong><b>85 ticks</b></span></div>
                <button type="submit" className="review-button manual-buy-button"><span>BUY LIVE</span><ChevronRight size={17} /></button>
                <p className="live-execution-warning">Live execution is enabled for {accountMode} mode. Review the risk icon in the dashboard before trading.</p>
               {reviewState && <p className="review-state" role="status">{reviewState}</p>}
            </div>
          </form>
        </div>
        </>
        ) : <ToolPlaceholderView title={activeTool} />}
      </main>

      <footer className="terminal-footer">
        <button type="button" className="risk-warning" title="Risk disclaimer: trading carries risk. Check the selected account mode before execution." aria-label="Open risk disclaimer">⚠</button>
        <span className="footer-brand">PROTRADERS FX · POWERED BY DERIV</span>
      </footer>
      <FloatingMarketAI marketQuotes={marketQuotes} draggable openBulkScanner={activeTool === 'Bulk Trader'} />
    </div>
  );
}

function ToolPlaceholderView({ title }: { title: string }) {
  const subtitle = title === 'Premium AI Bots'
    ? 'Premium strategy workspace'
    : title === 'Volt AI' || title === 'Auto AI' || title === 'Signal AI'
      ? 'Signal and automation workspace'
      : 'Trading workspace';
  return (
    <section className="tool-placeholder-view">
      <div className="tool-placeholder-heading">
        <span className="terminal-eyebrow">{subtitle.toUpperCase()}</span>
        <h1>{title}</h1>
        <p>This workspace opens as its own tab. Select another tool above to switch without scrolling through a long page.</p>
      </div>
      <div className="tool-placeholder-tabs"><span className="is-active">Overview</span><span>Live data</span><span>Settings</span></div>
      <div className="tool-placeholder-grid">
        <article><strong>Focused workspace</strong><p>Keep this tool separate from the rest of the trading desk and return to the same tab when you need it.</p></article>
        <article><strong>Official Deriv feed</strong><p>Live market context remains available in the market rail above every workspace.</p></article>
        <article><strong>Review before execution</strong><p>Actions stay review-only until a proposal is explicitly requested and confirmed.</p></article>
      </div>
    </section>
  );
}

function clampSignalScore(value: number) {
  return Math.max(18, Math.min(92, Math.round(value)));
}

function getMarketSignal(definition: MarketDefinition, quote?: MarketQuote) {
  const lastDigit = Number(quoteLastDigit(quote));
  const recent = quote?.ticks.slice(-24) ?? [];
  const first = recent[0] ?? quote?.price ?? 0;
  const last = recent.at(-1) ?? first;
  const direction = last > first ? 1 : last < first ? -1 : 0;
  const digitBias = Number.isFinite(lastDigit) ? (lastDigit - 4.5) * 3.2 : 0;
  const score = clampSignalScore(56 + direction * 13 + digitBias);
  return {
    definition,
    quote,
    score,
    bias: score >= 62 ? 'RISE' : score <= 42 ? 'FALL' : 'WAIT',
    lastDigit: Number.isFinite(lastDigit) ? String(lastDigit) : '—',
  } as const;
}

function StrategySignalCard({ signal, selected, onSelect }: { signal: ReturnType<typeof getMarketSignal>; selected?: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`strategy-signal-card ${selected ? 'is-selected' : ''}`} onClick={onSelect}>
      <span className="strategy-signal-top"><strong>{signal.definition.label}</strong><small>{signal.quote?.status === 'live' ? 'LIVE' : 'LAST QUOTE'}</small></span>
      <b className={`strategy-signal-bias bias-${signal.bias.toLowerCase()}`}>{signal.bias}</b>
      <span className="strategy-signal-price">{formatMarketPrice(signal.quote?.price ?? null, signal.quote?.pipSize ?? 2)} <i>digit {signal.lastDigit}</i></span>
      <span className="strategy-signal-meter"><i style={{ width: `${signal.score}%` }} /></span>
      <small className="strategy-signal-score">{signal.score}% confidence <ChevronRight size={13} /></small>
    </button>
  );
}

function VoltAiView({ activeMarket, setActiveMarket, marketQuotes, onNavigate }: { activeMarket: string; setActiveMarket: (market: string) => void; marketQuotes: Record<string, MarketQuote>; onNavigate: (tool: string) => void }) {
  const [mode, setMode] = useState('Momentum scan');
  const [scanState, setScanState] = useState<'ready' | 'scanning' | 'complete'>('ready');
  const [selectedMarket, setSelectedMarket] = useState(activeMarket);
  const [reviewState, setReviewState] = useState('');
  const signals = useMemo(() => VOLATILITY_DEFINITIONS.slice(0, 8).map((definition) => getMarketSignal(definition, marketQuotes[definition.symbol])), [marketQuotes]);
  const selectedSignal = signals.find((signal) => signal.definition.label === selectedMarket) ?? signals[0];

  const scan = () => {
    setScanState('scanning');
    window.setTimeout(() => setScanState('complete'), 550);
  };

  return (
    <section className="strategy-workspace volt-ai-workspace">
      <div className="strategy-workspace-main">
        <header className="strategy-workspace-header">
          <div><span className="terminal-eyebrow">VOLT AI · LIVE SCANNER</span><h1>Find the cleanest market setup</h1><p>Rank official Deriv volatility markets using live tick momentum and digit context before you review a trade.</p></div>
          <span className="strategy-status-pill"><i /> {scanState === 'scanning' ? 'SCANNING' : scanState === 'complete' ? 'SCAN UPDATED' : 'READY TO SCAN'}</span>
        </header>
        <div className="strategy-control-bar">
          <label><span>SCAN MODE</span><select value={mode} onChange={(event) => setMode(event.target.value)}><option>Momentum scan</option><option>Digit pressure</option><option>Quiet market filter</option></select></label>
          <label><span>FOCUS MARKET</span><select value={selectedMarket} onChange={(event) => { setSelectedMarket(event.target.value); setActiveMarket(event.target.value); }}>{signals.map(({ definition }) => <option key={definition.label} value={definition.label}>{definition.name}</option>)}</select></label>
          <button type="button" className="strategy-primary-button" onClick={scan} disabled={scanState === 'scanning'}>{scanState === 'scanning' ? 'Scanning…' : 'Run live scan'} <Sparkles size={14} /></button>
        </div>
        <div className="strategy-signal-grid">{signals.map((signal) => <StrategySignalCard key={signal.definition.symbol} signal={signal} selected={signal.definition.label === selectedSignal?.definition.label} onSelect={() => { setSelectedMarket(signal.definition.label); setActiveMarket(signal.definition.label); }} />)}</div>
      </div>
      <aside className="strategy-side-panel">
        <div className="strategy-side-kicker">SELECTED SIGNAL</div>
        <h2>{selectedSignal?.definition.name ?? 'Waiting for feed'}</h2>
        <div className={`strategy-side-bias bias-${selectedSignal?.bias.toLowerCase() ?? 'wait'}`}>{selectedSignal?.bias ?? 'WAIT'} <b>{selectedSignal?.score ?? 0}%</b></div>
        <p>Volt AI uses the current tick stream as decision support. Review the market in Manual Trader before requesting a proposal.</p>
        <button type="button" className="strategy-secondary-button" onClick={() => onNavigate('Manual Trader')}>Review in Manual Trader <ChevronRight size={14} /></button>
        {reviewState && <span className="strategy-review-state" role="status">{reviewState}</span>}
        <button type="button" className="strategy-link-button" onClick={() => setReviewState(`Signal saved for ${selectedSignal?.definition.label ?? 'selected market'}.`)}>Save signal for review</button>
      </aside>
    </section>
  );
}

function AutoAiView({ activeMarket, setActiveMarket, marketQuotes, onNavigate }: { activeMarket: string; setActiveMarket: (market: string) => void; marketQuotes: Record<string, MarketQuote>; onNavigate: (tool: string) => void }) {
  const [running, setRunning] = useState(false);
  const [riskMode, setRiskMode] = useState('Balanced');
  const [stake, setStake] = useState('1');
  const [takeProfit, setTakeProfit] = useState('10');
  const [stopLoss, setStopLoss] = useState('5');
  const [reviewState, setReviewState] = useState('');
  const definition = getMarketDefinition(activeMarket);
  const quote = marketQuotes[definition.symbol];

  const toggleReviewLoop = () => {
    setRunning((current) => !current);
    setReviewState(running ? 'Auto AI review loop paused. No contract was purchased.' : `Auto AI review loop armed for ${definition.label}. Review-only mode is active.`);
  };

  return (
    <section className="strategy-workspace auto-ai-workspace">
      <div className="strategy-workspace-main">
        <header className="strategy-workspace-header">
          <div><span className="terminal-eyebrow">AUTO AI · REVIEW LOOP</span><h1>Automate the routine, keep the decision</h1><p>Set the market, risk guardrails, and signal cadence. Auto AI will keep a review queue ready without placing trades.</p></div>
          <span className={`strategy-status-pill ${running ? 'is-active' : ''}`}><i /> {running ? 'REVIEW LOOP ON' : 'REVIEW LOOP OFF'}</span>
        </header>
        <form className="strategy-settings-grid" onSubmit={(event) => { event.preventDefault(); setReviewState(`Auto AI settings saved · ${stake} USD stake · ${riskMode} risk.`); }}>
          <label><span>MARKET</span><select value={activeMarket} onChange={(event) => setActiveMarket(event.target.value)}>{MARKET_DEFINITIONS.map(({ label, name }) => <option key={label} value={label}>{name}</option>)}</select></label>
          <label><span>RISK PROFILE</span><select value={riskMode} onChange={(event) => setRiskMode(event.target.value)}><option>Conservative</option><option>Balanced</option><option>Fast review</option></select></label>
          <label><span>STAKE</span><input inputMode="decimal" value={stake} onChange={(event) => setStake(event.target.value)} /></label>
          <label><span>TAKE PROFIT</span><input inputMode="decimal" value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} /></label>
          <label><span>STOP LOSS</span><input inputMode="decimal" value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} /></label>
          <button type="submit" className="strategy-secondary-button">Save guardrails <Settings2 size={14} /></button>
        </form>
        <div className="auto-ai-monitor">
          <div><span className="strategy-card-kicker">CURRENT MARKET</span><strong>{definition.name}</strong><b>{formatMarketPrice(quote?.price ?? null, quote?.pipSize ?? 2)}</b><small>{quote?.status === 'live' ? '● LIVE TICK STREAM' : 'LAST QUOTE AVAILABLE'}</small></div>
          <div><span className="strategy-card-kicker">NEXT REVIEW</span><strong>{running ? 'Monitoring now' : 'Not scheduled'}</strong><small>{running ? 'Signal queue updates with each tick.' : 'Arm the review loop to begin.'}</small></div>
          <div><span className="strategy-card-kicker">SAFETY LIMITS</span><strong>{takeProfit || '0'} / {stopLoss || '0'} USD</strong><small>Take profit / stop loss</small></div>
        </div>
      </div>
      <aside className="strategy-side-panel">
        <div className="strategy-side-kicker">AUTO AI CONTROL</div>
        <h2>{running ? 'Review loop is active' : 'Review loop is ready'}</h2>
        <p>Auto AI does not connect a personal Deriv account or execute contracts. It prepares the next market review from the public feed.</p>
        <button type="button" className={`strategy-primary-button ${running ? 'is-danger' : ''}`} onClick={toggleReviewLoop}>{running ? 'Pause review loop' : 'Start review loop'} <Zap size={14} /></button>
        <button type="button" className="strategy-secondary-button" onClick={() => onNavigate('Analysis Tools')}>Open Analysis Tools <ChevronRight size={14} /></button>
        {reviewState && <span className="strategy-review-state" role="status">{reviewState}</span>}
      </aside>
    </section>
  );
}

function SignalAiView({ activeMarket, setActiveMarket, marketQuotes, onNavigate }: { activeMarket: string; setActiveMarket: (market: string) => void; marketQuotes: Record<string, MarketQuote>; onNavigate: (tool: string) => void }) {
  const [filter, setFilter] = useState('All signals');
  const [selectedSignal, setSelectedSignal] = useState<string | null>(null);
  const [reviewState, setReviewState] = useState('');
  const signals = useMemo(() => VOLATILITY_DEFINITIONS.slice(0, 10).map((definition) => getMarketSignal(definition, marketQuotes[definition.symbol])), [marketQuotes]);
  const visibleSignals = signals.filter((signal) => filter === 'All signals' || signal.bias === filter.toUpperCase());
  const selected = signals.find((signal) => signal.definition.label === selectedSignal) ?? visibleSignals[0];

  return (
    <section className="strategy-workspace signal-ai-workspace">
      <div className="strategy-workspace-main">
        <header className="strategy-workspace-header">
          <div><span className="terminal-eyebrow">SIGNAL AI · SIGNAL DESK</span><h1>Review signals as they arrive</h1><p>Filter the public Deriv tick stream by direction and send a selected setup into the correct review workspace.</p></div>
          <span className="strategy-status-pill"><i /> {visibleSignals.length} SIGNALS</span>
        </header>
        <div className="strategy-filter-bar">
          {['All signals', 'Rise', 'Fall', 'Wait'].map((item) => <button key={item} type="button" className={filter === item ? 'is-selected' : ''} onClick={() => setFilter(item)}>{item}</button>)}
          <span>Updated from live market ticks</span>
        </div>
        <div className="signal-feed">
          {visibleSignals.map((signal) => (
            <button type="button" key={signal.definition.symbol} className={`signal-feed-row ${selected?.definition.symbol === signal.definition.symbol ? 'is-selected' : ''}`} onClick={() => { setSelectedSignal(signal.definition.label); setActiveMarket(signal.definition.label); }}>
              <span className="signal-feed-market"><strong>{signal.definition.label}</strong><small>{signal.definition.name}</small></span>
              <span className={`strategy-signal-bias bias-${signal.bias.toLowerCase()}`}>{signal.bias}</span>
              <span className="signal-feed-price">{formatMarketPrice(signal.quote?.price ?? null, signal.quote?.pipSize ?? 2)}</span>
              <span className="signal-feed-score">{signal.score}%</span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
      </div>
      <aside className="strategy-side-panel">
        <div className="strategy-side-kicker">SIGNAL REVIEW</div>
        <h2>{selected?.definition.label ?? 'Select a signal'}</h2>
        <div className={`strategy-side-bias bias-${selected?.bias.toLowerCase() ?? 'wait'}`}>{selected?.bias ?? 'WAIT'} <b>{selected?.score ?? 0}%</b></div>
        <p>Selected signals remain review-only. Use Analysis Tools for digit context or Manual Trader for a contract proposal review.</p>
        <button type="button" className="strategy-secondary-button" onClick={() => onNavigate('Analysis Tools')}>Open analysis <BarChart3 size={14} /></button>
        <button type="button" className="strategy-primary-button" onClick={() => onNavigate('Manual Trader')}>Review trade setup <ChevronRight size={14} /></button>
        <button type="button" className="strategy-link-button" onClick={() => setReviewState(`${selected?.definition.label ?? 'Signal'} added to review queue.`)}>Add to review queue</button>
        {reviewState && <span className="strategy-review-state" role="status">{reviewState}</span>}
      </aside>
    </section>
  );
}

function ApexBotView({ activeMarket, setActiveMarket, marketQuotes }: { activeMarket: string; setActiveMarket: (market: string) => void; marketQuotes: Record<string, MarketQuote> }) {
  const [stake, setStake] = useState('1');
  const [takeProfit, setTakeProfit] = useState('10');
  const [stopLoss, setStopLoss] = useState('5');
  const [strategy, setStrategy] = useState('Digits momentum');
  const definition = getMarketDefinition(activeMarket);
  const quote = marketQuotes[definition.symbol];
  const ticks = quote?.ticks.slice(-120) ?? [];
  const latestTick = ticks.at(-1) ?? null;
  const firstTick = ticks[0] ?? latestTick;
  const latestDigit = latestTick === null ? '—' : formatMarketPrice(latestTick, quote?.pipSize ?? 2).replace(/\D/g, '').slice(-1);
  const momentum = firstTick !== null && latestTick !== null && latestTick !== firstTick ? latestTick > firstTick ? 'RISING' : 'FALLING' : 'FLAT';
  const evenCount = ticks.reduce((total, tick) => {
    const digit = Number(formatMarketPrice(tick, quote?.pipSize ?? 2).replace(/\D/g, '').slice(-1));
    return total + (digit % 2 === 0 ? 1 : 0);
  }, 0);
  const evenProbability = ticks.length ? (evenCount / ticks.length) * 100 : 0;
  const confidence = ticks.length ? Math.max(evenProbability, 100 - evenProbability) : 0;
  const resultLabel = strategy === 'Rise / Fall trend' ? momentum : strategy === 'Over / Under pressure' ? (latestDigit !== '—' && Number(latestDigit) > 4 ? 'OVER' : 'UNDER') : evenProbability >= 50 ? 'EVEN' : 'ODD';

  return (
    <section className="strategy-workspace apex-bot-workspace">
      <div className="strategy-workspace-main">
        <header className="strategy-workspace-header">
          <div><span className="terminal-eyebrow">APEX BOT · RESULTS</span><h1>See the latest bot result</h1><p>Configure a compact strategy and view its live result snapshot as official Deriv ticks arrive.</p></div>
          <span className="strategy-status-pill is-active"><i /> RESULTS LIVE</span>
        </header>
        <div className="apex-bot-grid">
          <section className="strategy-config-card">
            <div className="strategy-card-heading"><span className="strategy-card-kicker">BOT CONFIGURATION</span><strong>Core parameters</strong></div>
            <label><span>MARKET</span><select value={activeMarket} onChange={(event) => setActiveMarket(event.target.value)}>{MARKET_DEFINITIONS.map(({ label, name }) => <option key={label} value={label}>{name}</option>)}</select></label>
            <label><span>STRATEGY</span><select value={strategy} onChange={(event) => setStrategy(event.target.value)}><option>Digits momentum</option><option>Rise / Fall trend</option><option>Over / Under pressure</option></select></label>
            <div className="strategy-two-column">
              <label><span>STAKE</span><input inputMode="decimal" value={stake} onChange={(event) => setStake(event.target.value)} /></label>
              <label><span>TAKE PROFIT</span><input inputMode="decimal" value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} /></label>
            </div>
            <label><span>STOP LOSS</span><input inputMode="decimal" value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} /></label>
            <div className="apex-results-callout"><span>RESULT</span><strong>{resultLabel}</strong><small>{confidence.toFixed(1)}% confidence · {ticks.length} ticks analyzed</small></div>
          </section>
          <section className="apex-bot-preview">
            <div className="strategy-card-heading"><span className="strategy-card-kicker">LIVE CONTEXT</span><strong>{definition.name}</strong></div>
            <div className="apex-price">{formatMarketPrice(quote?.price ?? null, quote?.pipSize ?? 2)} <small>{quote?.status === 'live' ? 'LIVE' : 'LAST QUOTE'}</small></div>
            <div className="apex-mini-chart">{(quote?.ticks.slice(-28) ?? []).map((tick, index, values) => <i key={`${tick}-${index}`} style={{ height: `${20 + ((tick - Math.min(...values)) / Math.max(Math.max(...values) - Math.min(...values), .0001)) * 68}%` }} />)}</div>
            <div className="apex-stat-row"><span>Strategy<strong>{strategy}</strong></span><span>Last digit<strong>{latestDigit}</strong></span><span>Mode<strong>Results only</strong></span></div>
          </section>
        </div>
        <section className="apex-results-panel">
          <div className="strategy-card-heading"><span className="strategy-card-kicker">APEX RESULT SNAPSHOT</span><strong>What the bot sees now</strong></div>
          <div className="apex-results-grid">
            <div><span>Signal</span><strong>{resultLabel}</strong><small>Derived from the current strategy</small></div>
            <div><span>Momentum</span><strong>{momentum}</strong><small>First tick versus latest tick</small></div>
            <div><span>Even probability</span><strong>{evenProbability.toFixed(1)}%</strong><small>{evenCount} of {ticks.length || 0} recent digits</small></div>
            <div><span>Last digit</span><strong>{latestDigit}</strong><small>Latest official quote</small></div>
          </div>
        </section>
      </div>
      <aside className="strategy-side-panel">
        <div className="strategy-side-kicker">APEX RESULTS</div>
        <h2>Results are ready</h2>
        <p>Clicking Apex Bot shows the current result snapshot immediately. It does not start a review loop or purchase a contract.</p>
        <div className="strategy-check-list"><span>✓ Official tick context</span><span>✓ Live result snapshot</span><span>✓ No automatic execution</span></div>
        <button type="button" className="strategy-secondary-button" onClick={() => window.dispatchEvent(new Event('market-ai-open'))}>Open Market AI <Sparkles size={14} /></button>
      </aside>
    </section>
  );
}

function CopyTraderView({ activeMarket, marketQuotes }: { activeMarket: string; marketQuotes: Record<string, MarketQuote> }) {
  const [leader, setLeader] = useState('Atlas Momentum');
  const [allocation, setAllocation] = useState('10');
  const [maxDaily, setMaxDaily] = useState('25');
  const [copyEnabled, setCopyEnabled] = useState(false);
  const [reviewState, setReviewState] = useState('');
  const definition = getMarketDefinition(activeMarket);
  const quote = marketQuotes[definition.symbol];
  const leaders = [
    { name: 'Atlas Momentum', style: 'Trend review', winRate: '68%', risk: 'Balanced', markets: 'Volatility 75 / 100' },
    { name: 'Digit Compass', style: 'Digit review', winRate: '61%', risk: 'Measured', markets: 'Volatility 10 / 25' },
    { name: 'East Africa FX', style: 'Forex review', winRate: '57%', risk: 'Conservative', markets: 'EUR/USD · GBP/USD' },
  ];
  const selectedLeader = leaders.find((item) => item.name === leader) ?? leaders[0];

  return (
    <section className="strategy-workspace copy-trader-workspace">
      <div className="strategy-workspace-main">
        <header className="strategy-workspace-header">
          <div><span className="terminal-eyebrow">COPY TRADER · REVIEW NETWORK</span><h1>Follow a strategy with clear limits</h1><p>Compare strategy profiles, set an allocation cap, and review what copying would mean before any account connection is enabled.</p></div>
          <span className={`strategy-status-pill ${copyEnabled ? 'is-active' : ''}`}><i /> {copyEnabled ? 'REVIEW COPY ON' : 'NOT CONNECTED'}</span>
        </header>
        <div className="copy-leader-grid">
          {leaders.map((item) => <button type="button" key={item.name} className={`copy-leader-card ${leader === item.name ? 'is-selected' : ''}`} onClick={() => setLeader(item.name)}><span className="copy-avatar">{item.name.slice(0, 2).toUpperCase()}</span><strong>{item.name}</strong><small>{item.style}</small><b>{item.winRate}</b><em>{item.risk} · {item.markets}</em></button>)}
        </div>
        <div className="copy-settings">
          <div><span className="strategy-card-kicker">SELECTED PROFILE</span><strong>{selectedLeader.name}</strong><small>{selectedLeader.style} · {selectedLeader.winRate} reviewed win rate</small></div>
          <label><span>ALLOCATION USD</span><input inputMode="decimal" value={allocation} onChange={(event) => setAllocation(event.target.value)} /></label>
          <label><span>MAX DAILY RISK</span><input inputMode="decimal" value={maxDaily} onChange={(event) => setMaxDaily(event.target.value)} /></label>
          <button type="button" className={`strategy-primary-button ${copyEnabled ? 'is-danger' : ''}`} onClick={() => { setCopyEnabled((current) => !current); setReviewState(copyEnabled ? 'Copy review paused. No account was connected.' : `Copy review armed for ${selectedLeader.name} with a ${maxDaily} USD daily cap.`); }}>{copyEnabled ? 'Pause copy review' : 'Start copy review'} <Copy size={14} /></button>
        </div>
      </div>
      <aside className="strategy-side-panel">
        <div className="strategy-side-kicker">CURRENT MARKET CONTEXT</div>
        <h2>{definition.label}</h2>
        <div className="apex-price">{formatMarketPrice(quote?.price ?? null, quote?.pipSize ?? 2)} <small>{quote?.status === 'live' ? 'LIVE' : 'LAST QUOTE'}</small></div>
        <p>Copy Trader is a review surface in this build. Personal Deriv connections and live copying remain disabled until secure account linking is completed.</p>
        <div className="strategy-check-list"><span>✓ Profile comparison</span><span>✓ Allocation cap</span><span>✓ No live copying</span></div>
        {reviewState && <span className="strategy-review-state" role="status">{reviewState}</span>}
      </aside>
    </section>
  );
}

function PremiumBotsExcludedView({ onNavigate }: { onNavigate: (tool: string) => void }) {
  return (
    <section className="strategy-workspace premium-excluded-workspace">
      <div className="strategy-workspace-main">
        <header className="strategy-workspace-header">
          <div><span className="terminal-eyebrow">PREMIUM AI BOTS</span><h1>Not included in this build</h1><p>Premium bots are intentionally excluded. The rest of the ProTraders FX terminal remains available through the tabs above.</p></div>
          <span className="strategy-status-pill">EXCLUDED</span>
        </header>
        <div className="premium-excluded-card"><Crown size={28} /><strong>Use the included bot workspaces</strong><p>Free Bots and Bot Builder provide editable review-only strategies with live official Deriv market context.</p><div><button type="button" className="strategy-primary-button" onClick={() => onNavigate('Free Bots')}>Open Free Bots <ChevronRight size={14} /></button><button type="button" className="strategy-secondary-button" onClick={() => onNavigate('Bot Builder')}>Open Bot Builder <Bot size={14} /></button></div></div>
      </div>
    </section>
  );
}

function PublicLoadingView() {
  return (
    <main className="public-loading-screen">
      <div className="public-loading-art" />
      <section className="public-loading-card" aria-live="polite">
        <div className="public-loading-logo"><BarChart3 size={22} /></div>
        <span className="public-loading-kicker">PROTRADERS FX</span>
        <h1>Trading Workspace</h1>
        <p>Loading your Deriv accounts…</p>
        <div className="public-loading-progress"><i /></div>
        <small>Boot sequence <b>100%</b></small>
      </section>
    </main>
  );
}

function PublicLandingView() {
  const { signInHref, signUpHref } = useAppAuth();
  return (
    <main className="public-landing">
      <div className="public-landing-glow public-landing-glow-one" />
      <div className="public-landing-glow public-landing-glow-two" />
      <header className="public-landing-header">
        <a href={basePath || '/'} className="public-landing-brand"><span><BarChart3 size={18} /></span><strong>PROTRADERS <b>FX</b><small>POWERED BY DERIV</small></strong></a>
         <div className="public-landing-actions"><a className="public-login" href={signInHref}>Join workspace</a><a className="public-signup" href={signUpHref}>Create account</a></div>
      </header>
      <section className="public-hero public-hero-minimal">
        <div className="public-hero-copy">
          <h1>Trade like a <span>pro.</span></h1>
           <div className="public-hero-actions"><a className="public-hero-primary" href={signInHref}>Join workspace <ArrowUpRight size={15} /></a><a className="public-hero-secondary" href={signUpHref}>Create account <Zap size={14} /></a></div>
        </div>
        <div className="public-market-orbit" aria-hidden="true"><span className="orbit-line orbit-line-a" /><span className="orbit-line orbit-line-b" /><span className="orbit-candle candle-one" /><span className="orbit-candle candle-two" /><span className="orbit-candle candle-three" /><span className="orbit-candle candle-four" /><div className="orbit-core"><BarChart3 size={32} /><b>LIVE</b></div></div>
      </section>
    </main>
  );
}

function DashboardView({ accountMode, marketQuotes, onNavigate }: { accountMode: 'DEMO' | 'REAL'; marketQuotes: Record<string, MarketQuote>; onNavigate: (tool: string) => void }) {
  const featuredMarkets = MARKET_DEFINITIONS.filter(({ family }) => family === 'volatility').slice(0, 6);
  const liveMarketCount = Object.values(marketQuotes).filter((quote) => quote.status === 'live').length;
  const quotedMarketCount = Object.values(marketQuotes).filter((quote) => quote.price !== null).length;
  const actions = [
    { label: 'Load Bot', description: 'Open your trading strategy', icon: Upload, tool: 'Free Bots', accent: 'cyan' },
    { label: 'Premium Bots', description: 'Exclusive automated strategies', icon: Crown, tool: 'Premium AI Bots', accent: 'gold' },
    { label: 'Speed Bot', description: 'One-click automated trading', icon: Gauge, tool: 'Quick Bot', accent: 'teal' },
    { label: 'Manual Trading', description: 'Full control, trade your way', icon: LineChart, tool: 'Manual Trader', accent: 'violet' },
  ];

  return (
    <section className="dashboard-view">
      <div className="dashboard-section-heading">
        <div><span className="terminal-eyebrow">YOUR TRADING DESK</span><h2>Choose how you want to trade</h2></div>
        <span className="dashboard-session"><i /> {accountMode} SESSION</span>
      </div>
      <div className="dashboard-action-grid">
        {actions.map(({ label, description, icon: Icon, tool, accent }, index) => (
          <button key={label} type="button" className={`dashboard-action-card accent-${accent}`} onClick={() => onNavigate(tool)}>
            <span className="dashboard-card-number">0{index + 1}</span>
            <span className="dashboard-action-icon"><Icon size={28} /></span>
            <strong>{label}</strong>
            <small>{description}</small>
            <ChevronRight className="dashboard-card-arrow" size={15} />
          </button>
        ))}
      </div>

      <div className="dashboard-live-heading"><span className="terminal-eyebrow">LIVE MARKET BOARD</span><span>Official Deriv public feed · tick stream</span></div>
      <div className="dashboard-market-grid">
        {featuredMarkets.map(({ label, name, symbol }) => {
          const quote = marketQuotes[symbol];
          return (
            <button key={symbol} type="button" className="dashboard-market-card" onClick={() => onNavigate('Manual Trader')}>
              <span><strong>{label}</strong><small>{name}</small></span>
              <b className={quote?.status === 'live' ? 'is-live' : ''}>{formatMarketPrice(quote?.price ?? null, quote?.pipSize ?? 2)}</b>
              <small className="dashboard-market-status"><i /> {quote?.status === 'live' ? 'LIVE' : quote?.price !== null ? 'LAST QUOTE' : 'CONNECTING'}</small>
            </button>
          );
        })}
      </div>
      <section className="dashboard-feedback">
        <span className="dashboard-feedback-kicker">TRADER FEEDBACK</span>
        <div className="dashboard-feedback-grid">
          <article><span className="feedback-avatar">JO</span><strong>James Ochieng</strong><small>Verified trader · ★★★★★</small><p>“The dashboard keeps signals and trading tools together, so I can review opportunities much faster.”</p></article>
          <article className="is-featured"><span className="feedback-avatar">AH</span><strong>Amina Hassan</strong><small>Verified trader · ★★★★★</small><p>“The market cards are clear and focused.”</p><div className="feedback-tags"><b>Fast workflow</b><b>Clear signals</b><b>Easy to use</b></div></article>
          <article><span className="feedback-avatar">DM</span><strong>David Mwangi</strong><small>Verified trader · ★★★★★</small><p>“Everything I use most is close by, and the live signal view is easy to understand at a glance.”</p></article>
          <article><span className="feedback-avatar">GN</span><strong>Grace Njeri</strong><small>Verified trader · ★★★★★</small><p>“The layout gives me a simple routine: review the data, compare markets, and then make my decision.”</p></article>
        </div>
      </section>
    </section>
  );
}

function AnalysisToolsView({ marketQuotes }: { marketQuotes: Record<string, MarketQuote> }) {
  const [mode, setMode] = useState('Digit circles');
  const [sideTab, setSideTab] = useState('Summary');
  const [ticksWindow, setTicksWindow] = useState('120');
  const analysisMarkets = VOLATILITY_DEFINITIONS.filter(({ label }) => label.endsWith('1s')).slice(0, 6);

  return (
    <section className="analysis-tools-view">
      <div className="analysis-tools-main">
        <div className="analysis-tools-toolbar">
          <button type="button" className={mode === 'Digit circles' ? 'is-selected' : ''} onClick={() => setMode('Digit circles')}>◌ Digit circles</button>
          <button type="button" className={mode === 'Normal tool' ? 'is-selected' : ''} onClick={() => setMode('Normal tool')}>Normal tool</button>
          <label>Ticks: <input value={ticksWindow} onChange={(event) => setTicksWindow(event.target.value.replace(/\D/g, '').slice(0, 3) || '1')} inputMode="numeric" aria-label="Number of analysis ticks" /></label>
        </div>
        <div className="analysis-tools-grid">
          {analysisMarkets.map((definition) => <AnalysisMarketCard key={definition.symbol} definition={definition} quote={marketQuotes[definition.symbol]} />)}
        </div>
      </div>
      <aside className="analysis-side-panel">
        <div className="analysis-side-tabs"><button type="button" className={sideTab === 'Summary' ? 'is-active' : ''} onClick={() => setSideTab('Summary')}>Summary</button><button type="button" className={sideTab === 'Transactions' ? 'is-active' : ''} onClick={() => setSideTab('Transactions')}>Transactions</button></div>
        <div className="analysis-side-copy">{sideTab === 'Summary' ? <><strong>Live market analysis</strong><p>Digit circles use the latest {ticksWindow} tick window. Pick a signal in the grid, then review it in Manual Trader.</p></> : <><strong>Review transactions</strong><p>No contracts have been purchased from this review-only workspace. Proposal reviews will appear here when execution is enabled.</p></>}</div>
        <button type="button" className="analysis-reset" onClick={() => { setMode('Digit circles'); setSideTab('Summary'); setTicksWindow('120'); }}>Reset</button>
      </aside>
    </section>
  );
}

function AnalysisMarketCard({ definition, quote }: { definition: MarketDefinition; quote?: MarketQuote }) {
  const stats = useMemo(() => {
    const counts = Array.from({ length: 10 }, () => 0);
    const history = (quote?.ticks ?? []).slice(-120).map((value) => {
      const formatted = formatMarketPrice(value, quote?.pipSize ?? 2);
      const digit = Number(formatted.replace(/\D/g, '').slice(-1));
      if (Number.isFinite(digit)) counts[digit] += 1;
      return digit;
    });
    const total = history.length || 1;
    const probabilities = counts.map((count) => (count / total) * 100);
    const even = probabilities.filter((_, digit) => digit % 2 === 0).reduce((sum, value) => sum + value, 0);
    const over = probabilities.filter((_, digit) => digit > 4).reduce((sum, value) => sum + value, 0);
    const first = quote?.ticks[0] ?? 0;
    const last = quote?.ticks.at(-1) ?? first;
    return { history, probabilities, even, over, rise: last >= first ? 55.4 : 44.6 };
  }, [quote]);
  const odd = 100 - stats.even;
  const fall = 100 - stats.rise;
  const under = 100 - stats.over;

  return (
    <article className="analysis-market-card">
      <header><span className="analysis-last-pill">Last 120</span><div><strong>{definition.name}</strong><b>{formatMarketPrice(quote?.price ?? null, quote?.pipSize ?? 2)}</b></div><span className="analysis-last-pill">Last 120</span></header>
      <div className="analysis-digit-grid">
        {stats.probabilities.map((probability, digit) => <span key={digit} className={`analysis-digit-circle digit-${digit}`}><strong>{digit}</strong><small>{probability.toFixed(1)}%</small></span>)}
      </div>
      <div className="analysis-history">{stats.history.slice(-10).map((digit, index) => <b key={`${digit}-${index}`} className={`digit-chip digit-${digit}`}>{digit}</b>)}</div>
      <AnalysisStatBar label="Even" value={stats.even} compare="Odd" compareValue={odd} leftColor="#2fc8a0" rightColor="#f26770" />
      <AnalysisStatBar label="Rise" value={stats.rise} compare="Fall" compareValue={fall} leftColor="#30c9a0" rightColor="#f26770" />
      <AnalysisStatBar label="Over 4" value={stats.over} compare="Under 4" compareValue={under} leftColor="#30c9a0" rightColor="#f26770" />
    </article>
  );
}

function AnalysisStatBar({ label, value, compare, compareValue, leftColor, rightColor }: { label: string; value: number; compare: string; compareValue: number; leftColor: string; rightColor: string }) {
  return (
    <div className="analysis-stat-bar">
      <span>{label}: {value.toFixed(1)}%</span><div><i style={{ width: `${value}%`, background: leftColor }} /><i style={{ width: `${compareValue}%`, background: rightColor }} /></div><b>{compare}: {compareValue.toFixed(1)}%</b>
    </div>
  );
}

function QuickBotView({ activeMarket, marketQuotes, onNavigate }: { activeMarket: string; marketQuotes: Record<string, MarketQuote>; onNavigate: (tool: string) => void }) {
  const definition = getVolatilityDefinition(getMarketDefinition(activeMarket).name);
  const quote = marketQuotes[definition.symbol];
  const [loaded, setLoaded] = useState(false);

  return (
    <section className="quick-bot-view">
      <div className="quick-bot-card">
        <div className="quick-bot-card-top">
          <div className="quick-bot-pin">⌑</div>
          <div><span className="quick-bot-kicker">QUICK BOT</span><h1>Vertex Digits</h1></div>
          <span className="quick-bot-pill">QUICK BOT</span>
        </div>
        <p>Extreme-digit Over/Under strategy for the {definition.name} with recovery and risk controls.</p>
        <div className="quick-bot-market"><span>{definition.name}</span><strong>{formatMarketPrice(quote?.price ?? null, quote?.pipSize ?? 2)}</strong><small>{quote?.status === 'live' ? 'LIVE' : quote?.price !== null ? 'LAST QUOTE' : 'CONNECTING'}</small></div>
        <button type="button" className="quick-bot-load" onClick={() => { setLoaded(true); onNavigate('Free Bots'); }}>LOAD BOT <span>⇩</span></button>
        {loaded && <p className="quick-bot-loaded" role="status">Vertex Digits loaded into Free Bots.</p>}
      </div>
    </section>
  );
}

function BulkTraderView({ activeMarket, setActiveMarket, marketQuotes, accountMode }: { activeMarket: string; setActiveMarket: (market: string) => void; marketQuotes: Record<string, MarketQuote>; accountMode: 'DEMO' | 'REAL' }) {
  const activeDefinition = getMarketDefinition(activeMarket);
  const activeQuote = marketQuotes[activeDefinition.symbol];
  const [tradeType, setTradeType] = useState('Even/Odd');
  const [numberOfTicks, setNumberOfTicks] = useState('120');
  const [ticks, setTicks] = useState('1');
  const [stake, setStake] = useState('0.5');
  const [bulkTrades, setBulkTrades] = useState('5');
  const [autoTrader, setAutoTrader] = useState(false);
  const [reviewState, setReviewState] = useState('');
  const [bulkSide, setBulkSide] = useState<'left' | 'right'>('left');
  const [scannerState, setScannerState] = useState<'idle' | 'scanning' | 'complete'>('idle');
  const [scannerResults, setScannerResults] = useState<BulkScanResult[]>([]);
  const [scannerDigits, setScannerDigits] = useState<Array<{ digit: number; percentage: number }>>([]);
  const [selectedScannerSymbol, setSelectedScannerSymbol] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerLog, setScannerLog] = useState<string[]>([]);
  const [executionState, setExecutionState] = useState<'idle' | 'executing'>('idle');
  useEffect(() => {
    const handleOpenScanner = () => setScannerOpen(true);
    window.addEventListener('bulk-ai-open', handleOpenScanner);
    return () => window.removeEventListener('bulk-ai-open', handleOpenScanner);
  }, []);
  const digitHistory = useMemo(() => (activeQuote?.ticks ?? []).slice(-12).map((value) => {
    const formatted = formatMarketPrice(value, activeQuote?.pipSize ?? 2);
    return Number(formatted.replace(/\D/g, '').slice(-1));
  }), [activeQuote]);
  const latestBulkDigit = digitHistory.at(-1)?.toString() ?? '';
  const digitCounts = useMemo(() => {
    const counts = Array.from({ length: 10 }, () => 0);
    digitHistory.forEach((digit) => { if (Number.isFinite(digit)) counts[digit] += 1; });
    const total = digitHistory.length || 10;
    return counts.map((count) => ({ count, percentage: digitHistory.length ? (count / total) * 100 : 10 }));
  }, [digitHistory]);
  const scanMarkets = () => {
    const preferredDefinition = getVolatilityDefinition(getMarketDefinition(activeMarket).name);
    const preferredQuote = marketQuotes[preferredDefinition.symbol];
    setScannerState('scanning');
    setScannerOpen(true);
    setScannerLog([
      '[INFO] Authenticating AI market matrix...',
      '[OK] Synthetic stream linked',
      '[INFO] Reading preferred market clusters...',
      '[INFO] Signal pressure rising',
      '[INFO] Checking last digit sequence...',
    ]);
    window.setTimeout(() => {
      const ticks = (preferredQuote?.ticks ?? []).slice(-Math.max(20, Number(numberOfTicks) || 120));
      const counts = Array.from({ length: 10 }, () => 0);
      ticks.forEach((tick) => {
        const digit = Number(formatMarketPrice(tick, preferredQuote?.pipSize ?? 2).replace(/\D/g, '').slice(-1));
        if (Number.isFinite(digit)) counts[digit] += 1;
      });
      const digitResults = counts.map((count, digit) => ({ digit, percentage: ticks.length ? (count / ticks.length) * 100 : 0 }));
      setScannerDigits(digitResults);
      if (!preferredQuote || preferredQuote.status !== 'live' || ticks.length < 8) {
        setScannerResults([]);
        setSelectedScannerSymbol('');
        setScannerState('complete');
        setScannerLog((current) => [...current, '[INFO] Waiting for enough live ticks on the preferred market...']);
        return;
      }
      const first = ticks[0];
      const last = ticks.at(-1) ?? first;
      const range = Math.max(...ticks) - Math.min(...ticks);
      const even = counts.filter((_, digit) => digit % 2 === 0).reduce((sum, count) => sum + count, 0) / ticks.length * 100;
      const over = counts.filter((_, digit) => digit > 4).reduce((sum, count) => sum + count, 0) / ticks.length * 100;
      const momentum = last >= first ? Math.min(100, 50 + Math.abs(last - first) / Math.max(range, Math.abs(first) * 0.00001, 1) * 50) : Math.max(0, 50 - Math.abs(last - first) / Math.max(range, Math.abs(first) * 0.00001, 1) * 50);
      const direction = last >= first;
      let side: BulkScanResult['side'];
      let contractType: BulkScanResult['contractType'];
      let confidence: number;
      let rationale: string;
      let barrier: number | undefined;
      if (tradeType === 'Rise/Fall') {
        side = direction ? 'Rise' : 'Fall';
        contractType = direction ? 'CALL' : 'PUT';
        confidence = Math.max(momentum, 100 - momentum);
        rationale = `${direction ? 'positive' : 'negative'} momentum across ${ticks.length} ticks`;
      } else if (tradeType === 'Over/Under') {
        side = over >= 50 ? 'Over' : 'Under';
        contractType = over >= 50 ? 'DIGITOVER' : 'DIGITUNDER';
        confidence = Math.max(over, 100 - over);
        barrier = 4;
        rationale = `${Math.max(over, 100 - over).toFixed(1)}% of recent digits favor ${side.toLowerCase()} 4`;
      } else {
        side = even >= 50 ? 'Even' : 'Odd';
        contractType = even >= 50 ? 'DIGITEVEN' : 'DIGITODD';
        confidence = Math.max(even, 100 - even);
        rationale = `${Math.max(even, 100 - even).toFixed(1)}% recent even/odd probability`;
      }
      const result: BulkScanResult = { definition: preferredDefinition, quote: preferredQuote, side, contractType, confidence, sampleSize: ticks.length, rationale, barrier };
      setScannerResults([result]);
      setSelectedScannerSymbol(preferredDefinition.symbol);
      setScannerState('complete');
      setScannerLog((current) => [
        ...current,
        `[OK] ${ticks.length} digits analyzed on ${preferredDefinition.name}`,
        `[OK] Signal: ${result.side} · ${result.confidence.toFixed(1)}% confidence`,
      ]);
       window.setTimeout(() => { void handleExecuteAiBatch(result); }, 250);
    }, 450);
  };
  const openScanner = () => setScannerOpen(true);
  const selectedScannerResult = scannerResults.find((result) => result.definition.symbol === selectedScannerSymbol);
  const handleExecuteAiBatch = async (scanResult?: BulkScanResult) => {
    const executionResult = scanResult ?? selectedScannerResult;
    if (!executionResult || executionState === 'executing') return;
    const amount = Number(stake);
    const duration = Math.max(1, Number(ticks) || 1);
    const count = Math.min(20, Math.max(1, Number(bulkTrades) || 1));
    if (!Number.isFinite(amount) || amount < 0.35) {
      setReviewState('Enter a stake of at least USD 0.35 before running the AI batch.');
      return;
    }
    setExecutionState('executing');
    setReviewState(`Executing ${count} live ${executionResult.side} trade${count === 1 ? '' : 's'}…`);
    let completed = 0;
    let failed = 0;
    let firstError = '';
    for (let index = 0; index < count; index += 1) {
      try {
        const response = await fetch('/api/deriv/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: executionResult.definition.symbol,
            contractType: executionResult.contractType,
            amount,
            duration,
            durationUnit: 't',
            currency: 'USD',
            barrier: executionResult.barrier,
            mode: accountMode.toLowerCase(),
            confirm: true,
          }),
        });
        const payload = await response.json() as { error?: string; message?: string; trade?: { contractId?: string | number } };
        if (!response.ok || !payload.trade) throw new Error(payload.message ?? payload.error ?? 'Live trade request failed.');
        completed += 1;
      } catch (error) {
        failed += 1;
        firstError = error instanceof Error ? error.message : 'Live trade request failed.';
        break;
      }
    }
    setExecutionState('idle');
    const summary = `${completed}/${count} AI live trade${count === 1 ? '' : 's'} opened${failed ? ` · ${failed} failed` : ''}.`;
    setReviewState(firstError ? `${summary} ${firstError}` : summary);
    setScannerLog((current) => [...current, firstError ? `[INFO] Execution stopped: ${firstError}` : `[OK] ${completed} live trade${completed === 1 ? '' : 's'} opened`]);
  };
  const handleBulkReview = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const leftChoice = tradeType === 'Even/Odd' ? 'Even' : tradeType === 'Rise/Fall' ? 'Rise' : 'Over';
    const rightChoice = tradeType === 'Even/Odd' ? 'Odd' : tradeType === 'Rise/Fall' ? 'Fall' : 'Under';
    setReviewState(`${bulkSide === 'left' ? leftChoice : rightChoice} bulk proposal ready for review · ${bulkTrades} trade${bulkTrades === '1' ? '' : 's'} · ${stake} USD`);
  };
  const leftChoice = tradeType === 'Even/Odd' ? 'Even' : tradeType === 'Rise/Fall' ? 'Rise' : 'Over';
  const rightChoice = tradeType === 'Even/Odd' ? 'Odd' : tradeType === 'Rise/Fall' ? 'Fall' : 'Under';

  return (
    <section className="bulk-trader-view">
      <form onSubmit={handleBulkReview}>
        <div className="bulk-control-grid">
          <label><span>MARKET</span><select value={activeMarket} onChange={(event) => setActiveMarket(event.target.value)}>{MARKET_DEFINITIONS.map(({ label, name }) => <option key={label} value={label}>{name}</option>)}</select></label>
          <label><span>TRADE TYPE</span><select value={tradeType} onChange={(event) => setTradeType(event.target.value)}><option>Even/Odd</option><option>Rise/Fall</option><option>Over/Under</option></select></label>
        </div>
        <label className="bulk-ticks-control"><span>NUMBER OF TICKS</span><input inputMode="numeric" value={numberOfTicks} onChange={(event) => setNumberOfTicks(event.target.value)} /></label>
         <div className="bulk-current-tick"><span>CURRENT TICK</span><strong>{formatMarketPrice(activeQuote?.price ?? null, activeQuote?.pipSize ?? 2)}</strong><small>{activeQuote?.status === 'live' ? '● LIVE' : activeQuote?.price !== null ? 'LAST QUOTE' : 'CONNECTING'}</small><button type="button" onClick={openScanner} disabled={scannerState === 'scanning'}><Sparkles size={12} /> {scannerState === 'scanning' ? 'SCANNING…' : 'AI SCANNER'}</button></div>
        <div className="bulk-digit-grid">
          {digitCounts.map(({ percentage }, digit) => <div key={digit} className={`bulk-digit digit-${digit}`}><strong>{digit}</strong><span>{percentage.toFixed(2)}%</span></div>)}
        </div>
        <div className="bulk-history-row"><span>TICKS</span>{digitHistory.length ? digitHistory.map((digit, index) => <b key={`${digit}-${index}`} className={`digit-chip digit-${digit}`}>{digit}</b>) : <small>Waiting for live tick history</small>}</div>
        <div className="bulk-input-grid">
          <label><span>TICKS</span><input inputMode="numeric" value={ticks} onChange={(event) => setTicks(event.target.value)} /></label>
          <label><span>STAKE</span><input inputMode="decimal" value={stake} onChange={(event) => setStake(event.target.value)} /></label>
          <label><span>NO. OF BULK TRADES</span><input inputMode="numeric" value={bulkTrades} onChange={(event) => setBulkTrades(event.target.value)} /></label>
        </div>
        <div className="bulk-action-row">
          <button type="submit" className="bulk-even-button" onClick={() => setBulkSide('left')}><span><CircleDollarSign size={12} /> {leftChoice}</span><b>USD {stake || '0.00'}</b><small>{digitCounts.filter((_, digit) => digit % 2 === 0).reduce((total, item) => total + item.percentage, 0).toFixed(2)}%</small></button>
          <button type="submit" className="bulk-odd-button" onClick={() => setBulkSide('right')}><span><CircleDollarSign size={12} /> {rightChoice}</span><b>USD {stake || '0.00'}</b><small>{digitCounts.filter((_, digit) => digit % 2 !== 0).reduce((total, item) => total + item.percentage, 0).toFixed(2)}%</small></button>
        </div>
        <div className="bulk-bottom-row"><button type="button" className={`bulk-auto-button ${autoTrader ? 'is-on' : ''}`} onClick={() => setAutoTrader(!autoTrader)}><Settings2 size={12} /> {autoTrader ? 'Live auto mode on' : 'Live auto mode'}</button>{reviewState && <span role="status">{reviewState}</span>}</div>
      </form>
      {scannerOpen && (
        <div className="ai-scanner-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setScannerOpen(false); }}>
          <section className="ai-scanner-modal" role="dialog" aria-modal="true" aria-labelledby="ai-scanner-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="ai-scanner-chrome" aria-hidden="true"><i /><i /><i /><button type="button" onClick={() => setScannerOpen(false)} aria-label="Close AI scanner"><X size={17} /></button></div>
            <div className="ai-scanner-header">
              <span>AI MARKET MATRIX</span>
              <h2 id="ai-scanner-title">Analysis Dashboard - Digit Scanner</h2>
            </div>
            <div className="ai-scanner-inputs">
              <label><span>STAKE</span><input inputMode="decimal" value={stake} onChange={(event) => setStake(event.target.value)} /></label>
              <label><span>NO. OF BULK TRADES</span><input inputMode="numeric" value={bulkTrades} onChange={(event) => setBulkTrades(event.target.value)} /></label>
            </div>
            <div className="ai-scanner-markets"><span>PREFERRED MARKET</span><b>{scannerState === 'complete' && selectedScannerResult ? selectedScannerResult.definition.name : activeDefinition.name}</b></div>
            <div className="ai-scanner-log" aria-live="polite">
              {scannerLog.map((line, index) => <div key={`${line}-${index}`} className={line.includes('[WARNING]') ? 'is-warning' : line.includes('[OK]') ? 'is-ok' : ''}>{line}</div>)}
            </div>
            <div className={`ai-scanner-status ${scannerState === 'scanning' ? 'is-scanning' : ''}`}>
              <div><span>{scannerState === 'complete' ? 'SCAN COMPLETE' : scannerState === 'scanning' ? 'SCANNING' : 'STANDBY'}</span><strong>{scannerState === 'complete' && selectedScannerResult ? `${selectedScannerResult.definition.name} · ${selectedScannerResult.side}` : scannerState === 'scanning' ? 'Reading live market pressure...' : 'Ready to scan for last-four digit pressure.'}</strong></div>
              <div className="ai-orb"><Sparkles size={17} /><b>AI</b></div>
            </div>
            {scannerState === 'complete' && selectedScannerResult && <div className="ai-scanner-best"><span>DIGIT SIGNAL</span><b>{selectedScannerResult.side}</b><em>{selectedScannerResult.confidence.toFixed(1)}% confidence · {selectedScannerResult.sampleSize} ticks</em></div>}
            {scannerState === 'complete' && <div className="ai-scanner-digits" aria-label="Digit scan results">{scannerDigits.map(({ digit, percentage }) => <div key={digit} className={latestBulkDigit === String(digit) ? 'is-latest' : ''}><strong>{digit}</strong><span>{percentage.toFixed(1)}%</span></div>)}</div>}
            {scannerState === 'complete' && selectedScannerResult && <div className="ai-scanner-trade"><span>{selectedScannerResult.definition.name} · {selectedScannerResult.side} · {accountMode}</span><em>Execution started automatically</em></div>}
            {reviewState && <div className="ai-scanner-execution-state" role="status">{reviewState}</div>}
            <button type="button" className="ai-scanner-scan-button" onClick={scanMarkets} disabled={scannerState === 'scanning' || executionState === 'executing'}>{scannerState === 'scanning' ? 'SCANNING LIVE MARKETS...' : scannerState === 'complete' ? 'SCAN AGAIN' : 'SCAN THE MARKET'}</button>
          </section>
        </div>
      )}
    </section>
  );
}

function RecoveryBotView({ accountMode, activeMarket, marketQuotes }: { accountMode: 'DEMO' | 'REAL'; activeMarket: string; marketQuotes: Record<string, MarketQuote> }) {
  const [running, setRunning] = useState(false);
  const [proposalState, setProposalState] = useState<'idle' | 'requesting' | 'ready' | 'error'>('idle');
  const [proposalMessage, setProposalMessage] = useState('');
  const [selectedBlock, setSelectedBlock] = useState('Trade parameters');
  const [stake, setStake] = useState('10');
  const [takeProfit, setTakeProfit] = useState('50');
  const [consecutiveLosses, setConsecutiveLosses] = useState('5');
  const [recoveryMarket, setRecoveryMarket] = useState(() => getVolatilityDefinition(getMarketDefinition(activeMarket).name).name);
  const selectedDefinition = getVolatilityDefinition(recoveryMarket);
  const selectedQuote = marketQuotes[selectedDefinition.symbol];

  useEffect(() => {
    setRecoveryMarket(getVolatilityDefinition(getMarketDefinition(activeMarket).name).name);
  }, [activeMarket]);

  const handleRun = async () => {
    if (running) {
      setRunning(false);
      setProposalMessage('Bot paused.');
      return;
    }
    const amount = Number(stake);
    if (!Number.isFinite(amount) || amount < 0.35) {
      setProposalState('error');
      setProposalMessage('Enter a stake of at least USD 0.35.');
      return;
    }
    setProposalState('requesting');
    setProposalMessage('Executing live Deriv trade…');
    try {
      const response = await fetch('/api/deriv/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selectedDefinition.symbol,
          contractType: 'DIGITOVER',
          amount,
          duration: 1,
          durationUnit: 't',
          currency: 'USD',
          barrier: 7,
          mode: accountMode.toLowerCase(),
          confirm: true,
        }),
      });
      const payload = await response.json() as { error?: string; message?: string; trade?: { contractId?: string | number; buyPrice?: number; currency?: string } };
      if (!response.ok || !payload.trade) throw new Error(payload.message ?? payload.error ?? 'Deriv did not execute the contract.');
      setRunning(false);
      setProposalState('ready');
      setProposalMessage(`Live contract opened · ${payload.trade.contractId ?? 'confirmed'} · buy ${payload.trade.buyPrice ?? '—'} ${payload.trade.currency ?? 'USD'}.`);
    } catch (error) {
      setRunning(false);
      setProposalState('error');
      setProposalMessage(error instanceof Error ? error.message : 'Unable to execute the Deriv contract.');
    }
  };

  return (
    <section className="recovery-builder">
      <div className="recovery-topbar">
        <div className="recovery-logo">E</div>
        <button type="button">Risk Disclaimer</button>
        <button type="button" className="cashier-button">Cashier</button>
        <button type="button" className="telegram-button">Join Telegram</button>
        <button type="button" className="whatsapp-button">WhatsApp Support</button>
        <span className="recovery-spacer" />
        <span className="recovery-live-quote"><i /> {selectedDefinition.name} {formatMarketPrice(selectedQuote?.price ?? null, selectedQuote?.pipSize ?? 2)}</span>
        <span className="recovery-currency">USD⌄</span>
        <strong className="recovery-balance">◉ 7,221.87 USD</strong>
        <span className="recovery-demo">{accountMode}</span>
        <button type="button" className="transfer-button">Transfer</button>
      </div>
      <div className="recovery-nav">
        {['▦ Dashboard', '◉ Best Bots', '♙ Bot Builder', '⌁ AI Analysis', '⌁ Analysis', '⟳ Auto Trades', '⌁ Trading View'].map((item) => (
          <button key={item} type="button" className={item.includes('Bot Builder') ? 'is-active' : ''} onClick={() => setSelectedBlock(item.includes('Bot Builder') ? 'Trade parameters' : selectedBlock)}>{item}</button>
        ))}
        <button type="button" className="recovery-run-top" onClick={handleRun} disabled={proposalState === 'requesting'}>{proposalState === 'requesting' ? '… Executing' : running ? 'Ⅱ Pause' : '▶ Execute live'}</button>
        <span className={`recovery-running-status ${proposalState === 'error' ? 'is-error' : proposalState === 'ready' ? 'is-ready' : ''}`}>{proposalMessage || (running ? 'Bot is running' : 'Bot is not running')}</span>
      </div>
      <div className="recovery-tools">
        <button type="button" className="quick-strategy">Quick strategy</button>
        <div className="recovery-tool-icons"><button type="button">⟳</button><button type="button">▱</button><button type="button">⚑</button><button type="button">⌁</button><button type="button">⌗</button><button type="button">↶</button><button type="button">↷</button><button type="button">⌕</button></div>
      </div>
      <div className="recovery-content">
        <aside className="recovery-sidebar">
          <h3>▦ &nbsp; Blocks menu <span>⌃</span></h3>
          <input placeholder="⌕  Search" aria-label="Search blocks" />
          {['Trade parameters', 'Purchase conditions', 'Sell conditions (optional)', 'Restart trading conditions', 'Analysis', 'Utility'].map((block) => (
            <button key={block} type="button" className={selectedBlock === block ? 'is-selected' : ''} onClick={() => setSelectedBlock(block)}>{block}<span>{['Analysis', 'Utility'].includes(block) ? '⌄' : ''}</span></button>
          ))}
        </aside>
        <div className="recovery-canvas">
          <div className="recovery-canvas-title"><span>1. Trade parameters</span><button type="button" onClick={() => setSelectedBlock('Restart trading conditions')}>4. Restart trading conditions</button></div>
          <div className="recovery-block">
            <div className="recovery-field-line"><span>Market:</span><VertexSelect value="Derived" /><b>›</b><VertexSelect value="Continuous Indices" /><b>›</b><VertexSelect value={recoveryMarket} options={VOLATILITY_DEFINITIONS.map(({ name }) => name)} onChange={setRecoveryMarket} /></div>
            <div className="recovery-field-line"><span>Trade Type:</span><VertexSelect value="Digits" /><b>›</b><VertexSelect value="Over/Under" /></div>
            <div className="recovery-field-line"><span>Contract Type:</span><VertexSelect value="Both" /></div>
            <div className="recovery-field-line"><span>Default Candle Interval:</span><VertexSelect value="1 minute" /></div>
            <label className="recovery-check"><input type="checkbox" /> Restart buy/sell on error (disable for better performance)</label>
            <label className="recovery-check"><input type="checkbox" defaultChecked /> Restart last trade on error (bot ignores the unsuccessful trade)</label>
          </div>
          <div className="recovery-block recovery-rule-block">
            <strong>Run once at start:</strong>
            <div className="recovery-set-row"><span>set</span><VertexSelect value="Numbers Under" /><span>to</span><VertexInput value="7" /></div>
            <div className="recovery-set-row"><span>set</span><VertexSelect value="Stake" /><span>to</span><VertexInput value={stake} onChange={setStake} /></div>
            <div className="recovery-set-row"><span>set</span><VertexSelect value="Martingale" /><span>to</span><VertexInput value="2" /></div>
            <div className="recovery-set-row"><span>set</span><VertexSelect value="Take Profit" /><span>to</span><VertexInput value={takeProfit} onChange={setTakeProfit} /></div>
            <div className="recovery-set-row"><span>set</span><VertexSelect value="Consecutive Losses" /><span>to</span><VertexInput value={consecutiveLosses} onChange={setConsecutiveLosses} /></div>
          </div>
          <div className="recovery-trash">▰</div>
        </div>
        <aside className="recovery-summary">
          <div className="recovery-summary-tabs"><button className="is-active" type="button">Summary</button><button type="button">Transactions</button><button type="button">Journal</button></div>
          <div className="recovery-empty"><p>When you’re ready to trade, hit <strong>Run</strong>.<br />You’ll be able to track your bot’s<br />performance here.</p></div>
          <div className="recovery-metrics">
            {['Total stake', 'Total payout', 'No. of runs', 'Contracts lost', 'Contracts won', 'Total profit/loss'].map((label) => <div key={label}><strong>{label}</strong><span>{label.includes('profit') ? '0.00 USD' : label.includes('stake') || label.includes('payout') ? '0.00 USD' : '0'}</span></div>)}
          </div>
          <button type="button" className="recovery-reset" onClick={() => { setRunning(false); setProposalState('idle'); setProposalMessage(''); }}>Reset</button>
        </aside>
      </div>
      <div className="recovery-disclaimer">▲ Risk Disclaimer <span>Live contract execution is enabled; confirm each run before purchase.</span><span>{accountMode} · Live execution</span></div>
    </section>
  );
}

function FreeBotsView({ accountMode, activeMarket, marketQuotes }: { accountMode: 'DEMO' | 'REAL'; activeMarket: string; marketQuotes: Record<string, MarketQuote> }) {
  const [botRunning, setBotRunning] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(true);
  const [initialAnalysis, setInitialAnalysis] = useState(true);
  const [recoveryAnalysis, setRecoveryAnalysis] = useState(true);
  const [botMarket, setBotMarket] = useState(() => getVolatilityDefinition(getMarketDefinition(activeMarket).name).name);
  const [botStake, setBotStake] = useState('1');
  const [takeProfit, setTakeProfit] = useState('10');
  const [stopLoss, setStopLoss] = useState('30');
  const selectedDefinition = getVolatilityDefinition(botMarket);
  const selectedQuote = marketQuotes[selectedDefinition.symbol];

  useEffect(() => {
    setBotMarket(getVolatilityDefinition(getMarketDefinition(activeMarket).name).name);
  }, [activeMarket]);

  const resetBot = () => {
    setBotRunning(false);
    setRecoveryMode(true);
    setInitialAnalysis(true);
    setRecoveryAnalysis(true);
    setBotMarket(getVolatilityDefinition(DEFAULT_MARKET_LABEL).name);
    setBotStake('1');
    setTakeProfit('10');
    setStopLoss('30');
  };

  return (
    <section className="vertex-builder">
      <div className="vertex-toolbar">
        <div className="vertex-actions">
          <button type="button">⇩ <span>Download bot</span></button>
          <button type="button">▱ <span>Load bot</span></button>
          <button type="button" onClick={resetBot}>↻ <span>Reset bot</span></button>
          <button type="button" onClick={resetBot}>⌗ <span>Reset layout</span></button>
        </div>
        <div className="vertex-market-chip">{selectedDefinition.name}<strong>{formatMarketPrice(selectedQuote?.price ?? null, selectedQuote?.pipSize ?? 2)}</strong></div>
      </div>

      <div className="vertex-builder-grid">
        <div className="vertex-column">
          <VertexPanel title="TRADE PARAMETERS">
            <div className="vertex-form-row"><span>Market:</span><VertexSelect value="synthetic_index" /><b>›</b><VertexSelect value="random_index" /><b>›</b><VertexSelect value={botMarket} options={VOLATILITY_DEFINITIONS.map(({ name }) => name)} onChange={setBotMarket} /></div>
            <div className="vertex-form-row"><span>Trade type:</span><VertexSelect value="Digits" /><b>›</b><VertexSelect value="Over/Under" /></div>
            <div className="vertex-form-row"><span>Contract type:</span><VertexSelect value="Both" /></div>
            <div className="vertex-form-row"><span>Recovery Mode:</span><VertexToggle checked={recoveryMode} onChange={() => setRecoveryMode(!recoveryMode)} /></div>
          </VertexPanel>

          <VertexPanel title="INITIAL PURCHASE" accent>
            <div className="vertex-panel-toolbar"><span>Signal Check</span><VertexSelect value="After Every" /><VertexInput value="3" /> <span>trades</span></div>
            <VertexRule>
              <div><b>IF</b><span>the last <VertexInput value="1" /> digits are <VertexSelect value="less or equal to" /> digit <VertexInput value="2" /> then</span><span className="vertex-trash">▥</span></div>
              <div><span>Purchase <VertexSelect value="Over" /> Prediction: <VertexInput value="2" /></span></div>
              <div className="vertex-rule-result">Last 1 pattern <em>1</em></div>
            </VertexRule>
            <VertexRule muted>
              <div><b>ELSE IF</b><span>the last <VertexInput value="1" /> digits are <VertexSelect value="greater or equal to" /> digit <VertexInput value="7" /> then</span><span className="vertex-trash">▥</span></div>
              <div><span>Purchase <VertexSelect value="Under" /> Prediction: <VertexInput value="7" /></span></div>
            </VertexRule>
          </VertexPanel>
        </div>

        <div className="vertex-column">
          <VertexPanel title="BOT PARAMETERS">
            <div className="vertex-form-row"><span>Stake:</span><VertexInput value={botStake} onChange={setBotStake} /><small>USD</small></div>
            <div className="vertex-form-row"><span>Take profit:</span><VertexInput value={takeProfit} onChange={setTakeProfit} /><small>USD</small></div>
            <div className="vertex-form-row"><span>Stop loss:</span><VertexInput value={stopLoss} onChange={setStopLoss} /><small>USD</small></div>
            <div className="vertex-form-row"><span>Martingale:</span><VertexToggle checked={recoveryMode} onChange={() => setRecoveryMode(!recoveryMode)} /><VertexInput value="2" /><small>×</small></div>
            <div className="vertex-form-row"><span>Duration:</span><VertexSelect value="Ticks" /><VertexInput value="1" /></div>
          </VertexPanel>

          <VertexPanel title="RECOVERY PURCHASE" accent>
            <div className="vertex-panel-toolbar"><span>Signal Check</span><VertexSelect value="On First Entry Only" /></div>
            <VertexRule>
              <div><b>IF</b><span><VertexSelect value="Even" /> % of last <VertexInput value="25" /> digits is <VertexSelect value="≥" /> <VertexInput value="55" /> %</span><span className="vertex-trash">▥</span></div>
              <div><span>THEN Purchase <VertexSelect value="Even" /></span></div>
              <div className="vertex-probability">Even: 48.0% <span>Odd: 52.0%</span></div>
            </VertexRule>
            <VertexRule muted>
              <div><b>ELSE IF</b><span><VertexSelect value="Odd" /> % of last <VertexInput value="25" /> digits is <VertexSelect value="≥" /> <VertexInput value="55" /> %</span><span className="vertex-trash">▥</span></div>
            </VertexRule>
          </VertexPanel>
        </div>
      </div>

      <div className="vertex-bottom-bar">
        <span className="vertex-risk">▲ Risk Disclaimer</span>
        <button type="button" className={`vertex-run ${botRunning ? 'is-running' : ''}`} onClick={() => setBotRunning(!botRunning)}>{botRunning ? 'Ⅱ  Pause' : '▶  Run'}</button>
        <span className="vertex-run-status">{botRunning ? 'Bot is running in review mode' : 'Bot is not running'}</span>
        <span className="vertex-time">{accountMode} · {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} GMT</span>
        <span className="vertex-disclaimer">No live trade is placed from this preview.</span>
      </div>
    </section>
  );
}

function VertexPanel({ title, children, accent = false }: { title: string; children: ReactNode; accent?: boolean }) {
  return (
    <section className={`vertex-panel ${accent ? 'has-accent' : ''}`}>
      <header><span>⋮</span><span>☷</span><strong>{title}</strong></header>
      <div className="vertex-panel-content">{children}</div>
    </section>
  );
}

function VertexInput({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
  const [localValue, setLocalValue] = useState(value);
  useEffect(() => setLocalValue(value), [value]);
  return <input className="vertex-input" value={onChange ? value : localValue} onChange={(event) => { setLocalValue(event.target.value); onChange?.(event.target.value); }} aria-label="Bot parameter" />;
}

function VertexSelect({ value, options, onChange }: { value: string; options?: string[]; onChange?: (value: string) => void }) {
  const [localValue, setLocalValue] = useState(value);
  useEffect(() => setLocalValue(value), [value]);
  const currentValue = onChange ? value : localValue;
  return <select className="vertex-select" value={currentValue} onChange={(event) => { setLocalValue(event.target.value); onChange?.(event.target.value); }} aria-label={`Bot option ${currentValue}`}>{(options ?? [value]).map((option) => <option key={option} value={option}>{option}</option>)}</select>;
}

function VertexToggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return <button type="button" className={`vertex-toggle ${checked ? 'is-on' : ''}`} onClick={onChange} aria-pressed={checked}><span /></button>;
}

function VertexRule({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <div className={`vertex-rule ${muted ? 'is-muted' : ''}`}>{children}</div>;
}

function Router() {
  const SignInPage = () => <LegacyAuthPage mode="login" />;
  const SignUpPage = () => <LegacyAuthPage mode="signup" />;

  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/account" component={Account} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function LegacyAuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const { signInHref, signUpHref } = useAppAuth();
  const isSignup = mode === 'signup';
  return (
    <AuthPage>
      <div className="border hairline bg-[#101d1e] p-8 text-[#e6e3d7]">
        <p className="font-mono-brand text-[10px] uppercase tracking-[.2em] text-[#d9a64c]">Deriv connection</p>
        <h1 className="mt-4 text-4xl font-extrabold tracking-[-.05em]">{isSignup ? 'Create your trading desk.' : 'Welcome back.'}</h1>
        <p className="mt-4 text-sm leading-6 text-[#9da9a0]">
          {isSignup ? 'Connect a Deriv account to unlock the ProTraders FX terminal.' : 'Continue with Deriv to return to your ProTraders FX workspace.'}
        </p>
        <a href={isSignup ? signUpHref : signInHref} className="mt-8 inline-flex bg-[#d9a64c] px-4 py-3 text-[11px] font-extrabold uppercase tracking-[.12em] text-[#0d1617]">
          {isSignup ? 'Continue to Deriv' : 'Log in with Deriv'}
        </a>
        <p className="mt-5 text-xs text-[#718077]">
          {isSignup ? 'Already connected?' : 'New to ProTraders FX?'}{' '}
          <a className="text-[#d9a64c]" href={isSignup ? signInHref : signUpHref}>{isSignup ? 'Log in' : 'Create an account'}</a>
        </p>
      </div>
    </AuthPage>
  );
}

function AuthPage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#0d1617] px-4 py-10">
      <div className="w-full max-w-[460px]">{children}</div>
    </div>
  );
}

function Account() {
  const { user, signOut } = useAppAuth();

  return (
    <AuthPage>
      <div className="border hairline bg-[#101d1e] p-8 text-[#e6e3d7]">
        <p className="font-mono-brand text-[10px] uppercase tracking-[.2em] text-[#d9a64c]">Member account</p>
        <h1 className="mt-4 text-4xl font-extrabold tracking-[-.05em]">Welcome back.</h1>
        <p className="mt-4 text-sm leading-6 text-[#9da9a0]">
           Connected as {user?.email ?? user?.label ?? 'Deriv trader'}.
        </p>
        <div className="mt-8 flex gap-3">
          <a href={basePath || '/'} className="bg-[#d9a64c] px-4 py-3 text-[11px] font-extrabold uppercase tracking-[.12em] text-[#0d1617]">Back to desk</a>
           <button type="button" onClick={() => void signOut()} className="border hairline px-4 py-3 text-[11px] font-extrabold uppercase tracking-[.12em] text-[#d9a64c]">Log out</button>
        </div>
      </div>
    </AuthPage>
  );
}

function LegacyRoutes() {
  return (
    <LegacyAuthProvider>
      <Router />
    </LegacyAuthProvider>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={basePath}>
          <LegacyRoutes />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
