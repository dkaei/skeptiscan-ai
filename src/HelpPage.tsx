import type { ReactNode, Ref } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { OfficialLink, RecoverySteps, ScamShieldContact, SUPPORT_SOURCES } from './SupportContent';
import s from './HelpPage.module.css';

function Guide({ title, children }: { title: string; children: ReactNode }) {
  return <details className={s.guide}><summary><span>{title}</span><Icon name="down" /></summary><div className={s.body}>{children}</div></details>;
}

export default function HelpPage({ headingRef }: { headingRef: Ref<HTMLHeadingElement> }) {
  return <div>
    <h1 ref={headingRef} tabIndex={-1} className={s.title}>Help & guidance</h1>
    <div className={s.contact}><ScamShieldContact /></div>
    <p className={s.emergency}>Urgent police assistance? <a href="tel:999">Call 999</a></p>

    <section className={s.section} aria-labelledby="help-recovery">
      <h2 id="help-recovery">Already acted?</h2>
      <p className={s.intro}>Choose what happened. Take action before another check.</p>
      <div className={s.group}>
        <Guide title="Sent money or banking details">
          <RecoverySteps />
          <p className={s.note}>SkeptiScan cannot freeze an account, stop a transfer or recover money.</p>
        </Guide>
        <Guide title="Shared a password or login code">
          <ol>
            <li><strong>Secure the affected account</strong><p>Open the official service yourself. Change the password and enable two-factor authentication. If you’re locked out, use its account recovery support.</p></li>
            <li><strong>Tell the right people</strong><p>Contact your bank immediately if banking access is involved. If an email or social account was taken over, warn your contacts.</p></li>
          </ol>
          <p className={s.note}>If someone may control your device, use another trusted device.</p>
          <OfficialLink href={SUPPORT_SOURCES.recovery}>Account recovery guidance</OfficialLink>
        </Guide>
        <Guide title="Installed an app or gave remote access">
          <ol>
            <li><strong>Disconnect the affected device</strong><p>If an untrusted app was installed or someone has control, disconnect from the internet. On a phone, turn on flight mode and turn off Wi-Fi.</p></li>
            <li><strong>Use another trusted device</strong><p>Contact your bank and check affected accounts for unauthorised activity. Avoid signing in on the affected device.</p></li>
          </ol>
          <OfficialLink href={SUPPORT_SOURCES.device}>ScamShield device recovery steps</OfficialLink>
        </Guide>
      </div>
    </section>

    <section className={s.section} aria-labelledby="help-checking">
      <h2 id="help-checking">Using SkeptiScan</h2>
      <div className={s.group}>
        <Guide title="Get a useful check">
          <ul className={s.inputTips}>
            <li><img src="/assets/message.svg" alt="" /><div><strong>Message</strong><p>Include the full request and what they want you to do.</p></div></li>
            <li><img src="/assets/call.svg" alt="" /><div><strong>Call</strong><p>Describe who they claimed to be and what they asked for. A number alone is not enough.</p></div></li>
            <li><img src="/assets/link.svg" alt="" /><div><strong>Link</strong><p>Paste the address without opening it. Add where you received it.</p></div></li>
            <li><img src="/assets/screenshot.svg" alt="" /><div><strong>Screenshot</strong><p>Keep the request, sender and link readable. Hide unrelated private details before uploading.</p></div></li>
          </ul>
          <p className={s.note}>Mention whether you started the request or expected the payment. Leave out passwords and login codes.</p>
          <Link className={s.checkLink} to="/">Choose a check</Link>
        </Guide>
        <Guide title="Understand your result">
          <ul className={s.plainList}>
            <li><strong>Your next step</strong><p>A suggested action, not proof that a sender is genuine or a request is safe.</p></li>
            <li><strong>Evidence</strong><p>Shows what was actually checked, when available. “No listed threat found” does not mean safe. An address outside our reference list is not automatically a scam.</p></li>
            <li><strong>Details read from your input</strong><p>Check for reading errors. Use “Review screenshot text” or “Edit input” to correct them.</p></li>
          </ul>
          <p className={s.note}>AI can miss or misread details. A familiar phone number or genuine domain does not verify the person contacting you. No phone-report database is connected.</p>
        </Guide>
        <Guide title="A check didn’t finish">
          <ul className={s.plainList}>
            <li><strong>Unclear screenshot</strong><p>Choose a clearer image, or use “Add text” to include missing details. Corrections are sent alongside the image.</p></li>
            <li><strong>Missing context</strong><p>Answer the follow-up if you know. “Not sure” is always an option.</p></li>
            <li><strong>Connection or service issue</strong><p>Use the recovery button shown. If checking is paused or a limit is reached, wait instead of submitting repeatedly.</p></li>
          </ul>
          <p className={s.note}>Moving around the app keeps your draft. Reloading or closing the tab clears it. An incomplete check is not reassurance.</p>
        </Guide>
        <Guide title="Your privacy">
          <p>Your draft stays in this tab until you submit. AI checks send submitted text and images through Cloudflare to OpenAI.</p>
          <p>The pilot owner has enabled OpenAI input/output sharing. Use non-sensitive test material. Never include passwords, login codes or unnecessary personal details.</p>
          <p>We do not save submitted content or results. We keep per-check usage and diagnostic records, including timestamps and a pseudonymous user identifier. These records are not automatically deleted.</p>
          <p>Providers may retain data under their policies. Drafts and results disappear when you reload or close the tab.</p>
          <p>If offered and selected, a website reputation lookup sends eligible public homepage addresses to Google Web Risk. Links with paths or private details are excluded.</p>
          <p className={s.note}>The home animation is fictional. It does not check your screenshot or show a live verification.</p>
        </Guide>
      </div>
    </section>
    <footer className={s.sources}>
      <OfficialLink href={SUPPORT_SOURCES.helpline}>About the ScamShield helpline</OfficialLink>
    </footer>
  </div>;
}
