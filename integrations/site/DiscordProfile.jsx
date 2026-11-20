import React, { useCallback, useEffect, useRef, useState } from 'react';
import './discord-profile.css';

// This component has no bot URL, server secret, Discord ID input, or auth session of its own.
const endpoint = '/api/profile/discord/v1/';
const roleLabels = { vip_monarch: 'VIP Monarch', vip_basic: 'VIP Basic', creator: 'Creator معتمد' };
const membershipLabels = { member: 'عضو في سيرفر BLACK X', not_member: 'الحساب لسه مش منضم للسيرفر', pending: 'كمّل قبول قوانين السيرفر على ديسكورد' };
const statusLabels = { opening: 'قيد الفتح', open: 'مفتوحة', claimed: 'مع الدعم', closed: 'مقفولة' };
const typeLabels = { site: 'مشكلة في الموقع', report: 'بلاغ' };
const roomLabels = { opening: 'لسه روم ديسكورد ما اتجهزش.', blocked: 'المحتوى مش متاح لأن أذونات روم ديسكورد محتاجة مراجعة.',
  missing: 'روم ديسكورد مش موجود. خلي فريق الدعم يراجع التذكرة.' };
const date = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Cairo' });
const formatDate = (time) => Number.isFinite(time) ? date.format(time) : '—';
const isRoomUrl = (url) => /^https:\/\/discord\.com\/channels\/\d{17,20}\/\d{17,20}$/u.test(url ?? '');

function useResource(api, action, id) {
  const [load, setLoad] = useState(0);
  const [result, setResult] = useState({});
  useEffect(() => {
    const controller = new AbortController();
    setResult((previous) => ({ ...previous, error: undefined, loading: true }));
    api(action, id ? { id } : {}, controller.signal).then(
      (data) => { if (!controller.signal.aborted) setResult({ data }); },
      (error) => { if (!controller.signal.aborted) setResult({ error }); },
    );
    return () => controller.abort();
  }, [api, action, id, load]);
  return { ...result, refresh: () => setLoad((index) => index + 1) };
}

function useAction() {
  const locked = useRef(false);
  const [state, setState] = useState({});
  return { ...state, async run(execute, onError) {
    if (locked.current) return;
    locked.current = true;
    setState({ busy: true });
    try { setState({ notice: await execute() }); }
    catch (error) { setState({ error }); onError?.(error); }
    finally { locked.current = false; }
  } };
}

function Feedback({ loading, error, notice }) {
  return <>{loading && <p role="status">بيحمّل…</p>}{error && <p role="alert">{error.message}</p>}{notice && <p role="status">{notice}</p>}</>;
}

function TicketThread({ api, id, staff, onChange }) {
  const prefix = staff ? 'staff/tickets/' : 'tickets/';
  const detail = useResource(api, `${prefix}detail`, id);
  const action = useAction();
  const [body, setBody] = useState('');
  const [reason, setReason] = useState('');
  const request = useRef();
  const record = detail.data;
  const ticket = record?.ticket;
  const submitReply = (event) => {
    event.preventDefault();
    if (!body.trim()) return;
    void action.run(async () => {
      if (request.current?.body !== body) request.current = { body, requestId: crypto.randomUUID() };
      const { message } = await api(`${prefix}reply`, { id, ...request.current });
      request.current = undefined;
      setBody('');
      detail.refresh();
      return message.delivery === 'sent' ? 'اتشارك الرد ووصل لروم ديسكورد.' : 'الرد محفوظ، لكن وصوله إلى ديسكورد غير مؤكّد. راجع الروم قبل أي إعادة إرسال.';
    });
  };
  const staffUpdate = (operation, fields = {}) => void action.run(async () => {
    await api(`${prefix}${operation}`, { id, ...fields });
    onChange();
    detail.refresh();
    return operation === 'claim' ? 'استلمت التذكرة.' : 'التذكرة اتقفلت.';
  });
  return <div className="bx-bridge-card">
    <div className="bx-bridge-row"><h4>تذكرة <bdi>{id}</bdi></h4><button type="button" onClick={detail.refresh}>حدّث المحادثة</button></div>
    <Feedback {...detail} />
    <Feedback {...action} />
    {ticket && <>
      <p>{typeLabels[ticket.type]} · {statusLabels[ticket.status]} · {formatDate(ticket.createdAt)} (القاهرة)</p>
      {isRoomUrl(ticket.discordUrl) && <a href={ticket.discordUrl} target="_blank" rel="noopener noreferrer">افتح روم التذكرة في ديسكورد ↗</a>}
      {roomLabels[ticket.roomState] && <p>{roomLabels[ticket.roomState]}</p>}
      {record.reason && <p className="bx-bridge-text">سبب الإغلاق: {record.reason}</p>}
      {ticket.roomState === 'available' && <>
        <p className="bx-bridge-note">هنا الرسائل اللي اتشاركت صراحةً بس. الكلام العادي في روم ديسكورد مش بيظهر هنا.</p>
        {record.messages.length ? <ol className="bx-bridge-messages">{record.messages.map((message) => <li key={message.id}>
          <strong>{message.side === 'support' ? 'الدعم' : 'صاحب التذكرة'}</strong> · {message.origin === 'site' ? 'الموقع' : 'ديسكورد'} · {formatDate(message.at)}
          {message.delivery !== 'sent' && <span> · وصول ديسكورد غير مؤكّد</span>}
          <p className="bx-bridge-text" dir="auto">{message.body}</p>
        </li>)}</ol> : <p>مفيش رسائل مشتركة لحد دلوقتي.</p>}
      </>}
      {ticket.writable && <form onSubmit={submitReply} className="bx-bridge-stack">
        <label>رسالتك المشتركة مع ديسكورد<textarea required maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} disabled={action.busy} /></label>
        <p className="bx-bridge-note">ما تبعتش كلمات مرور، توكنات أو معلومات حساسة.</p>
        <button type="submit" disabled={action.busy || !body.trim()}>أرسل الرد</button>
      </form>}
      {staff && ticket.status !== 'closed' && <div className="bx-bridge-stack">
        {ticket.status === 'open' && ticket.writable && <button type="button" disabled={action.busy} onClick={() => staffUpdate('claim')}>استلم التذكرة</button>}
        {ticket.roomState !== 'blocked' && <form className="bx-bridge-stack" onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim()) staffUpdate('close', { reason });
        }}><label>سبب الإغلاق (ظاهر لصاحب التذكرة)<input required maxLength={250} value={reason} onChange={(e) => setReason(e.target.value)} disabled={action.busy} /></label>
          <button type="submit" disabled={action.busy || !reason.trim()}>اقفل التذكرة للكتابة</button></form>}
      </div>}
    </>}
  </div>;
}

