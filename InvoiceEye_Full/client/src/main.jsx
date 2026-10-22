import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, PieChart, Pie, Cell } from 'recharts';
import './styles.css';
import './overrides.css';

const API='/api';
const COLORS=['#67e8f9','#4ade80','#facc15','#fb7185'];

async function api(path, options={}){
  const token=localStorage.getItem('ie_token');
  const headers={...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...(token?{Authorization:`Bearer ${token}`}:{})};
  let res;
  try {
    res=await fetch(API+path,{...options,headers});
  } catch {
    throw new Error('Cannot reach the InvoiceEye API. Run `npm run dev` from the InvoiceEye_Full folder.');
  }
  const data=await res.json().catch(()=>({}));
  if(!res.ok) {
    const error=new Error(data.message || (res.status===502 || res.status===503
      ? 'InvoiceEye API or database is unavailable. Check the API server and database configuration.'
      : 'Request failed'));
    error.status=res.status;
    throw error;
  }
  return data;
}

function App(){
  const [user,setUser]=useState(null);
  const [tab,setTab]=useState('overview');
  const [summary,setSummary]=useState(null);
  const [invoices,setInvoices]=useState([]);
  const [selected,setSelected]=useState(null);
  const [toast,setToast]=useState('');
  useEffect(()=>{
    const raw=localStorage.getItem('ie_user');
    if(!raw)return;
    try{
      const savedUser=JSON.parse(raw);
      if(!savedUser||typeof savedUser.name!=='string'||typeof savedUser.role!=='string')throw new Error('Invalid saved user');
      setUser(savedUser);
    }catch{
      localStorage.removeItem('ie_token');
      localStorage.removeItem('ie_user');
    }
  },[]);
  const reload=async()=>{ if(!user)return; try{const [s,i]=await Promise.all([api('/summary'),api('/invoices')]);setSummary(s);setInvoices(i);}catch(e){if(e.status===401){logout();return;}setToast(e.message);} };
  useEffect(()=>{reload();},[user]);
  const logout=()=>{localStorage.removeItem('ie_token');localStorage.removeItem('ie_user');setUser(null)};
  if(!user) return <Login onLogin={u=>setUser(u)} />;
  const nav=[['overview','Overview','◈'],['invoices','Invoice Register','▣'],['review','Review Queue','✓'],['verify','Verify Invoice','＋'],['vendors','Vendors','◉'],['purchase-orders','Purchase Orders','⌘'],['audit','Audit Trail','◌']];
  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><div className="logo">IE</div><div><b>InvoiceEye</b><span>Verification Intelligence</span></div></div>
      <div className="navgroup"><small>WORKSPACE</small>{nav.map(([id,label,icon])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}><i>{icon}</i>{label}</button>)}</div>
      <div className="sidefoot"><div className="avatar">{user.name.slice(0,2).toUpperCase()}</div><div><b>{user.name}</b><span>{user.role}</span></div><button onClick={logout}>↪</button></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><div className="eyebrow">FINANCIAL CONTROL / DOCUMENT VERIFICATION</div><h1>{tabTitle(tab)}</h1></div><div className="headeractions"><span className="statuspill"><i/> Database connected</span><span className="rolepill">{user.role.toUpperCase()}</span></div></header>
      {toast && <div className="toast">{toast}</div>}
      {tab==='overview' && <Overview summary={summary} invoices={invoices} onSelect={setSelected}/>}
      {tab==='invoices' && <InvoiceRegister invoices={invoices} onSelect={setSelected}/>}
      {tab==='review' && <InvoiceRegister invoices={invoices} onSelect={setSelected} forcedStatus="NEEDS REVIEW"/>}
      {tab==='verify' && <VerifyPage onDone={(msg)=>{setToast(msg);reload();setTimeout(()=>setToast(''),3500)}}/>}
      {tab==='vendors' && <Vendors user={user}/>} 
      {tab==='purchase-orders' && <PurchaseOrders user={user}/>} 
      {tab==='audit' && <Audit/>}
      {selected && <InvoiceDrawer data={selected} user={user} onClose={()=>setSelected(null)} onUpdated={()=>{setSelected(null);reload();}}/>}
    </main>
  </div>
}
function tabTitle(t){return ({overview:'Verification Overview',invoices:'Invoice Register',review:'Verification Review',verify:'Verify an Invoice',vendors:'Vendor Master', 'purchase-orders':'Purchase Orders',audit:'Audit Trail'})[t]}

