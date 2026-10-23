import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Bar, BarChart, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, blobUrl, fmtDate } from './api.jsx';
import { CaseDocuments, History, RuleDetails } from './Officer.jsx';

const COLORS = ['#2563eb', '#16a34a', '#dc2626', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#475569', '#ea580c'];

function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
function Sla({ due }) {
  const now = useNow();
  if (!due) return <span>-</span>;
  const left = new Date(due) - now;
  const h = Math.floor(Math.abs(left) / 3600e3), m = Math.floor((Math.abs(left) % 3600e3) / 60e3);
  return <span className={left < 0 ? 'error' : left < 4 * 3600e3 ? 'warn' : ''}>{left < 0 ? `overdue ${h}h ${m}m` : `${h}h ${m}m left`}</span>;
}

export function CheckerQueue() {
  const [q, setQ] = useState(null);
  useEffect(() => { api('/checker/queue').then(setQ); }, []);
  return (
    <main>
      <h1>Pending checker</h1>
      {!q ? <p>Loading...</p> : !q.length ? <p>Nothing pending.</p> : (
        <table>
          <thead><tr><th>Application</th><th>Name</th><th>PAN</th><th>Risk</th><th>Rules</th><th>Maker recommendation</th><th>SLA</th><th>Audit</th></tr></thead>
          <tbody>{q.map((a) => (
            <tr key={a.id}><td><Link to={`/checker/case/${a.id}`}>{a.id}</Link></td><td>{a.fullName}</td><td>{a.panNumber}</td>
              <td><span className={`badge r-${a.riskCategory}`}>{a.riskCategory}</span></td><td className="small">{a.decision} {a.reasonCodes.join(', ')}</td>
              <td className="small">{a.recommendation ? `${a.recommendation.action}: ${a.recommendation.comment}` : 'none (HIGH-risk auto approval)'}</td>
              <td><Sla due={a.checkerSlaDue} /></td><td><Link to={`/checker/audit/${a.id}`}>audit</Link></td></tr>
          ))}</tbody>
        </table>
      )}
    </main>
  );
}

export function CheckerCase() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [f, setF] = useState({ action: 'APPROVE', comment: '' });
  const [msg, setMsg] = useState('');
  const load = () => api(`/review/${id}`).then(setData, (x) => setMsg(x.message));
  useEffect(() => { load(); }, [id]);
  if (!data) return <main>{msg ? <p className="error">{msg}</p> : <p>Loading...</p>}</main>;
  const a = data.application;
  const decide = async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/checker/${id}/decide`, { method: 'POST', body: { ...f, version: a.version } });
      setMsg(`${r.status}${r.account ? ` - customer ${r.account.customerId}, account ${r.account.accountNumber}` : ''}${r.slaMet === false ? ' (SLA missed)' : ''}`);
      load();
    } catch (x) { setMsg(x.status === 403 ? 'You made the recommendation on this case; a different checker must decide (maker-checker).' : x.status === 409 ? 'Case changed by someone else; reloaded.' : Object.values(x.errors).join('; ') || x.message); load(); }
  };
  return (
    <main className="wide">
      <h1>Case {a.id} <span className={`badge s-${a.status}`}>{a.status}</span></h1>
      <p>{a.fullName} - DOB {a.dob} - PAN {a.panNumber} - SLA <Sla due={a.checkerSlaDue} /> - <Link to={`/checker/audit/${a.id}`}>audit trail</Link></p>
      {msg && <p className="warn" role="status">{msg}</p>}
      <RuleDetails d={data.ruleDetails} a={a} />
      <History reviews={data.reviews} />
      {a.status === 'PENDING_CHECKER' && (
        <form onSubmit={decide} className="card">
          <h2>Checker decision</h2>
          <fieldset><legend className="sr-only">Decision</legend>
            {['APPROVE', 'REJECT', 'SEND_BACK'].map((x) => <label key={x} className="check"><input type="radio" name="action" checked={f.action === x} onChange={() => setF({ ...f, action: x })} /> {x}</label>)}
          </fieldset>
          <label>Comment (at least 10 characters)<textarea value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} required minLength={10} /></label>
          <button type="submit" disabled={f.comment.trim().length < 10}>Record decision</button>
          <button type="button" className="link" onClick={() => nav('/checker')}>Back to queue</button>
        </form>
      )}
      <CaseDocuments data={data} editable={false} />
    </main>
  );
}

export function AuditView() {
  const { id } = useParams();
  const [rows, setRows] = useState(null);
  useEffect(() => { api(`/audit/${id}`).then(setRows); }, [id]);
  const exportCsv = async () => {
    const u = await blobUrl(`/audit/${id}?format=csv`);
    const a = Object.assign(document.createElement('a'), { href: u, download: `audit_${id}.csv` });
    a.click(); URL.revokeObjectURL(u);
  };
  return (
    <main className="wide">
      <h1>Audit trail {id}</h1>
      <p><button onClick={exportCsv}>Export CSV</button> <Link to={`/checker/case/${id}`}>open case</Link></p>
      {!rows ? <p>Loading...</p> : (
        <table className="small">
          <thead><tr><th>#</th><th>When</th><th>User</th><th>Role</th><th>Action</th><th>Entity</th><th>Before</th><th>After</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td>{r.id}</td><td>{fmtDate(r.at)}</td><td>{r.user}</td><td>{r.role}</td><td>{r.action}</td><td>{r.entityId}</td><td className="mono">{r.before}</td><td className="mono">{r.after}</td></tr>)}</tbody>
        </table>
      )}
    </main>
  );
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
export function Dashboard() {
  const [range, setRange] = useState({ from: '', to: '' });
  const [d, setD] = useState(null);
  const [due, setDue] = useState([]);
  const load = () => api(`/dashboard?${new URLSearchParams(Object.fromEntries(Object.entries(range).filter(([, v]) => v)))}`).then(setD);
  useEffect(() => { load(); api('/rekyc/due').then(setDue); }, []);
  const statuses = d ? Object.entries(d.byStatus).map(([name, value]) => ({ name, value })) : [];
  return (
    <main className="wide">
      <h1>Dashboard</h1>
      <form className="inline card" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <label>From <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label>To <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        <button type="submit">Apply</button>
      </form>
      {d && (
        <>
          <div className="kpis">
            {[['Applications', d.total], ['Decided', d.decided], ['Straight-through', pct(d.straightThroughRate)], ['Review rate', pct(d.reviewRate)], ['Reject rate', pct(d.rejectRate)],
              ['Avg time in review', d.avgTimeInReviewHours == null ? '-' : `${d.avgTimeInReviewHours} h`], ['Pending checker', d.pendingChecker]].map(([k, v]) => <div key={k} className="card kpi"><span className="muted small">{k}</span><strong>{v}</strong></div>)}
          </div>
          <div className="split">
            <div className="card"><h2>By status</h2>
              <ResponsiveContainer width="100%" height={280}><PieChart><Pie data={statuses} dataKey="value" nameKey="name" outerRadius={95} label>{statuses.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip /><Legend /></PieChart></ResponsiveContainer>
            </div>
            <div className="card"><h2>Top 5 reason codes</h2>
              <ResponsiveContainer width="100%" height={280}><BarChart data={d.topReasonCodes} layout="vertical" margin={{ left: 150 }}><XAxis type="number" allowDecimals={false} /><YAxis type="category" dataKey="code" width={150} /><Tooltip /><Bar dataKey="count" fill="#2563eb" /></BarChart></ResponsiveContainer>
            </div>
          </div>
        </>
      )}
      <div className="card"><h2>Re-KYC due in the next 30 days</h2>
        {!due.length ? <p className="muted">None.</p> : <table><thead><tr><th>Customer</th><th>Name</th><th>PAN</th><th>Due</th></tr></thead><tbody>{due.map((c) => <tr key={c.customerId}><td>{c.customerId}</td><td>{c.fullName}</td><td>{c.panNumber}</td><td>{c.rekycDueDate}</td></tr>)}</tbody></table>}
      </div>
    </main>
  );
}

export function Watchlist() {
  const [rows, setRows] = useState([]);
  const [msg, setMsg] = useState('');
  const [list, setList] = useState('SANCTIONS');
  const [entry, setEntry] = useState({ id: '', list: 'SANCTIONS', name: '', alias: '', dob: '' });
  const [cfg, setCfg] = useState(null);
  const load = () => { api('/watchlist').then(setRows); api('/config').then((c) => setCfg(c.values)); };
  useEffect(load, []);
  const run = async (fn) => { setMsg(''); try { setMsg(await fn()); load(); } catch (x) { setMsg(Object.values(x.errors).join('; ') || x.message); } };
  const upload = (e) => {
    const file = e.target.files[0];
    if (file) run(async () => `Upserted ${(await api('/watchlist', { method: 'POST', body: { list, csv: await file.text() } })).upserted} entries.`);
    e.target.value = '';
  };
  const rescreen = () => run(async () => { const r = await api('/watchlist/rescreen', { method: 'POST' }); return `Re-screened ${r.rescreened} open cases; ${r.changed.length} changed${r.changed.length ? ': ' + r.changed.map((c) => `${c.id} -> ${c.after}`).join('; ') : ''}`; });
  const KEYS = ['name_match_threshold', 'name_reject_below', 'min_field_confidence', 'watchlist_match_threshold', 'watchlist_possible_threshold', 'address_proof_max_age_days', 'medium_risk_income'];
  return (
    <main className="wide">
      <h1>Watchlists and rule configuration</h1>
      {msg && <p className="warn" role="status">{msg}</p>}
      <div className="split">
        <div className="card">
          <h2>Upload list (data-pack CSV format)</h2>
          <label>List<select value={list} onChange={(e) => setList(e.target.value)}><option>SANCTIONS</option><option>PEP</option></select></label>
          <label>CSV file<input type="file" accept=".csv" onChange={upload} /></label>
          <h2>Add / update one entry</h2>
          <form className="grid" onSubmit={(e) => { e.preventDefault(); run(async () => (await api('/watchlist', { method: 'POST', body: { entries: [entry] } }), `Saved ${entry.id}.`)); }}>
            <label>ID<input value={entry.id} onChange={(e) => setEntry({ ...entry, id: e.target.value })} required /></label>
            <label>List<select value={entry.list} onChange={(e) => setEntry({ ...entry, list: e.target.value })}><option>SANCTIONS</option><option>PEP</option></select></label>
            <label>Name<input value={entry.name} onChange={(e) => setEntry({ ...entry, name: e.target.value })} required /></label>
            <label>Alias<input value={entry.alias} onChange={(e) => setEntry({ ...entry, alias: e.target.value })} /></label>
            <label>DOB<input type="date" value={entry.dob} onChange={(e) => setEntry({ ...entry, dob: e.target.value })} /></label>
            <button type="submit">Save entry</button>
          </form>
          <p><button onClick={rescreen}>Re-screen open cases</button></p>
        </div>
        <div className="card">
          <h2>Rule configuration</h2>
          {cfg && <form onSubmit={(e) => { e.preventDefault(); run(async () => `Saved config version ${(await api('/config', { method: 'PUT', body: { values: Object.fromEntries(KEYS.map((k) => [k, Number(cfg[k])])) } })).version}. New evaluations use it.`); }}>
            {KEYS.map((k) => <label key={k}>{k}<input type="number" step="any" value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} /></label>)}
            <button type="submit">Save configuration</button>
          </form>}
        </div>
      </div>
      <div className="card"><h2>Entries ({rows.length})</h2>
        <table className="small"><thead><tr><th>ID</th><th>List</th><th>Name</th><th>Alias</th><th>DOB</th><th>Details</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td>{r.id}</td><td>{r.list}</td><td>{r.name}</td><td>{r.alias}</td><td>{r.dob}</td><td>{r.program || r.position} {r.nationality || r.category}</td></tr>)}</tbody></table>
      </div>
    </main>
  );
}
