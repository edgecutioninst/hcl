import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, blobUrl, fmtDate } from './api.jsx';

const FIELDS = ['doc_type', 'name', 'dob', 'gender', 'pan_number', 'aadhaar_last4', 'address', 'pincode', 'document_date', 'valid_until'];

export function ReviewQueue() {
  const [q, setQ] = useState(null);
  useEffect(() => { api('/review/queue').then(setQ); }, []);
  return (
    <main>
      <h1>Review queue</h1>
      <p className="muted small">IN_REVIEW cases, HIGH risk first, then oldest submission.</p>
      {!q ? <p>Loading...</p> : !q.length ? <p>Queue is empty.</p> : (
        <table>
          <thead><tr><th>Application</th><th>Name</th><th>PAN</th><th>Risk</th><th>Reasons</th><th>Submitted</th></tr></thead>
          <tbody>{q.map((a) => (
            <tr key={a.id}><td><Link to={`/officer/${a.id}`}>{a.id}</Link></td><td>{a.fullName}</td><td>{a.panNumber}</td>
              <td><span className={`badge r-${a.riskCategory}`}>{a.riskCategory}</span></td><td className="small">{a.reasonCodes.join(', ')}</td><td>{fmtDate(a.submittedAt)}</td></tr>
          ))}</tbody>
        </table>
      )}
    </main>
  );
}

// Document text with the selected field's source span highlighted.
function DocText({ text, span }) {
  if (!text) return <p className="muted">No text.</p>;
  if (!span || span.start == null) return <pre className="doctext">{text}</pre>;
  return <pre className="doctext">{text.slice(0, span.start)}<mark>{text.slice(span.start, span.end)}</mark>{text.slice(span.end)}</pre>;
}

function DocImage({ url }) {
  const [src, setSrc] = useState(null);
  useEffect(() => { let u; blobUrl(url).then((x) => setSrc((u = x))); return () => u && URL.revokeObjectURL(u); }, [url]);
  return src ? <img className="docimg" src={src} alt="Uploaded document scan" /> : <p>Loading image...</p>;
}

export function RuleDetails({ d, a }) {
  if (!d) return null;
  return (
    <div className="card">
      <h2>Rule results</h2>
      <p><strong>{a.decision}</strong> {a.reasonCodes.length ? a.reasonCodes.join(' | ') : '(no reason codes)'} - risk {a.riskCategory || '-'} - re-KYC {a.rekycDueDate || '-'}</p>
      <ul className="small">
        {d.name && <li>Name: declared "{d.name.declared}" {d.name.compared.map((c) => <span key={c.doc_id}> | {c.doc_id} "{c.name}" similarity <strong>{c.similarity.toFixed(4)}</strong></span>)}</li>}
        {d.R6 && <li>PAN: declared {d.R6.declared} vs card {d.R6.read}</li>}
        {d.R7 && <li>DOB: declared {d.R7.declared} vs {d.R7.read.map((r) => `${r.doc_id} ${r.read}`).join(', ')}</li>}
        {d.R8 && <li>Aadhaar last 4: declared {d.R8.declared} vs card {d.R8.read}</li>}
        {d.R13 && <li>Address proof dated {d.R13.document_date} ({d.R13.age_days} days old, max {d.R13.max})</li>}
        {d.R12 && <li>Driving licence valid until {d.R12.valid_until}</li>}
        {d.R14 && <li>Pincode: declared {d.R14.declared} vs document {d.R14.read}</li>}
        {d.R2 && <li>Type mismatch: {d.R2.mismatches.map((m) => `${m.doc_id} declared ${m.declared}, read ${m.classified}`).join('; ')}</li>}
        {d.R1 && <li>Missing: {d.R1.missing.join(', ')}</li>}
        {d.R3 && <li>Low confidence: {d.R3.low.map((l) => `${l.doc_id} ${l.field} ${l.confidence.toFixed(2)}`).join('; ')}</li>}
        <li>Sanctions: {d.sanctions.result}{d.sanctions.entry && ` - ${d.sanctions.entry} "${d.sanctions.matchedOn}" similarity ${d.sanctions.similarity.toFixed(4)}, list dob ${d.sanctions.entryDob || 'none'} (${d.sanctions.dobMatch ? 'matches/empty' : 'differs'})`}</li>
        <li>PEP: {d.pep.result}{d.pep.entry && ` - ${d.pep.entry} "${d.pep.matchedOn}" similarity ${d.pep.similarity.toFixed(4)}, list dob ${d.pep.entryDob || 'none'} (${d.pep.dobMatch ? 'matches' : 'differs'})`}</li>
      </ul>
    </div>
  );
}