function TicketBoard({ api, staff = false, canOpen = false, refreshProfile }) {
  const list = useResource(api, staff ? 'staff/tickets/list' : 'tickets/list');
  const [selected, setSelected] = useState(null);
  const [type, setType] = useState('site');
  const action = useAction();
  const request = useRef();
  const open = (event) => {
    event.preventDefault();
    void action.run(async () => {
      if (request.current?.type !== type) request.current = { type, requestId: crypto.randomUUID() };
      const { ticket } = await api('tickets/open', request.current);
      request.current = undefined;
      setSelected(ticket.id);
      list.refresh();
      return 'اتفتحت التذكرة. ابعت التفاصيل من هنا أو من روم ديسكورد.';
    }, (error) => {
      if (error.code === 'ADMIN_DUPLICATE_REQUEST') { request.current = undefined; list.refresh(); }
      if (error.code === 'ADMIN_PAUSED') refreshProfile?.();
    });
  };
  const hasActive = list.data?.tickets.some((ticket) => ticket.status !== 'closed');
  const canRecover = request.current && list.data?.tickets.some((ticket) => ticket.status === 'opening');
  return <section className="bx-bridge-stack">
    <div className="bx-bridge-row"><h3>{staff ? 'صندوق الدعم' : 'تذاكري'}</h3><button type="button" onClick={list.refresh}>حدّث القائمة</button></div>
    <Feedback {...list} />
    <Feedback {...action} />
    {!staff && canOpen && list.data && (!hasActive || canRecover) && <form onSubmit={open} className="bx-bridge-row">
      <label>نوع التذكرة <select value={type} onChange={(e) => setType(e.target.value)} disabled={action.busy || Boolean(canRecover)}>
        <option value="site">مشكلة في الموقع</option><option value="report">بلاغ</option></select></label>
      <button type="submit" disabled={action.busy}>{canRecover ? 'كمّل فتح التذكرة' : 'افتح تذكرة خاصة'}</button>
    </form>}
    {!staff && !canOpen && <p className="bx-bridge-note">فتح تذكرة جديدة غير متاح حاليًا. لو عندك تذكرة مفتوحة، تقدر تتابعها من هنا.</p>}
    {list.data && (list.data.tickets.length ? <ul className="bx-bridge-list">{list.data.tickets.map((ticket) => <li key={ticket.id}>
      <button type="button" aria-pressed={selected === ticket.id} onClick={() => setSelected(ticket.id)}>{typeLabels[ticket.type]} · {statusLabels[ticket.status]} · <bdi>{ticket.id}</bdi></button>
    </li>)}</ul> : <p>مفيش تذاكر محفوظة.</p>)}
    {selected && <TicketThread key={selected} id={selected} api={api} staff={staff} onChange={list.refresh} />}
  </section>;
}