function Login({onLogin}) {
  const [email, setEmail] = useState('shivanshcollege2@gmail.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [setupMessage, setSetupMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api('/health').then(status => {
      if (!cancelled && !status.ownerConfigured) {
        setSetupMessage('Owner account is not initialized. Set OWNER_PASSWORD in your local .env file, then restart InvoiceEye.');
      }
    }).catch(healthError => {
      if (!cancelled) setSetupMessage(healthError.message);
    });
    return () => { cancelled = true; };
  }, []);
  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      localStorage.setItem('ie_token', data.token);
      localStorage.setItem('ie_user', JSON.stringify(data.user));
      onLogin(data.user);
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="login"><form className="loginCard" onSubmit={submit}>
    <div className="logo large">IE</div>
    <div className="eyebrow">DOCUMENT INTELLIGENCE</div>
    <h1>InvoiceEye</h1>
    <p>Smart invoice verification for finance and procurement teams.</p>
    <input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="Email" required />
    <input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Password" required />
    <button className="primary wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    {setupMessage && <div className="error" role="alert">{setupMessage}</div>}
    {error && <div className="error">{error}</div>}
  </form></div>;
}

function Overview({summary,invoices,onSelect}){
  const [trendCurrency,setTrendCurrency]=useState('');
  const pie=summary?[{name:'Accepted',value:Number(summary.accepted||0)},{name:'Needs review',value:Number(summary.review||0)},{name:'Rejected',value:Number(summary.rejected||0)}]:[];
  const currencies=[...new Set((summary?.trend||[]).map(point=>point.currency))];
  const selectedCurrency=trendCurrency||currencies[0]||'INR';
  const trend=useMemo(()=>summary?.trend?.filter(point=>point.currency===selectedCurrency).slice().sort((a,b)=>a.month.localeCompare(b.month))||[],[summary,selectedCurrency]);
  return <>
  <section className="kpis"><Kpi label="Invoices processed" value={summary?.total??'—'} meta="All time"/><Kpi label="Accepted" value={summary?.accepted??'—'} meta="Clear match" good/><Kpi label="Needs review" value={summary?.review??'—'} meta="Human attention" warn/><Kpi label="Rejected" value={summary?.rejected??'—'} meta="Rule / risk violation" bad/></section>
  <section className="grid2"><Card title="Invoice value trend" meta="Monthly totals in the selected currency"><div className="chartHeader"><label htmlFor="trend-currency">Currency</label><select id="trend-currency" value={selectedCurrency} onChange={event=>setTrendCurrency(event.target.value)}>{(currencies.length?currencies:[selectedCurrency]).map(currency=><option key={currency}>{currency}</option>)}</select></div>{trend.length?<div className="chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={trend}><XAxis dataKey="month" stroke="#64748b"/><YAxis stroke="#64748b" tickFormatter={value=>`${selectedCurrency} ${Math.round(value/1000)}k`}/><Tooltip formatter={value=>money(value,selectedCurrency)} contentStyle={{background:'#0d1320',border:'1px solid #263248',borderRadius:10}}/><Area type="monotone" dataKey="value" stroke="#8b7cff" fill="#8b7cff" fillOpacity={0.12} strokeWidth={3}/></AreaChart></ResponsiveContainer></div>:<div className="placeholder">No dated invoices are available to chart yet.</div>}</Card><Card title="Verification outcomes" meta="Portfolio distribution"><div className="donut"><ResponsiveContainer width="58%" height={220}><PieChart><Pie data={pie} dataKey="value" innerRadius={62} outerRadius={88} paddingAngle={4}>{pie.map((_,i)=><Cell key={i} fill={COLORS[i+1]}/>)}</Pie><Tooltip contentStyle={{background:'#0d1320',border:'1px solid #263248'}}/></PieChart></ResponsiveContainer><div className="legend">{pie.map((p,i)=><div key={p.name}><span style={{background:COLORS[i+1]}}/>{p.name}<b>{p.value}</b></div>)}</div></div></Card></section>
  <section className="grid3"><Card title="Average risk" meta="Explainable 0–99 score"><div className="bigMetric">{summary?.avgRisk??0}<span>/99</span></div><div className="meter"><div style={{width:`${Math.min(100,Number(summary?.avgRisk||0))}%`}}/></div><p className="muted">Risk combines deterministic verification failures and supporting anomaly signals.</p></Card><Card title="Portfolio value" meta="Totals remain separated by currency"><div className="currencyTotals">{summary?.valueByCurrency?.length?summary.valueByCurrency.map(item=><div key={item.currency}><span>{item.currency}</span><b>{money(item.value,item.currency)}</b></div>):<span className="muted">No invoice totals recorded.</span>}</div></Card><Card title="Control principle" meta="Human in the loop"><div className="principle">Automate checks.<br/><strong>Escalate decisions.</strong></div><p className="muted">InvoiceEye supports financial review; it does not authorize payment autonomously.</p></Card></section>
  <section className="card"><div className="cardhead"><div><h3>Recent verification activity</h3><span>Open any row to inspect evidence and review history.</span></div></div><InvoiceTable rows={invoices.slice(0,8)} onSelect={onSelect}/></section>
</>}
function Kpi({label,value,meta,good,warn,bad}){return <div className="kpi"><span>{label}</span><strong>{value}</strong><em className={good?'good':warn?'warn':bad?'bad':''}>{meta}</em></div>}
function Card({title,meta,children}){return <section className="card"><div className="cardhead"><div><h3>{title}</h3><span>{meta}</span></div></div>{children}</section>}

function InvoiceRegister({invoices,onSelect,forcedStatus}) {
  const [q,setQ]=useState('');
  const [status,setStatus]=useState(forcedStatus || '');
  const [rows,setRows]=useState(invoices);
  const [page,setPage]=useState(1);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const activeStatus=forcedStatus || status;
  useEffect(()=>{
    let cancelled=false;
    const timer=setTimeout(async()=>{
      setLoading(true);
      setError('');
      try {
        const params=new URLSearchParams({page:'1',limit:'100'});
        if(q.trim()) params.set('q',q.trim());
        if(activeStatus) params.set('status',activeStatus);
        const nextRows=await api(`/invoices?${params}`);
        if(!cancelled){setRows(nextRows);setPage(1);}
      } catch(loadError) {
        if(!cancelled) setError(loadError.message);
      } finally {
        if(!cancelled) setLoading(false);
      }
    },250);
    return ()=>{cancelled=true;clearTimeout(timer);};
  },[q,activeStatus]);
  const loadMore=async()=>{
    setLoading(true);
    setError('');
    try {
      const params=new URLSearchParams({page:String(page+1),limit:'100'});
      if(q.trim()) params.set('q',q.trim());
      if(activeStatus) params.set('status',activeStatus);
      const more=await api(`/invoices?${params}`);
      setRows(current=>[...current,...more]);
      setPage(current=>current+1);
    } catch(loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  };
  const downloadCsv=async()=>{
    try {
      const token=localStorage.getItem('ie_token');
      const params=new URLSearchParams();
      if(q.trim()) params.set('q',q.trim());
      if(activeStatus) params.set('status',activeStatus);
      const response=await fetch(`${API}/reports/invoices.csv?${params}`,{headers:{Authorization:`Bearer ${token}`}});
      if(!response.ok) throw new Error((await response.json().catch(()=>({}))).message || 'CSV export failed');
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');
      link.href=url;
      link.download='invoiceeye-invoices.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch(downloadError) {
      setError(downloadError.message);
    }
  };
  return <section className="card"><div className="toolbar"><div><h3>{forcedStatus?'Review queue':'Invoice register'}</h3><span>{forcedStatus?'Invoices requiring human attention.':'Search, filter and inspect verification evidence.'}</span></div><div className="filters"><input placeholder="Search invoice, vendor or PO" value={q} onChange={e=>setQ(e.target.value)}/>{!forcedStatus&&<select value={status} onChange={e=>setStatus(e.target.value)}><option value="">All statuses</option><option>ACCEPTED</option><option>NEEDS REVIEW</option><option>REJECTED</option></select>}<button type="button" onClick={downloadCsv}>Export CSV</button></div></div>{error&&<div className="error" role="alert">{error}</div>}{loading&&<p className="muted small">Loading invoices…</p>}<InvoiceTable rows={rows} onSelect={onSelect}/>{rows.length===100&&<button className="secondary" disabled={loading} onClick={loadMore}>{loading?'Loading…':'Load more'}</button>}</section>
}
function InvoiceTable({rows,onSelect}){return <div className="tablewrap"><table><thead><tr><th>Invoice</th><th>Vendor</th><th>PO</th><th>Amount</th><th>Risk</th><th>Status</th></tr></thead><tbody>{rows.map(r=><tr key={r.id} onClick={()=>onSelect(r)}><td><b>{r.invoiceNumber}</b>{r.isDemo&&<span className="demoLabel">DEMO</span>}<small>{String(r.invoiceDate||'').slice(0,10)}</small></td><td>{r.vendorName||'Unmatched'}</td><td>{r.poId||'—'}</td><td>{money(r.total,r.currency)}</td><td><span className={`risk ${r.riskScore>=70?'high':r.riskScore>=35?'mid':'low'}`}>{r.riskScore}</span></td><td><Status value={r.status}/></td></tr>)}{!rows.length&&<tr><td colSpan="6" className="empty">No invoices match the current filter. Upload an invoice to get started.</td></tr>}</tbody></table></div>}
function Status({value}){return <span className={`badge ${String(value).replace(/\s/g,'').toLowerCase()}`}>{value}</span>}

function VerifyPage({onDone}) {
  const [mode,setMode]=useState('file');
  const [text,setText]=useState('');
  const [file,setFile]=useState(null);
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState(null);
  const selectFile=nextFile=>{
    if(!nextFile){setFile(null);return;}
    const supported=/\.(pdf|png|jpe?g|webp|tiff?)$/i.test(nextFile.name);
    if(!supported){setFile(null);setResult({error:'Choose a PDF, PNG, JPG, WEBP or TIFF invoice.'});return;}
    if(nextFile.size>8*1024*1024){setFile(null);setResult({error:'Invoice file exceeds the 8 MB upload limit.'});return;}
    setFile(nextFile);
    setResult(null);
  };
  const submit=async()=>{
    if(busy||((mode==='file'&&!file)||(mode==='text'&&!text.trim())))return;
    setBusy(true);
    setResult(null);
    const fd=new FormData();
    if(mode==='file')fd.append('file',file);
    else fd.append('text',text);
    try{
      const data=await api('/invoices/verify',{method:'POST',body:fd});
      setResult(data);
      if(data.result)onDone(`${data.parsed.invoiceNumber} verified — ${data.result.status}`);
    }catch(error){setResult({error:error.message});}
    finally{setBusy(false);}
  };
  const onDrop=event=>{event.preventDefault();selectFile(event.dataTransfer.files?.[0]);};
  return <div className="verifyGrid">
    <section className="card">
      <div className="tabs"><button className={mode==='file'?'sel':''} onClick={()=>setMode('file')}>Document upload</button><button className={mode==='text'?'sel':''} onClick={()=>setMode('text')}>Paste invoice text</button></div>
      {mode==='file'?<div className="drop" onDragOver={event=>event.preventDefault()} onDrop={onDrop}>
        <div className="uploadIcon">⇪</div><h3>Drop an invoice here or choose a file</h3>
        <p>PDF, PNG, JPG, WEBP or TIFF · maximum 8 MB · PDF/image limit: 20 pages</p>
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff" onChange={event=>selectFile(event.target.files?.[0]||null)}/>
        {file&&<div className="fileName">Selected: {file.name} ({(file.size/1024).toFixed(1)} KB) <button type="button" onClick={()=>selectFile(null)}>Remove</button></div>}
      </div>:<textarea className="invoiceText" value={text} onChange={event=>setText(event.target.value)} placeholder="Paste the invoice text to verify."/>}
      <button className="primary wide" disabled={busy||(mode==='file'&&!file)||(mode==='text'&&!text.trim())} onClick={submit}>{busy?'Extracting & verifying…':'Run verification'}</button>
      <p className="muted small">Files are validated by the server. Scanned documents require the Tesseract OCR engine; extraction failures are reported and are never treated as verified.</p>
    </section>
    <section className="card"><div className="cardhead"><div><h3>Verification result</h3><span>Evidence-first decision support</span></div></div>{!result?<div className="placeholder">Submit an invoice to see the extracted fields, checks, risk score and decision.</div>:result.error?<div className="error" role="alert">{result.error}</div>:<VerificationResult result={result}/>}</section>
  </div>;
}
function VerificationResult({result}){return <div className="result"><div className="resultTop"><div><span className="label">Decision</span><div className="decision"><Status value={result.result.status}/></div></div><div className="scoreBox"><span>Risk score</span><strong>{result.result.riskScore}<small>/99</small></strong></div></div><div className="detailgrid"><Field label="Invoice" value={result.parsed.invoiceNumber}/><Field label="Vendor" value={result.parsed.vendor||'Unmatched'}/><Field label="Purchase Order" value={result.parsed.poNumber||'—'}/><Field label="Source" value={result.extractionMethod}/><Field label="Pages" value={result.pagesProcessed}/><Field label="Subtotal" value={money(result.parsed.subtotal,result.parsed.currency)}/><Field label="Tax" value={money(result.parsed.tax,result.parsed.currency)}/><Field label="Total" value={money(result.parsed.total,result.parsed.currency)}/><Field label="Quantity" value={result.parsed.quantity}/></div><h4>Verification evidence</h4><div className="reasons">{result.result.checks.map((check,index)=><div key={index}>{check.passed?'✓':'!'} {check.message}</div>)}</div></div>}
function Field({label,value}){return <div><span>{label}</span><b>{value??'—'}</b></div>}
function money(v,currency='INR'){
  if(v==null)return '—';
  try{return new Intl.NumberFormat('en-IN',{style:'currency',currency:currency||'INR'}).format(Number(v));}
  catch{return `${currency||''} ${Number(v).toLocaleString('en-IN')}`.trim();}
}
function safeJson(value){if(!value)return []; if(Array.isArray(value))return value; try{return JSON.parse(value)}catch{return []}}

async function downloadInvoiceDocument(invoiceId) {
  const response=await fetch(`${API}/invoices/${encodeURIComponent(invoiceId)}/document`,{
    headers:{Authorization:`Bearer ${localStorage.getItem('ie_token')}`}
  });
  if(!response.ok)throw new Error((await response.json().catch(()=>({}))).message||'Document download failed');
  const url=URL.createObjectURL(await response.blob());
  const link=document.createElement('a');
  link.href=url;
  link.download=`${invoiceId}-source`;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function InvoiceDrawer({data,user,onClose,onUpdated}) {
  const [detail,setDetail]=useState(null);
  const [loadError,setLoadError]=useState('');
  const [busy,setBusy]=useState(false);
  const [comment,setComment]=useState('');
  const [actionError,setActionError]=useState('');
  const [documentError,setDocumentError]=useState('');
  useEffect(()=>{
    let active=true;
    api(`/invoices/${encodeURIComponent(data.id)}`).then(value=>{if(active)setDetail(value);}).catch(error=>{if(active)setLoadError(error.message);});
    return ()=>{active=false;};
  },[data.id]);
  if(!detail)return <div className="overlay"><div className="drawer"><button className="close" onClick={onClose}>×</button>{loadError?<div className="error" role="alert">{loadError}</div>:<div className="placeholder">Loading invoice…</div>}</div></div>;
  const inv=detail.invoice;
  const review=async action=>{
    setBusy(true);
    setActionError('');
    try{await api(`/invoices/${encodeURIComponent(inv.invoice_id)}/review`,{method:'POST',body:JSON.stringify({action,comment})});onUpdated();}
    catch(error){setActionError(error.message);}
    finally{setBusy(false);}
  };
  const download=async()=>{
    setDocumentError('');
    try{await downloadInvoiceDocument(inv.invoice_id);}
    catch(error){setDocumentError(error.message);}
  };
  return <div className="overlay"><div className="drawer">
    <button className="close" onClick={onClose} aria-label="Close invoice details">×</button>
    <div className="eyebrow">VERIFICATION RECORD</div><h2>{inv.invoice_number}</h2>
    {inv.is_demo&&<span className="demoLabel">SYNTHETIC DEMO RECORD</span>}
    <Status value={inv.status}/>
    {inv.has_document&&<button className="secondary" onClick={download}>Download original document</button>}
    {documentError&&<div className="error" role="alert">{documentError}</div>}
    <div className="detailgrid widegrid">
      <Field label="Vendor" value={inv.vendorName||'Unmatched'}/><Field label="PO" value={inv.po_id||'—'}/>
      <Field label="Invoice date" value={String(inv.invoice_date||'').slice(0,10)}/><Field label="Risk score" value={`${inv.risk_score}/99`}/>
      <Field label="Subtotal" value={money(inv.subtotal,inv.currency)}/><Field label="Tax" value={money(inv.tax,inv.currency)}/>
      <Field label="Total" value={money(inv.total,inv.currency)}/><Field label="Source" value={inv.source_type}/>
    </div>
    <h4>Verification checks</h4><div className="reasons">{safeJson(detail.verification?.checks_json).map((check,index)=><div key={index}>{check.passed?'✓':'!'} {check.message}</div>)}</div>
    <h4>Line items</h4>{detail.items.map((item,index)=><div className="lineItem" key={index}><span>{item.description}</span><b>{item.quantity} × {money(item.unit_price,inv.currency)}</b></div>)}
    <h4>Reviewer action</h4>
    {['reviewer','admin'].includes(user.role)&&inv.status==='NEEDS REVIEW'&&<><textarea className="comment" value={comment} maxLength={1000} onChange={event=>setComment(event.target.value)} placeholder="Add a reason before approving or rejecting"/><div className="reviewBtns"><button disabled={busy||!comment.trim()} onClick={()=>review('APPROVE')} className="approve">Approve</button><button disabled={busy} onClick={()=>review('REQUEST_REVIEW')} className="request">Request review</button><button disabled={busy||!comment.trim()} onClick={()=>review('REJECT')} className="reject">Reject</button></div>{actionError&&<div className="error" role="alert">{actionError}</div>}</>}
    {detail.reviews?.length>0&&<><h4>Review history</h4>{detail.reviews.map(reviewAction=><div className="auditrow" key={reviewAction.review_id}><div className="auditdot"/><div><b>{reviewAction.action}</b><p>{reviewAction.comment||'No comment'}</p></div><time>{new Date(reviewAction.created_at).toLocaleString()}</time></div>)}</>}
  </div></div>;
}

function Vendors({user}){const [rows,setRows]=useState([]);const [form,setForm]=useState({vendorId:'',name:'',email:'',category:'',taxId:''});const load=()=>api('/vendors').then(setRows);useEffect(load,[]);const save=async()=>{try{await api('/vendors',{method:'POST',body:JSON.stringify(form)});setForm({vendorId:'',name:'',email:'',category:'',taxId:''});load();}catch(e){alert(e.message)}};return <div className="split"><section className="card"><div className="cardhead"><div><h3>Vendor master</h3><span>Trusted supplier records used during matching.</span></div></div><div className="tablewrap"><table><thead><tr><th>ID</th><th>Vendor</th><th>Category</th><th>Status</th></tr></thead><tbody>{rows.map(v=><tr key={v.vendor_id}><td>{v.vendor_id}</td><td><b>{v.name}</b><small>{v.email}</small></td><td>{v.category}</td><td><Status value={v.status}/></td></tr>)}</tbody></table></div></section>{user.role==='admin'&&<section className="card"><div className="cardhead"><div><h3>Add vendor</h3><span>Admin-only master-data control.</span></div></div><div className="formgrid"><input placeholder="Vendor ID" value={form.vendorId} onChange={e=>setForm({...form,vendorId:e.target.value})}/><input placeholder="Name" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/><input placeholder="Email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/><input placeholder="Category" value={form.category} onChange={e=>setForm({...form,category:e.target.value})}/><input placeholder="Tax ID" value={form.taxId} onChange={e=>setForm({...form,taxId:e.target.value})}/><button className="primary" onClick={save}>Create vendor</button></div></section>}</div>}

function PurchaseOrders({user}){const [rows,setRows]=useState([]);const [vendors,setVendors]=useState([]);const [form,setForm]=useState({poId:'',vendorId:'V001',poDate:'',notes:'',description:'',quantity:1,unitPrice:1});const load=async()=>{setRows(await api('/purchase-orders'));setVendors(await api('/vendors'))};useEffect(()=>{load()},[]);const save=async()=>{try{await api('/purchase-orders',{method:'POST',body:JSON.stringify({poId:form.poId,vendorId:form.vendorId,poDate:form.poDate,notes:form.notes,items:[{description:form.description,quantity:Number(form.quantity),unitPrice:Number(form.unitPrice)}]})});setForm({...form,poId:'',description:'',quantity:1,unitPrice:1});load();}catch(e){alert(e.message)}};return <div className="split"><section className="card"><div className="cardhead"><div><h3>Purchase-order register</h3><span>Expected commercial terms used for invoice verification.</span></div></div><div className="poCards">{rows.map(po=><div className="poCard" key={po.id}><div><b>{po.id}</b><Status value={po.status}/></div><span>{po.vendorName} · {po.poDate}</span>{po.items.map((it,i)=><p key={i}>{it.description} — {it.quantity} × ₹{Number(it.unitPrice).toLocaleString('en-IN')}</p>)}</div>)}</div></section>{['admin','finance'].includes(user.role)&&<section className="card"><div className="cardhead"><div><h3>Create purchase order</h3><span>Used to create controlled reference data for demos.</span></div></div><div className="formgrid"><input placeholder="PO ID" value={form.poId} onChange={e=>setForm({...form,poId:e.target.value})}/><select value={form.vendorId} onChange={e=>setForm({...form,vendorId:e.target.value})}>{vendors.map(v=><option key={v.vendor_id} value={v.vendor_id}>{v.vendor_id} — {v.name}</option>)}</select><input type="date" value={form.poDate} onChange={e=>setForm({...form,poDate:e.target.value})}/><input placeholder="Item description" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/><input type="number" placeholder="Quantity" value={form.quantity} onChange={e=>setForm({...form,quantity:e.target.value})}/><input type="number" placeholder="Unit price" value={form.unitPrice} onChange={e=>setForm({...form,unitPrice:e.target.value})}/><input placeholder="Notes" value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/><button className="primary" onClick={save}>Create PO</button></div></section>}</div>}

function Audit(){const [rows,setRows]=useState([]);useEffect(()=>{api('/audit-logs').then(setRows)},[]);return <section className="card"><div className="cardhead"><div><h3>Audit trail</h3><span>Traceability for processing and review decisions.</span></div></div><div>{rows.map(r=><div className="auditrow" key={r.id}><div className="auditdot"/><div><b>{r.action} · {r.status}</b><p>{r.details||'—'} · {r.invoiceId||'system'}</p><span>{r.userName||'system user'}</span></div><time>{new Date(r.createdAt).toLocaleString()}</time></div>)}</div></section>}

createRoot(document.getElementById('root')).render(<App />);