export function CaseDocuments({ data, editable, onEdit }) {
  const [sel, setSel] = useState({});
  return data.documents.map((d) => {
    const field = d.fields.find((f) => f.id === sel[d.id]);
    return (
      <section key={d.id} className="card doc">
        <h2>{d.id} - declared {d.declaredDocType}, read as <span className={d.docTypeLow || d.classifiedDocType !== d.declaredDocType ? 'lowconf' : ''}>{d.classifiedDocType} ({(d.docTypeConfidence ?? 0).toFixed(2)})</span></h2>
        <p className="muted small">{d.fileName} - {d.extractionStatus} - {d.extractorVersion}{d.ocrConfidence != null && ` - OCR confidence ${d.ocrConfidence.toFixed(2)}`}</p>
        <div className="split">
          <div>
            {d.contentUrl && <DocImage url={d.contentUrl} />}
            <DocText text={d.text} span={field && { start: field.sourceStart, end: field.sourceEnd }} />
          </div>
          <div>
            <table>
              <thead><tr><th>Field</th><th>Value</th><th>Conf.</th><th>Source</th></tr></thead>
              <tbody>{d.fields.map((f) => (
                <tr key={f.id} className={`${f.low ? 'lowrow' : ''} ${sel[d.id] === f.id ? 'selrow' : ''}`} onClick={() => setSel({ ...sel, [d.id]: f.id })}>
                  <td>{f.fieldName}{d.requiredFields.includes(f.fieldName) && ' *'}</td>
                  <td><button className="link" aria-label={`Highlight ${f.fieldName} in document`}>{f.value}</button></td>
                  <td>{f.confidence.toFixed(2)}{f.low && <span className="badge lowconf"> low</span>}</td><td>{f.source}</td>
                </tr>
              ))}</tbody>
            </table>
            {d.requiredFields.filter((r) => !d.fields.some((f) => f.fieldName === r)).map((r) => <p key={r} className="lowconf small">Missing required field: {r}</p>)}
            {editable && <EditField doc={d} onEdit={onEdit} />}
          </div>
        </div>
      </section>
    );
  });
}

function EditField({ doc, onEdit }) {
  const [f, setF] = useState({ field: doc.requiredFields[0] || 'doc_type', newValue: '', reason: '' });
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    try { await onEdit({ documentId: doc.id, ...f }); setF({ ...f, newValue: '', reason: '' }); } catch (x) { setErr(Object.values(x.errors).join('; ') || x.message); }
  };
  return (
    <form onSubmit={submit} className="inline">
      <select aria-label="Field to correct" value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })}>{FIELDS.map((x) => <option key={x}>{x}</option>)}</select>
      <input aria-label="Corrected value" placeholder={f.field.includes('date') || f.field === 'dob' || f.field === 'valid_until' ? 'YYYY-MM-DD' : 'new value'} value={f.newValue} onChange={(e) => setF({ ...f, newValue: e.target.value })} required />
      <input aria-label="Reason for correction" placeholder="reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={5} />
      <button type="submit">Correct</button>
      {err && <span className="error" role="alert">{err}</span>}
    </form>
  );
}

export function ReviewCase() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [rec, setRec] = useState({ action: 'APPROVE', comment: '' });
  const [msg, setMsg] = useState('');
  const load = () => api(`/review/${id}`).then(setData, (x) => setMsg(x.message));
  useEffect(() => { load(); }, [id]);
  if (!data) return <main>{msg ? <p className="error">{msg}</p> : <p>Loading...</p>}</main>;
  const a = data.application;
  const onEdit = async (body) => {
    const r = await api(`/review/${id}/fields`, { method: 'PATCH', body: { ...body, version: a.version } });
    setMsg(`Rules re-run: ${r.decision} ${r.reasonCodes.join(' | ')} (case stays with you, then goes to the checker)`);
    await load();
  };
  const recommend = async (e) => {
    e.preventDefault();
    try { await api(`/review/${id}/recommend`, { method: 'POST', body: { ...rec, version: a.version } }); nav('/officer'); }
    catch (x) { setMsg(x.status === 409 ? 'Someone else changed this case. Reloaded - check and try again.' : Object.values(x.errors).join('; ') || x.message); load(); }
  };
  return (
    <main className="wide">
      <h1>Case {a.id} <span className={`badge s-${a.status}`}>{a.status}</span></h1>
      <p>{a.fullName} - DOB {a.dob} - PAN {a.panNumber} - Aadhaar last 4 {a.aadhaarLast4} - pincode {a.pincode} - {a.occupationCode} - Rs. {a.annualIncome.toLocaleString('en-IN')} - applied {a.applicationDate}</p>
      {msg && <p className="warn" role="status">{msg}</p>}
      <RuleDetails d={data.ruleDetails} a={a} />
      {a.aiSummary && <div className="card ai"><h2>AI-generated summary</h2><p>{a.aiSummary}</p><p className="muted small">Generated from rule results and extracted values only. It does not recommend a decision.</p></div>}
      <CaseDocuments data={data} editable={a.status === 'IN_REVIEW'} onEdit={onEdit} />
      {a.status === 'IN_REVIEW' && (
        <form onSubmit={recommend} className="card">
          <h2>Recommendation</h2>
          <fieldset><legend className="sr-only">Action</legend>
            {['APPROVE', 'REJECT', 'REQUEST_RESUBMISSION'].map((x) => <label key={x} className="check"><input type="radio" name="action" checked={rec.action === x} onChange={() => setRec({ ...rec, action: x })} /> {x}</label>)}
          </fieldset>
          <label>Comment (at least 10 characters)<textarea value={rec.comment} onChange={(e) => setRec({ ...rec, comment: e.target.value })} minLength={10} required /></label>
          <button type="submit" disabled={rec.comment.trim().length < 10}>Submit recommendation</button>
        </form>
      )}
      <History reviews={data.reviews} />
    </main>
  );
}

export function History({ reviews }) {
  if (!reviews?.length) return null;
  return <div className="card"><h2>Maker / checker history</h2><ul>{reviews.map((r) => <li key={r.id}>{fmtDate(r.createdAt)} - {r.stage} {r.action}: {r.comment}</li>)}</ul></div>;
}