function Dashboard({ api, onIntakeChange }) {
  const dashboard = useResource(api, 'dashboard');
  const action = useAction();
  const [showInbox, setShowInbox] = useState(false);
  const data = dashboard.data;
  return <section className="bx-bridge-card bx-bridge-stack">
    <div className="bx-bridge-row"><h3>لوحة بوت BLACK X</h3><button type="button" onClick={dashboard.refresh}>حدّث الحالة</button></div>
    <Feedback {...dashboard} />
    <Feedback {...action} />
    {data && <>
      <dl className="bx-bridge-stats">
        <div><dt>حالة الاتصال</dt><dd>{data.health.ready ? 'جاهز' : 'غير جاهز'}</dd></div>
        <div><dt>أعضاء السيرفر</dt><dd>{data.health.memberCount ?? '—'}</dd></div>
        <div><dt>الترحيب التلقائي</dt><dd>{data.welcomeEnabled ? 'مفعّل' : 'متوقف'}</dd></div>
        <div><dt>تذاكر نشطة</dt><dd>{data.tickets.counts.open + data.tickets.counts.claimed + data.tickets.counts.opening}</dd></div>
        <div><dt>استقبال تذاكر جديدة</dt><dd>{!data.adminEnabled || !data.tickets.configured ? 'مش جاهز' : data.tickets.paused ? 'متوقف' : 'شغّال'}</dd></div>
        <div><dt>أعمال محفوظة في البوت</dt><dd>{data.catalog.count}</dd></div>
      </dl>
      <p>آخر دفعة كتالوج مقبولة: {formatDate(data.catalog.lastAccepted?.at)} (القاهرة).</p>
      {data.catalog.lastRejectedSinceBoot && <p>آخر رفض من بداية تشغيل البوت: <code>{data.catalog.lastRejectedSinceBoot.code}</code> · {formatDate(data.catalog.lastRejectedSinceBoot.at)}.</p>}
      <details><summary>بصمة معرفات الكتالوج</summary><code className="bx-bridge-text">{data.catalog.idsSha256}</code><p className="bx-bridge-note">العدد والبصمة حالة نسخة البوت؛ مش تأكيد إن كل كتالوج الموقع اتزامن.</p></details>
      <p className="bx-bridge-note">آخر قراءة: {formatDate(data.observedAt)} (القاهرة)</p>
      {data.tickets.canSetIntake && <button type="button" disabled={action.busy} onClick={() => void action.run(async () => {
        const { paused } = await api('staff/tickets/intake', { paused: !data.tickets.paused });
        dashboard.refresh();
        onIntakeChange();
        return paused ? 'فتح تذاكر جديدة اتوقف على الموقع وديسكورد. التذاكر الحالية مستمرة.' : 'فتح التذاكر رجع على الموقع وديسكورد.';
      })}>{data.tickets.paused ? 'استأنف فتح التذاكر' : 'أوقف فتح التذاكر'}</button>}
    </>}
    <button type="button" aria-expanded={showInbox} onClick={() => setShowInbox(!showInbox)}>{showInbox ? 'اخفِ صندوق الدعم' : 'اعرض صندوق الدعم'}</button>
    {showInbox && <TicketBoard api={api} staff />}
  </section>;
}

// Mount with key={`${siteUserId}:${currentVerifiedLinkVersion}`} and unmount on logout.
// fetchImpl can be the site's existing authenticated same-origin fetch function.
export function DiscordProfileBridge({ linkControls = null, siteStaff = false, fetchImpl = fetch }) {
  const api = useCallback(async (action, body, signal) => {
    let response;
    let data;
    try {
      response = await fetchImpl(endpoint + action, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'error' });
      data = await response.json();
    } catch { throw new Error('الاتصال ببوت BLACK X مش متاح. جرّب تاني.'); }
    if (!response.ok || data?.ok !== true) throw Object.assign(new Error(data?.message || 'الطلب ما اكتملش.'), { code: data?.code });
    return data;
  }, [fetchImpl]);
  const profile = useResource(api, 'profile');
  const entry = profile.data;
  const refreshProfile = profile.refresh;
  return <section dir="rtl" lang="ar" className="bx-profile-bridge bx-bridge-stack" aria-label="حساب ديسكورد والدعم">
    <div className="bx-bridge-card bx-bridge-stack">
      <div className="bx-bridge-row"><h2>ديسكورد BLACK X</h2><button type="button" onClick={refreshProfile}>حدّث الحساب</button></div>
      {linkControls}
      <Feedback {...profile} />
      {entry && <><p>{membershipLabels[entry.membership]}</p><p>رولات الموقع على ديسكورد: {entry.roles.map((role) => roleLabels[role]).join('، ') || 'لا توجد'}</p></>}
      {entry?.capabilities.canUseTickets && <TicketBoard api={api} canOpen={entry.capabilities.canOpenTicket} refreshProfile={refreshProfile} />}
    </div>
    {siteStaff && entry?.capabilities.canViewDashboard && <Dashboard api={api} onIntakeChange={refreshProfile} />}
  </section>;
}
