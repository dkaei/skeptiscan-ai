import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CheckInputSchema, type Capabilities, type CheckInput, type CheckResult, type InputMode } from '../shared/contracts';
import { ApiFailure, cancelWaitingCheck, checkInput, getCapabilities, type ApiFailureKind } from './api';
import { prepareImage, type PreparedImage } from './image';
import { inspectLinkInput, localUserinfoResult } from './linkInput';
import { Icon } from './Icon';
import ScanBanner from './ScanBanner';
import CheckResultView from './CheckResultView';
import SupportPanel from './SupportPanel';
import HelpPage from './HelpPage';
import { correctionText } from './resultPresentation';
import s from './App.module.css';

const MODES: InputMode[] = ['message', 'call', 'link', 'screenshot'];
const LABELS: Record<InputMode, string> = { message: 'Message', call: 'Call', link: 'Link', screenshot: 'Screenshot' };
interface Draft { content: string; context: string; senderEmail: string; senderPhone: string; externalLookup: boolean; detailsOpen: boolean }
const emptyDraft = (): Draft => ({ content: '', context: '', senderEmail: '', senderPhone: '', externalLookup: false, detailsOpen: false });
const initialDrafts = (): Record<InputMode, Draft> => ({ message: emptyDraft(), call: emptyDraft(), link: emptyDraft(), screenshot: emptyDraft() });
function urlHosts(content: string) {
  const found = content.match(/(?:https?:\/\/|www\.)[^\s<>"']+/gi) || [];
  return [...new Set(found.flatMap(value => { try { return [new URL(value.startsWith('www.') ? `https://${value}` : value).hostname]; } catch { return []; } }))].slice(0, 3);
}

export default function App() {
  const navigate = useNavigate(), location = useLocation();
  const path = location.pathname;
  const activePath = useRef(path);
  activePath.current = path;
  const possibleMode = path.split('/')[2] as InputMode;
  const editor = path.startsWith('/check/') && MODES.includes(possibleMode);
  const mode: InputMode = editor ? possibleMode : 'message';
  const home = path === '/', settings = path === '/settings', help = path === '/help', resultPage = path === '/result';
  const [drafts, setDrafts] = useState(initialDrafts);
  const [image, setImage] = useState<PreparedImage | null>(null);
  const imageRef = useRef<PreparedImage | null>(null), imageGeneration = useRef(0);
  const [preparing, setPreparing] = useState(false);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [capabilityFailure, setCapabilityFailure] = useState<ApiFailure | null>(null);
  const [capabilityRefresh, setCapabilityRefresh] = useState(0);
  const [large, setLarge] = useState(false), [reduced, setReduced] = useState(false);
  const title = 'Check before you act';
  const [result, setResult] = useState<CheckResult | null>(null);
  const [submitted, setSubmitted] = useState<CheckInput | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [failure, setFailure] = useState<{ text: string; field?: string; kind?: ApiFailureKind } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const waitingCheck = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfterRoute = useRef<string | null>(null);
  const draft = drafts[mode];
  const linkInput = mode === 'link' ? inspectLinkInput(draft.content) : null;
  const localLink = linkInput?.kind === 'userinfo';

  useEffect(() => {
    const abort = new AbortController(); setCapabilityError(false); setCapabilityFailure(null);
    getCapabilities(abort.signal).then(next => { setCapabilities(next); setFailure(current => current?.kind === 'sign_in' ? null : current); }).catch(error => { if (error.name !== 'AbortError') { setCapabilityError(true); setCapabilityFailure(error instanceof ApiFailure ? error : null); } });
    return () => abort.abort();
  }, [capabilityRefresh]);
  useEffect(() => {
    const leavePage = () => abandonWaiting();
    window.addEventListener('pagehide', leavePage);
    return () => { window.removeEventListener('pagehide', leavePage); controller.current?.abort(); if (waitingCheck.current) void cancelWaitingCheck(waitingCheck.current); if (imageRef.current) URL.revokeObjectURL(imageRef.current.preview); imageGeneration.current++; };
  }, []);
  useEffect(() => {
    if (controller.current) { controller.current.abort(); controller.current = null; abandonWaiting(); setBusy(false); }
    if (path !== '/result' && path !== '/settings') abandonWaiting();
    setFailure(null); setNotice('');
    const id = requestAnimationFrame(() => {
      const selector = focusAfterRoute.current;
      const target = selector ? document.querySelector<HTMLElement>(selector) : heading.current;
      target?.focus({ preventScroll: true }); focusAfterRoute.current = null;
      window.scrollTo(0, 0);
    });
    return () => cancelAnimationFrame(id);
  }, [path]);
  useEffect(() => { document.title = `${home ? 'Check before you act' : editor ? LABELS[mode] : settings ? 'Settings' : help ? 'Help' : 'Your check'} | SkeptiScan AI`; }, [path, home, editor, mode, settings, help]);

  function update(patch: Partial<Draft>) {
    setDrafts(all => ({ ...all, [mode]: { ...all[mode], ...patch } })); setFailure(null); setNotice('');
  }
  function abandonWaiting() {
    const requestId = waitingCheck.current;
    if (!requestId) return;
    waitingCheck.current = null;
    void cancelWaitingCheck(requestId);
    setResult(current => current?.requestId === requestId ? { ...current, status: 'partial', question: null, continuation: undefined,
      title: 'Check incomplete', reason: 'The follow-up question was not completed.',
      nextStep: 'Confirm the request through a contact route you already trust.',
      uncertainty: 'No completed assessment is available.', recovery: 'edit_input', notice: undefined,
    } : current);
  }
  function cancel() {
    controller.current?.abort(); controller.current = null; abandonWaiting(); setBusy(false);
    setNotice('Check cancelled. Your input is still here.');
    requestAnimationFrame(() => {
      // A navigation has its own focus target. Only restore focus when staying here.
      if (activePath.current !== path) return;
      const target = resultPage ? heading.current : document.getElementById(mode === 'screenshot' ? 'input-image' : 'input-content');
      target?.focus({ preventScroll: true });
    });
  }
  function go(to: string, focus?: string) { if (busy) cancel(); if (focus) focusAfterRoute.current = focus; navigate(to); }
  function openSettings() { if (busy) cancel(); navigate('/settings', { state: { returnPath: path } }); }
  function back() {
    if (settings) go((location.state as { returnPath?: string } | null)?.returnPath || '/', '#settings-button');
    else if (resultPage && submitted) go(`/check/${submitted.mode}`);
    else go('/', `#entry-${editor ? mode : 'screenshot'}`);
  }
  function fieldError(text: string, field = 'content') {
    setFailure({ text, field });
    if (field === 'senderEmail' || field === 'senderPhone') setDrafts(all => ({ ...all, [mode]: { ...all[mode], detailsOpen: true } }));
    if (field === 'content' && mode === 'screenshot') setCorrectionOpen(true);
    requestAnimationFrame(() => document.getElementById(`input-${field}`)?.focus());
  }
  async function chooseImage(file?: File) {
    if (!file) return;
    const generation = ++imageGeneration.current;
    const replacingImage = Boolean(imageRef.current);
    setPreparing(true); setFailure(null); setNotice('');
    try {
      const next = await prepareImage(file);
      if (generation !== imageGeneration.current) { URL.revokeObjectURL(next.preview); return; }
      if (imageRef.current) URL.revokeObjectURL(imageRef.current.preview);
      imageRef.current = next; setImage(next);
      // Keep text entered before the first image; replacing an image clears its old correction.
      if (replacingImage) {
        setCorrectionOpen(false);
        setDrafts(all => ({ ...all, screenshot: { ...all.screenshot, content: '' } }));
      }
    } catch (error) {
      if (generation === imageGeneration.current) {
        const message = error instanceof Error ? error.message : 'The image could not be opened.';
        if (activePath.current === '/check/screenshot') fieldError(message, 'image');
        else setNotice(`Screenshot preparation failed. ${message}`);
      }
    }
    finally { if (generation === imageGeneration.current) setPreparing(false); }
  }
  function removeImage() { imageGeneration.current++; setPreparing(false); setCorrectionOpen(false); if (imageRef.current) URL.revokeObjectURL(imageRef.current.preview); imageRef.current = null; setImage(null); update({ content: '' }); requestAnimationFrame(() => document.getElementById('input-image')?.focus()); }
  function currentInput(): CheckInput | null {
    if (mode === 'link' && linkInput?.kind === 'invalid') { fieldError('Unsupported website address. No link was opened.'); return null; }
    const input = { mode, content: draft.content.trim(), context: draft.context.trim(), senderEmail: draft.senderEmail.trim(), senderPhone: draft.senderPhone.trim(), externalLookup: !localLink && capabilities?.linkReputation ? draft.externalLookup : false, ...(mode === 'screenshot' && image ? { image: { base64: image.base64, mimeType: image.mimeType } } : {}) };
    const validated = CheckInputSchema.safeParse(input);
    if (!validated.success) { const issue = validated.error.issues[0]; const field = String(issue.path[0] || 'content'); fieldError(field === 'senderEmail' ? 'Enter a valid email address or leave it blank.' : issue.message, field); return null; }
    return validated.data;
  }
  async function submit(event?: FormEvent, answer?: 'yes' | 'no' | 'unsure', retry = false) {
    event?.preventDefault(); if (busy || preparing || controller.current) return;
    const input = answer || retry ? submitted : currentInput(); if (!input) return;
    if (!answer && !retry && linkInput?.kind === 'userinfo') {
      abandonWaiting(); setFailure(null); setNotice('');
      setSubmitted(input); setResult(localUserinfoResult(linkInput.host, crypto.randomUUID(), new Date().toISOString()));
      navigate('/result');
      requestAnimationFrame(() => heading.current?.focus());
      return;
    }
    if (!capabilities) { setFailure({ text: capabilityFailure?.message || (capabilityError ? 'Connection unavailable. Your input is still here.' : 'Connecting. Please wait.'), kind: capabilityFailure?.kind }); return; }
    if (answer && (!result?.continuation || waitingCheck.current !== result.requestId)) { setFailure({ text: 'This question has closed. Edit your input to start another check.' }); return; }
    if (!answer) abandonWaiting();
    if (input.mode === 'screenshot' && !capabilities.screenshots) { setFailure({ text: 'Screenshot analysis is not available yet. You can paste the message instead.' }); return; }
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setFailure(null); setNotice('');
    try {
      const next = await checkInput(input, abort.signal, answer && result?.continuation ? { requestId: result.requestId, continuation: result.continuation, answer } : undefined);
      if (abort.signal.aborted) return;
      waitingCheck.current = next.continuation ? next.requestId : null;
      setSubmitted(input); setResult(next); navigate('/result');
      requestAnimationFrame(() => heading.current?.focus());
    } catch (error) {
      if (!abort.signal.aborted) {
        if (answer) abandonWaiting();
        if (error instanceof ApiFailure && error.kind === 'sign_in') { setCapabilityError(true); setCapabilityFailure(error); }
        if (error instanceof ApiFailure && error.field && editor) fieldError(error.message, error.field);
        else {
          setFailure({ text: error instanceof ApiFailure ? error.message : 'The check could not finish. Your input is still here.', kind: error instanceof ApiFailure ? error.kind : 'network' });
          if (resultPage || (error instanceof ApiFailure && error.kind === 'sign_in')) requestAnimationFrame(() => document.getElementById('form-error')?.focus());
        }
      }
    } finally { if (controller.current === abort) { setBusy(false); controller.current = null; } }
  }
  function editInput(focus?: string) {
    if (!submitted) return;
    go(`/check/${submitted.mode}`, focus);
  }
  function correctInput() {
    if (submitted?.mode !== 'screenshot') { editInput('#input-content'); return; }
    const conflicts = result?.extraction?.screenshotIssues?.filter(issue => issue.kind === 'conflicting_accounts' && issue.consequential) ?? [];
    if (conflicts.length && conflicts.every(issue => issue.userSource === 'context')) { editInput('#input-context'); return; }
    setCorrectionOpen(true);
    setDrafts(all => ({ ...all, screenshot: { ...all.screenshot, content: correctionText(all.screenshot.content, result?.extraction?.transcript) } }));
    editInput('#input-content');
  }
  const errorFor = (field: string) => failure?.field === field;
  const errorAttributes = (field: string, description?: string) => ({ 'aria-invalid': errorFor(field) || undefined, 'aria-describedby': [errorFor(field) ? 'form-error' : '', description].filter(Boolean).join(' ') || undefined });
  const senderDetails = <details className={s.senderDetails} open={draft.detailsOpen} onToggle={event => { const open = event.currentTarget.open; setDrafts(all => all[mode].detailsOpen === open ? all : ({ ...all, [mode]: { ...all[mode], detailsOpen: open } })); }}>
    <summary>Sender details <span className={s.optional}>(optional)</span><Icon name="down" /></summary>
    <div className={s.detailFields}>
      <label className={s.field}>Email<input id="input-senderEmail" type="email" autoComplete="off" maxLength={254} value={draft.senderEmail} onChange={e => update({ senderEmail: e.target.value })} {...errorAttributes('senderEmail')} /></label>
      <label className={s.field}>Phone number<input id="input-senderPhone" type="tel" autoComplete="off" maxLength={50} value={draft.senderPhone} onChange={e => update({ senderPhone: e.target.value })} {...errorAttributes('senderPhone')} /></label>
    </div>
  </details>;
  const picker = (compact = false) => <label className={compact ? s.fileChange : s.upload}>
    <input id="input-image" type="file" accept="image/png,image/jpeg,image/webp" aria-label={compact ? 'Change screenshot' : 'Choose screenshot'} onChange={event => { void chooseImage(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} disabled={busy || preparing} {...errorAttributes('image')} />
    {!compact && <img src="/assets/screenshot.svg" alt="" />}
    <strong>{compact ? 'Change screenshot' : preparing ? 'Preparing image…' : 'Choose screenshot'}</strong>
    {!compact && <span>Keep the sender and message visible.</span>}
  </label>;
  const serviceNote = localLink ? 'This link stays on your device. No AI or external lookup will run.' : capabilities ? capabilities.ai ? 'Your input is sent to OpenAI for this check. Leave out passwords and one-time codes.' : 'AI is not connected. Only available local checks will run.' : capabilityError ? 'Service availability could not be confirmed.' : 'Connecting to the checking service…';
  const enabled = mode === 'screenshot' ? Boolean(image && capabilities?.screenshots) : Boolean(draft.content.trim() && (capabilities || localLink));
  const includedHosts = mode === 'message' || mode === 'call' ? urlHosts(draft.content) : [];
  const signInNeeded = failure?.kind === 'sign_in' || capabilityFailure?.kind === 'sign_in';
  const reconnect = () => setCapabilityRefresh(value => value + 1);
  const signInActions = <div className={s.reconnectActions}><a className={s.cta} href="/" target="_blank" rel="noopener noreferrer">Sign in<span className={s.sr}> (opens in a new tab)</span></a><button type="button" className={s.textButton} onClick={reconnect}>Check connection</button></div>;
  const failurePanel = failure && <div className={s.failurePanel}>
    <p id="form-error" className={s.error} role="alert" tabIndex={-1}>{failure.text}</p>
    {failure.kind === 'sign_in' ? signInActions : resultPage && <button className={s.secondaryButton} onClick={() => editInput()}>Back to input</button>}
  </div>;
  const retryLabel = failure && ['network', 'timeout', 'malformed_response'].includes(failure.kind ?? '') ? 'Try again' : `Check ${mode}`;

  return <div className={`${s.app} ${large ? s.large : ''} ${reduced ? s.reduced : ''}`}>
    <a href="#main" className={s.skip}>Skip to content</a>
    <header className={`${s.header} ${!home && s.flowHeader}`}>
      {home ? <div className={s.wordmark}><img src="/assets/second-look.svg" alt="" /><span>SkeptiScan<sup>AI</sup></span></div> : <button className={s.back} onClick={back}><Icon name="back" />Back</button>}
      {!home && <span className={s.headerTitle}>{settings ? 'Settings' : help ? 'Help' : resultPage ? 'Your check' : 'Check'}</span>}
      {settings ? <span className={s.headerSpacer} /> : <button id="settings-button" className={s.settings} onClick={openSettings} aria-label="Settings"><Icon name="settings" /></button>}
    </header>
    <main id="main" className={s.main} key={path}>
      {home && <>
        <h1 ref={heading} tabIndex={-1} className={s.homeTitle}>{title}</h1>
        <ScanBanner reduced={reduced} onClick={() => go('/check/screenshot')} />
        <div className={s.trio}>{(['message', 'call', 'link'] as const).map(key => <button id={`entry-${key}`} key={key} onClick={() => go(`/check/${key}`)}><img src={`/assets/${key}.svg`} alt="" /><span>{key === 'message' ? 'Enter message' : key === 'call' ? 'Describe call' : 'Check link'}</span></button>)}</div>
        {(!capabilities?.ai || capabilityError) && <div className={s.availability}><Icon name="info" /><div><p>{capabilityError ? capabilityFailure?.message || 'The checking service is unavailable.' : capabilities ? 'Local checks only. AI is not connected.' : 'Connecting to the checking service…'}</p>{capabilityError && (signInNeeded ? signInActions : <button className={s.textButton} onClick={reconnect}>Check connection</button>)}</div></div>}
        <SupportPanel />
      </>}
      {editor && <>
        <h1 ref={heading} tabIndex={-1} className={s.sr}>{LABELS[mode]}</h1>
        <div className={s.modes} role="group" aria-label="Input type">{MODES.map(key => <button key={key} aria-pressed={mode === key} onClick={() => go(`/check/${key}`)} disabled={busy}>{LABELS[key]}</button>)}</div>
        <form className={s.form} onSubmit={event => void submit(event)} noValidate>
          <fieldset disabled={busy} className={s.fields}>
          {mode === 'screenshot' ? <>
            {image ? <><img key={image.preview} className={s.imagePreview} src={image.preview} alt="Your prepared screenshot" /><div className={s.imageActions}>{picker(true)}<button type="button" className={s.textButton} onClick={removeImage}>Remove</button></div><p className={s.smallNote}>Prepared on your device. Check that the text is readable.</p></> : <>{picker()}<p className={s.formatNote}>PNG, JPG or WebP, up to 10 MB</p></>}
            {preparing && <p className={s.smallNote} role="status">Preparing your screenshot…</p>}
            {!capabilities?.screenshots && <p className={s.info} role="status">{!capabilities ? capabilityError ? 'Screenshot availability could not be confirmed. Your image stays on this device.' : 'Checking screenshot availability… Your image stays on this device.' : 'Screenshot analysis is not available yet. Your image stays on this device. You can paste the message instead.'}</p>}
            {!correctionOpen && <button type="button" className={s.textButton} onClick={() => { setCorrectionOpen(true); requestAnimationFrame(() => document.getElementById('input-content')?.focus()); }}>Add text <span className={s.optional}>&nbsp;(optional)</span></button>}
            {correctionOpen && <label className={`${s.field} ${s.secondary} ${s.reveal}`}>Text or corrections <span className={s.optional}>(optional)</span><textarea id="input-content" value={draft.content} maxLength={6000} onChange={e => update({ content: e.target.value })} {...errorAttributes('content')} /><span className={s.smallNote}>Your text will be included with the screenshot.</span></label>}
            <label className={`${s.field} ${s.secondary}`}>Context <span className={s.optional}>(optional)</span><input id="input-context" type="text" autoComplete="off" maxLength={500} value={draft.context} onChange={e => update({ context: e.target.value })} {...errorAttributes('context')} /></label>
            {senderDetails}
          </> : <>
            <label className={s.field} htmlFor="input-content">{mode === 'message' ? 'Message' : mode === 'call' ? 'Call details' : 'Website address'}</label>
            {mode === 'link' ? <input id="input-content" className={s.input} type="text" inputMode="url" autoCapitalize="none" autoComplete="off" spellCheck={false} value={draft.content} placeholder="Paste the link" maxLength={6000} onChange={e => update({ content: e.target.value })} {...errorAttributes('content', localLink ? 'link-local-note' : undefined)} /> : <div className={s.composer}><textarea id="input-content" value={draft.content} placeholder={mode === 'message' ? 'Paste or type your message' : 'Who called, and what did they ask you to do?'} maxLength={6000} onChange={e => update({ content: e.target.value })} {...errorAttributes('content')} />{draft.content && <div className={s.composerFoot}><span>{draft.content.length >= 5500 ? `${draft.content.length.toLocaleString()} / 6,000` : ''}</span><button type="button" className={s.textButton} onClick={() => { update({ content: '' }); document.getElementById('input-content')?.focus(); }}>Clear</button></div>}</div>}
            {localLink && linkInput?.kind === 'userinfo' && <p id="link-local-note" className={s.info} style={{ overflowWrap: 'anywhere' }}>Actual host: <strong>{linkInput.host}</strong>. Text before @ is not the destination. This check stays on your device.</p>}
            {includedHosts.length > 0 && <div className={s.detected}><img src="/assets/link.svg" alt="" /><div><span>Links included</span><p>{includedHosts.join(', ')}</p></div></div>}
            {mode === 'message' && senderDetails}
            {mode === 'call' && <label className={`${s.field} ${s.secondary}`}>Caller’s number <span className={s.optional}>(optional)</span><input id="input-senderPhone" type="tel" autoComplete="off" maxLength={50} value={draft.senderPhone} onChange={e => update({ senderPhone: e.target.value })} {...errorAttributes('senderPhone')} /></label>}
            {(mode === 'message' || mode === 'call') && <label className={`${s.field} ${s.secondary}`}>Context <span className={s.optional}>(optional)</span><input id="input-context" type="text" autoComplete="off" maxLength={500} value={draft.context} onChange={e => update({ context: e.target.value })} {...errorAttributes('context')} /></label>}
            {mode === 'link' && <label className={`${s.field} ${s.secondary}`}>Where did you receive it? <span className={s.optional}>(optional)</span><input id="input-context" type="text" autoComplete="off" maxLength={500} value={draft.context} onChange={e => update({ context: e.target.value })} /></label>}
          </>}
          {capabilities?.linkReputation && !localLink && <label className={s.checkbox}><input type="checkbox" checked={draft.externalLookup} onChange={e => update({ externalLookup: e.target.checked })} /><span>Include a website reputation lookup <span className={s.optional}>(optional)</span><small>Only eligible public homepage addresses are sent to Google Web Risk. Links with paths or private details are excluded.</small></span></label>}
          </fieldset>
          {failurePanel}
          <div className={s.submitArea}>{!signInNeeded && <button className={s.cta} type="submit" aria-busy={busy} disabled={!enabled || busy || preparing}>{busy ? 'Checking…' : retryLabel}</button>}{busy && <button type="button" className={s.cancel} onClick={cancel}>Cancel check</button>}{signInNeeded && !failure && signInActions}<p className={s.privacy}>{serviceNote}</p>{capabilityError && !signInNeeded && <button type="button" className={s.textButton} onClick={reconnect}>Check connection</button>}</div>
        </form>
      </>}
      {resultPage && (result ? <CheckResultView result={result} mode={submitted?.mode} headingRef={heading} busy={busy} failure={failurePanel}
        onAnswer={answer => void submit(undefined, answer)} onCancel={cancel} onEdit={() => editInput()}
        onCorrectText={correctInput} onRetry={() => void submit(undefined, undefined, true)} onClearerImage={() => editInput('#input-image')}
      /> : <><h1 ref={heading} tabIndex={-1}>No check to show</h1><p className={s.subtitle}>Checks are not saved after a reload.</p><button className={s.cta} onClick={() => go('/')}>Start a check</button></>)}
      {settings && <>
        <h1 ref={heading} tabIndex={-1} className={s.sectionTitle}>Make it comfortable</h1>
        <div className={s.settingCard}><label className={s.settingRow}><span>Larger text</span><input type="checkbox" checked={large} onChange={e => setLarge(e.target.checked)} /></label><label className={s.settingRow}><span>Reduce motion</span><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)} /></label></div>
        <p className={s.smallNote}>Your device’s reduced-motion preference is always respected. These settings reset when you reload.</p>
      </>}
      {help && <HelpPage headingRef={heading} />}
      {!home && !editor && !resultPage && !settings && !help && <><h1 ref={heading} tabIndex={-1}>Page not found</h1><button className={s.cta} onClick={() => go('/')}>Go to Check</button></>}
      <p className={s.status} role="status" aria-live="polite">{busy ? 'Checking your input. You can cancel.' : notice}</p>
    </main>
    <nav className={s.nav} aria-label="Main navigation">
      <Link to="/" onClick={() => { if (busy) cancel(); }} aria-current={!help && !settings ? 'page' : undefined}>
        <span className={s.navIcon}><Icon name="check" /></span><span className={s.navLabel}>Check</span>
      </Link>
      <Link to="/help" onClick={() => { if (busy) cancel(); }} aria-current={help ? 'page' : undefined}>
        <span className={s.navIcon}><Icon name="help" className={s.navHelpIcon} /></span><span className={s.navLabel}>Help</span>
      </Link>
    </nav>
  </div>;
}
